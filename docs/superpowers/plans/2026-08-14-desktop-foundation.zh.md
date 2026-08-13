# 桌面基础实施计划

[English](2026-08-14-desktop-foundation.md) | 中文

> **面向 agent 工作者：** 必须使用子 skill：通过 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐项实施本计划。各步骤使用复选框（`- [ ]`）跟踪。

**目标：** 交付一个真实 Electron 应用：它在受监管的 utility process 中启动现有 Harness profile，认证每个 loopback 请求，并在沙箱桌面窗口中渲染当前 DeepSeek Harness 客户端。

**架构：** Electron Main 为每次启动生成一个能力，使用 `utilityProcess` 启动现有 `dsh` profile boot，并等待现有的完全停稳 URL 信号。桌面组合包为现有 Web server 增加请求 guard，隔离的 Electron session 仅向准确的随机 loopback origin 添加能力。Renderer 继续使用现有插件组合的 React 客户端并禁用 Node 集成；preload bridge 只暴露不具备权限的平台元数据。

**技术栈：** TypeScript 6、Node.js 24、Electron 43.4.0、Cordis、React 18、Vitest 4、Playwright Electron、pnpm workspace、tsdown。

---

## 计划系列边界

已批准的产品规格拆为六份可独立测试的计划。本计划只负责桌面基础。后续计划分别负责 Task 投影与注意力队列、本地 worktree 生命周期、Mission Control 客户端插件、审查与 Harness Studio，以及签名分发与更新。本阶段不会用临时的桌面专用数据库或 Electron IPC API 表示任何后续领域。

## 源码地图

| 路径 | 职责 |
|---|---|
| `packages/host/webserver/src/index.ts` | 在 HTTP 路由、fallback 和 WebSocket upgrade 之前注册与传递无关的请求 guard |
| `packages/bundle/desktop-app/` | 桌面 profile patch 和启动能力 guard；不包含窗口行为 |
| `packages/boot/app-boot/src/profile.ts` | 随发行版交付的 `desktop` profile 模板 |
| `apps/desktop/src/readiness.ts` | 解析完全停稳 Harness URL 行的纯函数 |
| `apps/desktop/src/harness-supervisor.ts` | `utilityProcess` 生命周期、就绪状态、stderr 尾部和有界关闭 |
| `apps/desktop/src/authorized-session.ts` | 精确 origin 的能力注入和权限拒绝 |
| `apps/desktop/src/window.ts` | 沙箱 BrowserWindow 与导航策略 |
| `apps/desktop/src/main.ts` | 仅负责单实例应用生命周期与组合 |
| `apps/desktop/src/preload.ts` | 狭窄且冻结的桌面元数据 bridge |
| `apps/desktop/tests/desktop.e2e.ts` | 真实应用、真实 profile、已授权 Renderer 与未授权直接客户端的证明 |

### 任务 1：增加 Web server 请求 guard

**文件：**

- 修改：`packages/host/webserver/src/index.ts`
- 修改：`packages/host/webserver/tests/webserver.spec.ts`
- 修改：`packages/host/webserver/README.md`
- 修改：`packages/host/webserver/README.zh.md`
- 修改：`packages/host/webserver/README.i18n.yaml`

- [ ] **步骤 1：编写失败的 HTTP 与 upgrade guard 测试**

增加一个测试：配置 `requiredGuards: ['desktop-capability']`，确认该 guard 存在前 server 返回 401，然后注册它并确认它在精确路由和 fallback 前运行。增加一个 upgrade 用例，确认必需 guard 缺失或拒绝时，会在 upgrade 所有者运行前销毁 socket。

```typescript
it('runs every request guard before routes, fallback, and upgrades', async () => {
  const seen: string[] = []
  webServer.registerGuard('desktop-capability', (req) => {
    seen.push(req.url ?? '')
    return req.headers.authorization === 'Bearer accepted'
  })
  webServer.register({
    kind: 'exact',
    path: '/ready',
    handler: (_req, res) => { res.end('ready') },
  })

  expect(await request('/ready')).toMatchObject({ status: 401, body: 'unauthorized' })
  expect(await request('/ready', { authorization: 'Bearer accepted' }))
    .toMatchObject({ status: 200, body: 'ready' })
  expect(seen).toEqual(['/ready', '/ready'])
})
```

- [ ] **步骤 2：运行聚焦测试并确认 API 缺失**

运行：`pnpm vitest run packages/host/webserver/tests/webserver.spec.ts`

预期：失败，因为 `WebServer.registerGuard` 不存在。

- [ ] **步骤 3：实现 guard 注册表和快速失败分发**

向 `WebServer.Config` 增加默认为 `[]` 的 `requiredGuards: string[]`，并拒绝重复名称。增加下列导出类型和方法。在解析或分发 HTTP pathname 之前以及选择 upgrade 路由之前调用 `authorized(req)`。从第一个被接受的 socket 开始，尚未注册的必需名称就会快速失败。HTTP 拒绝写入 `401`、`connection: close` 和 `unauthorized`；upgrade 拒绝销毁 socket。guard 抛出的错误由现有逐请求错误路径处理，绝不能授权请求。

```typescript
/** One pre-dispatch authorization decision shared by HTTP and upgrade requests. */
export type WebRequestGuard = (req: IncomingMessage) => boolean

private readonly guards = new Map<string, WebRequestGuard>()

registerGuard(name: string, guard: WebRequestGuard): () => void {
  if (this.guards.has(name)) throw new Error(`webserver: duplicate request guard "${name}"`)
  this.guards.set(name, guard)
  return () => { this.guards.delete(name) }
}

private authorized(req: IncomingMessage): boolean {
  if (this.config.requiredGuards.some(name => !this.guards.has(name))) return false
  for (const guard of this.guards.values()) {
    if (!guard(req)) return false
  }
  return true
}
```

- [ ] **步骤 4：在两个包 README 中记录 guard 约定**

说明多个 guard 以逻辑 AND 组合、在所有路由种类前执行、只返回授权决策并且不能修改路由。说明缺失的 `requiredGuards` 条目会在完整监听生命周期中快速失败，HTTP 以 401 拒绝，upgrade 则通过关闭 socket 拒绝。不要在这里描述桌面能力；该策略属于提供方包。

- [ ] **步骤 5：验证包与双语配对**

运行：`pnpm vitest run packages/host/webserver/tests/webserver.spec.ts`

预期：通过。

运行：`pnpm run verify-translation-pairing --write packages/host/webserver/README.md && pnpm run verify-translation-pairing packages/host/webserver/README.md`

预期：一个具名配对保持一致。

- [ ] **步骤 6：提交传递约定**

```sh
git add packages/host/webserver
git commit -m "feat(webserver): add pre-dispatch request guards"
```

### 任务 2：增加桌面能力组合包

**文件：**

- 创建：`packages/bundle/desktop-app/package.json`
- 创建：`packages/bundle/desktop-app/tsconfig.json`
- 创建：`packages/bundle/desktop-app/cordis.patch.yml`
- 创建：`packages/bundle/desktop-app/src/index.ts`
- 创建：`packages/bundle/desktop-app/src/invariant.ts`
- 创建：`packages/bundle/desktop-app/tests/desktop-app.spec.ts`
- 创建：`packages/bundle/desktop-app/README.md`
- 创建：`packages/bundle/desktop-app/README.zh.md`
- 创建：`packages/bundle/desktop-app/README.i18n.yaml`
- 修改：`tsconfig.host.json`

- [ ] **步骤 1：编写失败的能力测试**

覆盖环境变量缺失或为空、准确 bearer 接受、畸形和重复 Authorization 值、与长度无关的拒绝，以及插件捕获 secret 后删除环境变量。使用假的 `webServer.registerGuard` 和 `IncomingMessage` 形状的请求；绝不打印能力或把它写入快照。

```typescript
it('captures one launch capability and authorizes only its exact bearer value', async () => {
  process.env.DSH_DESKTOP_CAPABILITY = 'launch-secret'
  const { ctx, guard } = await mountedDesktopRuntime()
  expect(process.env.DSH_DESKTOP_CAPABILITY).toBeUndefined()
  expect(guard(request({ authorization: 'Bearer launch-secret' }))).toBe(true)
  expect(guard(request({ authorization: 'Bearer other' }))).toBe(false)
  expect(guard(request({}))).toBe(false)
  await ctx.dispose()
})
```

- [ ] **步骤 2：运行新测试并确认包缺失**

运行：`pnpm vitest run packages/bundle/desktop-app/tests/desktop-app.spec.ts`

预期：失败，因为尚未创建 `@deepseek-ai/dsh-desktop-app`。

- [ ] **步骤 3：创建包骨架**

使用根版本、已发布包的 repository 元数据、ESM 包字段、标准 Host 包 exports/files，并在 peerDependencies 和 devDependencies 中同时加入 `@deepseek-ai/cordis`。把 `@deepseek-ai/dsh-host-webserver` 和 `@deepseek-ai/dsh-invariants` 保持为 peer dependency 并镜像到 dev dependency；在 `dsh.bundle.patch` 中声明组合包 patch。把项目引用加入 `tsconfig.host.json`。根 tsdown workspace 已经构建 `packages/*/*`，因此该包不增加包本地 tsdown 配置。

```json
{
  "name": "@deepseek-ai/dsh-desktop-app",
  "description": "Desktop profile overlay and per-launch loopback authorization",
  "version": "0.1.0-rc.5",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/bundle/desktop-app"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./invariant": { "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/invariant.js", "cordis.patch.yml", "lib/types/**/*.d.ts"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-host-webserver": "workspace:^",
    "@deepseek-ai/dsh-invariants": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-host-webserver": "workspace:^",
    "@deepseek-ai/dsh-invariants": "workspace:^"
  },
  "license": "MIT"
}
```

创建引用 Cordis、webserver 与 invariants 的 `tsconfig.json`，并创建不注册运行时断言的 invariant companion，因为必需 guard 的关系已经在 `WebServer` 内快速失败，并由真实请求测试覆盖。

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
  "include": ["src"],
  "references": [
    { "path": "../../../vendor/cordis" },
    { "path": "../../host/webserver" },
    { "path": "../../runtime-diagnostics/invariants" }
  ]
}
```

- [ ] **步骤 4：实现启动能力 guard**

在 apply 期间读取一次 `DSH_DESKTOP_CAPABILITY`，缺失或为空时拒绝启动，从 `process.env` 删除它，仅在长度相同后使用 `timingSafeEqual` 比较 UTF-8 buffer。只接受形如 `Bearer <base64url capability>` 的单个字符串 Authorization header。把生成的判断函数注册为 `desktop-capability`。

```typescript
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'desktop-app'
export const inject = ['webServer']
export const CAPABILITY_ENV = 'DSH_DESKTOP_CAPABILITY'

function matchesBearer(req: IncomingMessage, capability: Buffer): boolean {
  const raw = req.headers.authorization
  if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return false
  const supplied = Buffer.from(raw.slice('Bearer '.length), 'utf8')
  return supplied.length === capability.length && timingSafeEqual(supplied, capability)
}

export function apply(ctx: Context): void {
  const raw = process.env[CAPABILITY_ENV]
  delete process.env[CAPABILITY_ENV]
  if (raw === undefined || raw.length === 0) {
    throw new Error(`desktop-app: ${CAPABILITY_ENV} must contain a per-launch capability`)
  }
  const capability = Buffer.from(raw, 'utf8')
  ctx.effect(
    () => ctx.webServer.registerGuard('desktop-capability', req => matchesBearer(req, capability)),
    'desktop-app: loopback capability guard',
  )
}
```

- [ ] **步骤 5：增加桌面覆盖层**

patch 完整替换 `webserver` 配置，以保留 invocation host/port 解析，并从第一个被接受的 socket 开始要求 `desktop-capability`。它完整替换 `web-runtime` 配置，以保留完全停稳 URL 行、抑制错误的 Web GUI 模型上下文，并保留空的 trusted-host 列表。插入的提供方注册必需 guard；Loader 完全停稳前不会输出 URL 就绪行，因此注册完成前不会发出该信号。Electron 启动器提供 `--port 0`；patch 不硬编码端口。

```yaml
- id: webserver
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
    requiredGuards: [desktop-capability]

- id: web-runtime
  config:
    printUrl: true
    surfaceContext: false
    trustedHosts: []

- insert:
    - id: desktop-app
      name: '@deepseek-ai/dsh-desktop-app'
```

- [ ] **步骤 6：编写包约定并验证**

记录环境捕获、header 形状、删除时机、失败行为和不存在模型上下文影响。限制章节说明安装器签名与任务感知的后台生命周期属于后续计划。

运行：`pnpm vitest run packages/bundle/desktop-app/tests/desktop-app.spec.ts`

预期：通过。

运行：`pnpm run verify-translation-pairing --write packages/bundle/desktop-app/README.md && pnpm run constraints && pnpm run typecheck`

预期：所有命令以 0 退出。

- [ ] **步骤 7：提交能力提供方**

```sh
git add packages/bundle/desktop-app tsconfig.host.json
git commit -m "feat(desktop): add launch capability bundle"
```

### 任务 3：注册随发行版交付的桌面 profile

**文件：**

- 修改：`packages/boot/app-boot/src/profile.ts`
- 修改：`packages/boot/app-boot/tests/profile.spec.ts`
- 修改：`packages/boot/app-boot/README.md`
- 修改：`packages/boot/app-boot/README.zh.md`
- 修改：`packages/boot/app-boot/README.i18n.yaml`
- 修改：`apps/cli/package.json`
- 修改：`apps/cli/reference/README.md`
- 修改：`apps/cli/reference/README.zh.md`
- 修改：`apps/cli/reference/README.i18n.yaml`

- [ ] **步骤 1：扩展 profile 模板测试**

断言准确的组合包顺序，因为后续覆盖层依赖桌面授权挂载前已经存在 Web 路由。

```typescript
expect(PROFILE_TEMPLATES.desktop).toEqual([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-desktop-app',
])
```

- [ ] **步骤 2：运行 profile suite 并观察模板缺失**

运行：`pnpm vitest run packages/boot/app-boot/tests/profile.spec.ts`

预期：失败，因为 `PROFILE_TEMPLATES.desktop` 为 undefined。

- [ ] **步骤 3：增加模板与安装依赖**

把上述 tuple 加入 `PROFILE_TEMPLATES`。把 `@deepseek-ai/dsh-desktop-app: workspace:^` 加入 `apps/cli/package.json` dependencies，使以安装为锚点的组合包解析和修复后的 profile fallback 能解析覆盖层。

- [ ] **步骤 4：更新两种语言的 profile 参考**

在 `web` 和 `headless` 旁增加 `desktop`，写明准确的三组合包结构，以及该 profile 用于受监管的 Electron 启动、而不是用户直接调用这一不变量。

- [ ] **步骤 5：验证 profile 初始化与配对**

运行：`pnpm install && pnpm vitest run packages/boot/app-boot/tests/profile.spec.ts apps/cli/tests/windows-shell.spec.ts`

预期：通过，并且 lockfile 以 workspace 依赖记录该包，没有外部版本。

对两个变更的 README 配对分别运行 `--write`，随后运行它们的具名配对检查。

- [ ] **步骤 6：提交 profile**

```sh
git add package.json pnpm-lock.yaml packages/boot/app-boot apps/cli/package.json apps/cli/reference
git commit -m "feat(desktop): register the desktop profile"
```

### 任务 4：创建 Electron 应用和就绪解析器

**文件：**

- 创建：`apps/desktop/package.json`
- 创建：`apps/desktop/tsconfig.json`
- 创建：`apps/desktop/tsdown.config.ts`
- 创建：`apps/desktop/src/readiness.ts`
- 创建：`apps/desktop/tests/readiness.spec.ts`
- 修改：`package.json`
- 修改：`pnpm-workspace.yaml`
- 修改：`tsconfig.host.json`
- 修改：`tsdown.config.ts`
- 修改：`scripts/check-workspace-constraints.ts`

- [ ] **步骤 1：编写就绪解析器测试**

解析器接受分片边界、忽略无关输出、只发出一次结果，只接受带有效端口的 `127.0.0.1`，绝不把 LAN URL 或尾随文本视为规范 endpoint。

```typescript
it('emits one canonical settled endpoint across stdout chunks', () => {
  const parser = createReadinessParser()
  expect(parser.push('booting\ndsh web: http://127.0.0.1:')).toBeUndefined()
  expect(parser.push('49152\n')).toEqual(new URL('http://127.0.0.1:49152'))
  expect(parser.push('dsh web: http://127.0.0.1:4000\n')).toBeUndefined()
})
```

- [ ] **步骤 2：运行测试并确认解析器缺失**

运行：`pnpm vitest run apps/desktop/tests/readiness.spec.ts`

预期：失败，因为 `createReadinessParser` 不存在。

- [ ] **步骤 3：实现有界解析器**

最多保留 8 KiB 未完成行，只按换行符拆分，匹配 `^dsh web: (http://127\.0\.0\.1:(\d+))(?: .*)?$`，要求端口为 1–65535，并在第一个结果后锁存。只导出 `createReadinessParser` 及其返回接口。

- [ ] **步骤 4：创建桌面 workspace 包**

准确使用 Electron 43.4.0。在 `pnpm-workspace.yaml` 的 `allowBuilds` 中加入 `electron: true`，增加根脚本 `dev:desktop` 和 `test:desktop`，把 `apps/desktop` 加入 Host TypeScript 聚合与根 tsdown workspace，构建两个入口且不构建 Harness 副本：ESM `main.js` 和打包的 CommonJS `preload.cjs`，因为沙箱 Electron preload 不支持 ESM。用 `@deepseek-ai/dsh-desktop: ['lib/*.js', 'lib/*.cjs']` 扩展 `appPackageFiles`；不要弱化 release-member 规则。

```json
{
  "name": "@deepseek-ai/dsh-desktop",
  "version": "0.1.0-rc.5",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "apps/desktop"
  },
  "type": "module",
  "main": "lib/main.js",
  "files": ["lib/*.js", "lib/*.cjs"],
  "scripts": {
    "build": "tsc -b && tsdown",
    "start": "electron .",
    "test": "vitest run tests"
  },
  "dependencies": {
    "@deepseek-ai/dsh": "workspace:^"
  },
  "devDependencies": {
    "electron": "43.4.0",
    "playwright": "^1.49.0",
    "typescript": "^6.0.3",
    "tsdown": "^0.22.2",
    "vitest": "^4.1.8"
  }
}
```

使用下列 TypeScript 项目和包自有 tsdown 配置。Electron 保持 external，因为运行时由 Electron 可执行文件提供它。

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib/types" },
  "include": ["src"],
  "references": []
}
```

```typescript
import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['lib/types/main.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    external: ['electron'],
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/preload.js'],
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    external: ['electron'],
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
```

- [ ] **步骤 5：验证包约束、类型检查与解析器行为**

运行：`pnpm install && pnpm vitest run apps/desktop/tests/readiness.spec.ts && pnpm run constraints && pnpm run typecheck`

预期：所有命令以 0 退出。

- [ ] **步骤 6：提交应用骨架**

```sh
git add apps/desktop package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.host.json tsdown.config.ts scripts/check-workspace-constraints.ts
git commit -m "feat(desktop): scaffold the Electron application"
```

### 任务 5：监管 Harness utility process

**文件：**

- 创建：`apps/desktop/src/harness-supervisor.ts`
- 创建：`apps/desktop/tests/harness-supervisor.spec.ts`

- [ ] **步骤 1：针对假的 utility process 编写生命周期测试**

覆盖 fork 参数、32 字节 base64url 能力、不改变继承的环境、`--profile desktop --port 0`、就绪解析、就绪前退出并携带有界 stderr 尾部、一次幂等 `kill()`，以及对 exit 事件的有界等待。

```typescript
expect(fork).toHaveBeenCalledWith(cliEntry, ['--profile', 'desktop', '--port', '0'], expect.objectContaining({
  env: expect.objectContaining({ DSH_DESKTOP_CAPABILITY: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }),
  stdio: 'pipe',
  serviceName: 'DeepSeek Harness Runtime',
}))
```

- [ ] **步骤 2：运行聚焦 suite 并确认 supervisor 缺失**

运行：`pnpm vitest run apps/desktop/tests/harness-supervisor.spec.ts`

预期：失败，因为 `startHarness` 不存在。

- [ ] **步骤 3：实现依赖注入的监管**

使用 `createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js')` 解析已安装 CLI。在 Main 中生成能力，只在 `app.whenReady()` 后 fork，pipe stdout/stderr，并返回 `{ endpoint, capability, stop }`。`stop()` 只调用一次 `kill()` 并等待 `exit` 最多五秒；缺少 exit 时以具名关闭超时错误拒绝。它不使用 `process.kill(pid)` 或平台 shell。

```typescript
export interface HarnessHandle {
  endpoint: URL
  capability: string
  stop(): Promise<void>
}

export async function startHarness(deps: HarnessSupervisorDeps): Promise<HarnessHandle> {
  const capability = deps.randomBytes(32).toString('base64url')
  const child = deps.fork(deps.cliEntry, ['--profile', 'desktop', '--port', '0'], {
    cwd: deps.cwd,
    env: { ...process.env, DSH_DESKTOP_CAPABILITY: capability },
    stdio: 'pipe',
    serviceName: 'DeepSeek Harness Runtime',
  })
  const endpoint = await waitForReadiness(child, createReadinessParser())
  return createHandle(child, endpoint, capability, deps.shutdownTimeoutMs)
}
```

- [ ] **步骤 4：验证生命周期行为**

运行：`pnpm vitest run apps/desktop/tests/harness-supervisor.spec.ts`

预期：通过，任何快照或控制台输出都不包含能力值。

- [ ] **步骤 5：提交进程监管**

```sh
git add apps/desktop/src/harness-supervisor.ts apps/desktop/tests/harness-supervisor.spec.ts
git commit -m "feat(desktop): supervise the Harness runtime"
```

### 任务 6：创建已授权 session 与沙箱窗口

**文件：**

- 创建：`apps/desktop/src/authorized-session.ts`
- 创建：`apps/desktop/src/window.ts`
- 创建：`apps/desktop/src/preload.ts`
- 创建：`apps/desktop/src/global.d.ts`
- 创建：`apps/desktop/tests/authorized-session.spec.ts`
- 创建：`apps/desktop/tests/window.spec.ts`

- [ ] **步骤 1：编写请求范围和窗口策略测试**

确认只为精确 origin 的 `http`、`ws`、fetch、script、image 和 main-frame 请求增加 Authorization。确认绝不向其他端口、其他 hostname、HTTPS 或外部导航添加它。断言 permission check/request handler 默认拒绝。断言 BrowserWindow 选项设置 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true` 和内存 partition。

```typescript
expect(windowOptions.webPreferences).toMatchObject({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  partition: 'dsh-desktop',
})
```

- [ ] **步骤 2：运行聚焦测试并确认两个模块缺失**

运行：`pnpm vitest run apps/desktop/tests/authorized-session.spec.ts apps/desktop/tests/window.spec.ts`

预期：失败，因为 session 和 window factory 不存在。

- [ ] **步骤 3：实现精确 origin header 注入**

使用 `session.fromPartition('dsh-desktop', { cache: true })`。注册一个 `onBeforeSendHeaders` listener，覆盖精确的 `http://127.0.0.1:<port>/*` 和 `ws://127.0.0.1:<port>/*` pattern；保留所有 header，并设置 `Authorization: Bearer <capability>`。主窗口存在后，callback 取消任何 `webContentsId` 不属于主窗口的匹配请求。安装默认全部拒绝的 permission check 与 request handler。

- [ ] **步骤 4：实现安全 BrowserWindow**

只加载完全停稳的 endpoint。让 BrowserWindow 指向绝对路径的已打包 `lib/preload.cjs`。当下一个 URL origin 不同，拒绝 `will-navigate`；拒绝每个 `window.open`；本阶段不打开任何外部 URL。在 `loadURL` 之前挂载请求 listener。设置最小尺寸 960×640，暂不持久化窗口状态。

- [ ] **步骤 5：增加狭窄 preload bridge**

暴露一个冻结值，不暴露 IPC sender、文件系统、shell、环境、process 或能力。

```typescript
contextBridge.exposeInMainWorld('deepseekDesktop', Object.freeze({
  platform: process.platform,
}))
```

- [ ] **步骤 6：验证安全单元测试 suite**

运行：`pnpm vitest run apps/desktop/tests/authorized-session.spec.ts apps/desktop/tests/window.spec.ts`

预期：通过。

- [ ] **步骤 7：提交安全窗口**

```sh
git add apps/desktop/src apps/desktop/tests
git commit -m "feat(desktop): add the authorized sandboxed window"
```

### 任务 7：组装应用生命周期并证明垂直切片

**文件：**

- 创建：`apps/desktop/src/main.ts`
- 创建：`apps/desktop/tests/desktop.e2e.ts`
- 创建：`apps/desktop/README.md`
- 创建：`apps/desktop/README.zh.md`
- 创建：`apps/desktop/README.i18n.yaml`

- [ ] **步骤 1：让 Main 只承担组合职责**

在 ready 前调用 `app.enableSandbox()`。获取单实例锁；在 `app.whenReady()` 后启动 Harness、准备已授权 session、创建窗口并加载 endpoint。收到 `second-instance` 时恢复并聚焦现有窗口。`before-quit` 期间，第一次退出先被阻止，等待一次 Harness stop，出现关闭超时时进行报告，然后在 `finally` latch 下再次退出。在 Windows 和 Linux 上，本基础阶段关闭唯一窗口即退出；macOS 在 activate 时重建窗口，而 Harness 保持存活。任务感知的托盘行为属于 Task 生命周期计划。

```typescript
app.enableSandbox()
if (!app.requestSingleInstanceLock()) app.quit()
else void app.whenReady().then(startDesktop).catch(reportFatalStartup)
```

- [ ] **步骤 2：编写真正的 Electron 验收测试**

构建所需产物，通过 Playwright 启动 Electron，等待一个窗口，并断言现有客户端标题与根渲染。从页面读取运行时 origin，用 Node `fetch` 在没有 header 时调用 `/api/host.describe` 并要求 401。通过 `page.evaluate(fetch)` 调用相同 endpoint 并要求非 401 响应，以证明是 session 范围注入，而不是禁用了 guard。断言不存在 `window.process`、`window.require` 和能力。

```typescript
expect(await page.title()).toBe('DeepSeek Harness')
expect(await page.evaluate(() => ({
  process: 'process' in window,
  require: 'require' in window,
  bridge: window.deepseekDesktop,
}))).toEqual({ process: false, require: false, bridge: { platform: process.platform } })
```

- [ ] **步骤 3：运行验收测试并捕获第一次失败**

运行：`pnpm --filter @deepseek-ai/dsh-desktop build && pnpm playwright test apps/desktop/tests/desktop.e2e.ts`

生命周期尚未接线时的预期：失败，因为没有应用窗口进入就绪状态。

- [ ] **步骤 4：增加 Vitest 清单和桌面 README 配对**

现有 `apps/*/tests/**/*.spec.ts` 清单已经覆盖新的单元测试，无需修改 Vitest 配置。记录开发启动、进程所有权、安全不变量、失败行为和本基础切片的准确边界。不要声称已有安装器、更新、托盘驻留或 Mission Control UI。

- [ ] **步骤 5：运行完整基础验证**

运行：`pnpm --filter @deepseek-ai/dsh-desktop build`

预期：Electron Main 生成为 `lib/main.js`，沙箱兼容的 preload 生成为 `lib/preload.cjs`，两种 bundle 都不包含 Electron。

运行：`pnpm playwright test apps/desktop/tests/desktop.e2e.ts`

预期：通过；未授权直接访问为 401，沙箱 Renderer 可用。

运行：`pnpm run test:gui && pnpm run typecheck && pnpm run lint`

预期：所有命令以 0 退出。

- [ ] **步骤 6：提交可运行垂直切片**

```sh
git add apps/desktop
git commit -m "feat(desktop): boot the secured desktop application"
```

### 任务 8：完成文档与仓库门禁

**文件：**

- 修改：`.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.md`
- 修改：`.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.zh.md`
- 修改：`.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.i18n.yaml`

- [ ] **步骤 1：只记录已交付的基础事实**

保持 Note 为 `proposed`，因为 Mission Control 尚未完成。把基础段落中的未来时态替换为准确交付的进程、授权与 Renderer 行为，并说明 Task 投影、worktree、任务感知托盘生命周期、审查、Studio、签名和更新仍未实现。不要增加测试清单或重复包 README。

- [ ] **步骤 2：重新记录所有变更的双语配对**

分别为 webserver README、desktop-app README、app-boot README、CLI reference、desktop README 和桌面 mission-control Agent Note 运行 `pnpm run verify-translation-pairing --write`。

预期：每个具名检查都报告一个一致配对。

- [ ] **步骤 3：运行仓库文档与产品门禁**

运行：`pnpm run doc-sync`

预期：每项文档门禁都通过，包括包路径、Mermaid、Agent Note 格式和双语配对。

运行：`pnpm run constraints && pnpm run typecheck && pnpm run lint && pnpm run build`

预期：所有命令以 0 退出。

运行：`git diff --check && git status --short`

预期：没有空白错误；状态只列出预期基础变更。

- [ ] **步骤 4：完整构建后再次运行桌面验收测试**

运行：`pnpm playwright test apps/desktop/tests/desktop.e2e.ts`

预期：针对刚构建的产物通过。

- [ ] **步骤 5：提交已验证的文档状态**

```sh
git add .agents/notes apps/desktop packages/host/webserver packages/bundle/desktop-app packages/boot/app-boot apps/cli/reference
git commit -m "docs: record the desktop foundation contracts"
```

## 完成检查点

只有当全新 checkout 能构建并打开 Electron 应用、现有 Harness 客户端通过随机 loopback 端口连接、直接的未认证 HTTP 与 WebSocket 访问被拒绝、Renderer 中没有 Node 全局变量、关闭应用会结算受监管 Harness 进程时，本计划才算完成。随后产品工作进入 Task 投影与统一注意力队列计划；不会把功能 UI 直接加入 Electron Main 或 preload。
