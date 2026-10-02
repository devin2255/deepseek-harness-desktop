# Windows 安装程序实施计划

[English](2026-08-24-windows-installer.md) | 中文

> **面向 agent 工作者：** 必须使用子 skill：通过 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐项实施本计划。各步骤使用复选框（`- [ ]`）跟踪。

**目标：** 交付一个自包含的 Windows x64 安装 EXE，使 DeepSeek Harness Desktop 能在干净用户账户上安装、启动、升级和卸载，无需 Node.js、pnpm、源码仓库、网络或管理员权限。

**架构：** 确定性暂存命令把桌面 workspace 及其完整生产依赖闭包部署到 `.artifacts/desktop/stage`，随后 electron-builder 将该闭合目录树与 Electron 打包成引导式 NSIS 安装程序。Electron Main 负责即时显示的本地启动/恢复窗口、位于 `%APPDATA%` 下的应用数据根目录、经认证的就绪探针和现有受监管 Harness 子进程。自定义 NSIS include 负责可选快捷方式、当前用户登录时启动、安装选择保留、安全用户数据删除和升级进程协调。

**技术栈：** TypeScript 6、Node.js 24、Electron 43.4.0、electron-builder 26.15.3、NSIS 3、Vitest 4、Playwright Electron、PowerShell、pnpm 11、GitHub Actions Windows runner。

---

## 计划边界

打包闭包、启动恢复、安装程序行为和已安装应用验证共享同一个发布产物，无法独立验收，因此使用一份计划。每项任务仍以聚焦测试和独立提交结束。应用内自动更新、证书采购、ARM64、MSI 和非 Windows 目标仍不在本计划范围内。

## 源码地图

| 路径 | 职责 |
|---|---|
| `scripts/desktop/stage.ts` | 为桌面 workspace 创建干净的生产部署 |
| `scripts/desktop/packaging-layout.ts` | 定义稳定的暂存、解包、安装程序和校验和路径 |
| `scripts/desktop/validate-package.ts` | 对不完整或依赖构建电脑的打包闭包快速失败 |
| `scripts/desktop/build-installer.ts` | 调用 electron-builder 生成单个 x64 NSIS 产物并写入校验和 |
| `apps/desktop/electron-builder.yml` | 稳定应用身份、文件布局、NSIS 默认值和签名钩子 |
| `apps/desktop/build/installer.nsh` | 用户选项、选择保留、登录时启动、快捷方式和卸载数据页面 |
| `apps/desktop/src/runtime-context.ts` | 解析安装资源、应用数据、Harness 主目录、日志和子进程环境 |
| `apps/desktop/src/startup-state.ts` | 纯启动/恢复状态机和安全的用户错误展示 |
| `apps/desktop/src/startup-window.ts` | 沙箱化即时启动窗口及其窄操作 bridge |
| `apps/desktop/src/readiness-probe.ts` | 经认证的版本与能力就绪检查 |
| `apps/desktop/src/main-lifecycle.ts` | 可重试启动、单实例聚焦、关闭和窗口交接 |
| `apps/desktop/src/uninstall-cleanup.ts` | 产品根目录校验和显式用户数据删除模式 |
| `apps/desktop/tests/installer.e2e.ts` | 干净安装、自定义安装、升级、保留/删除卸载和离线启动 |
| `.github/workflows/desktop-installer.yml` | Windows 构建、e2e 验证、校验和及安装程序产物发布 |

### 任务 1：建立确定性生产暂存

**文件：**

- 新建：`scripts/desktop/packaging-layout.ts`
- 新建：`scripts/desktop/stage.ts`
- 新建：`scripts/desktop/stage.spec.ts`
- 修改：`apps/desktop/package.json`
- 修改：`package.json`
- 修改：`pnpm-lock.yaml`

- [ ] **步骤 1：编写失败的布局与 manifest 测试**

测试所有输出均位于 `.artifacts/desktop` 下，生成的部署 manifest 保留 `main: lib/main.js`、移除开发脚本，并记录源版本且不包含源码仓库绝对路径。

```typescript
it('creates a relocatable desktop deployment manifest', () => {
  const manifest = deploymentManifest(sourceManifest)
  expect(manifest).toMatchObject({ name: '@deepseek-ai/dsh-desktop', main: 'lib/main.js' })
  expect(manifest.scripts).toBeUndefined()
  expect(JSON.stringify(manifest)).not.toContain(repositoryRoot)
})
```

- [ ] **步骤 2：运行聚焦测试并确认失败**

运行：`pnpm vitest run scripts/desktop/stage.spec.ts`

预期：FAIL，因为 `packaging-layout.ts` 和 `stage.ts` 尚不存在。

- [ ] **步骤 3：实现自有输出布局与暂存命令**

从仓库根目录定义所有路径，并拒绝解析到自有产物根目录之外的目标。`stage.ts` 仅删除经校验的暂存目录，执行 `pnpm --filter @deepseek-ai/dsh-desktop deploy --prod --legacy <stage>`，通过 `deploymentManifest()` 重写暂存 manifest，并验证 `lib/main.js`、`lib/preload.cjs`、`node_modules/@deepseek-ai/dsh/lib/bin.js` 和桌面 profile 组合包存在。

```typescript
export const DESKTOP_ARTIFACT_ROOT = resolve(REPOSITORY_ROOT, '.artifacts/desktop')
export const DESKTOP_STAGE = resolve(DESKTOP_ARTIFACT_ROOT, 'stage')
export const DESKTOP_INSTALLER = resolve(DESKTOP_ARTIFACT_ROOT, 'installer')

export function assertOwnedOutput(path: string): void {
  const relative = nodeRelative(DESKTOP_ARTIFACT_ROOT, resolve(path))
  if (relative === '' || relative.startsWith('..') || isAbsolute(relative)) {
    throw new Error(`desktop packaging output escapes ${DESKTOP_ARTIFACT_ROOT}: ${path}`)
  }
}
```

- [ ] **步骤 4：添加打包依赖与脚本**

把精确版本的 `electron-builder` 加入桌面 dev dependency；如果不可变安装识别出相关脚本，则在 `pnpm-workspace.yaml` 中放行经过评审的脚本；并添加以下命令：

```json
{
  "desktop:stage": "tsx scripts/desktop/stage.ts",
  "desktop:package": "tsx scripts/desktop/build-installer.ts",
  "desktop:validate-package": "tsx scripts/desktop/validate-package.ts",
  "test:desktop:installer": "vitest run --config vitest.desktop-installer.config.ts"
}
```

- [ ] **步骤 5：验证暂存并提交**

运行：`pnpm vitest run scripts/desktop/stage.spec.ts && pnpm run build && pnpm run desktop:stage`

预期：PASS，且 `.artifacts/desktop/stage` 仅含普通文件/目录，应用入口解析结果位于暂存目录内。

```sh
git add package.json pnpm-lock.yaml pnpm-workspace.yaml apps/desktop/package.json scripts/desktop
git commit -m "build(desktop): stage a production runtime closure"
```

### 任务 2：隔离已安装运行时路径与开发电脑

**文件：**

- 新建：`apps/desktop/src/runtime-context.ts`
- 新建：`apps/desktop/tests/runtime-context.spec.ts`
- 修改：`apps/desktop/src/harness-supervisor.ts`
- 修改：`apps/desktop/tests/harness-supervisor.spec.ts`
- 修改：`apps/desktop/src/main.ts`

- [ ] **步骤 1：编写失败的生产路径测试**

覆盖打包和开发模式。打包模式必须把 CLI 解析到 `process.resourcesPath` 下，把 `DSH_HOME` 设为 `%APPDATA%\DeepSeek Harness\Harness`，把日志目录设在产品数据根目录下，选择用户拥有的工作目录，并移除继承的 `DSH_HOME`、`NODE_PATH`、`PNPM_HOME` 和仅供仓库启动的变量。

```typescript
expect(resolveRuntimeContext(fakeApp, packagedProcess)).toEqual(expect.objectContaining({
  cliEntry: join(resources, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  harnessHome: join(roaming, 'DeepSeek Harness', 'Harness'),
  logs: join(roaming, 'DeepSeek Harness', 'logs'),
}))
```

- [ ] **步骤 2：运行聚焦测试并确认解析器缺失**

运行：`pnpm --filter @deepseek-ai/dsh-desktop test -- runtime-context harness-supervisor`

预期：FAIL，因为 `resolveRuntimeContext` 不存在。

- [ ] **步骤 3：实现显式运行时上下文**

使用 `app.getPath('appData')`、`app.getPath('home')`、`process.resourcesPath` 和 `app.isPackaged`；不得从 `process.cwd()` 推导安装资源。保留普通环境值，但在设置自有 `DSH_HOME` 前删除指定的开发覆盖值。

```typescript
export interface DesktopRuntimeContext {
  readonly cliEntry: string
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  readonly harnessHome: string
  readonly logs: string
  readonly productData: string
}
```

- [ ] **步骤 4：将路径显式传入 Harness 监管器**

用 `HarnessLaunchSpec { cliEntry, cwd, environment }` 替换生产环境中的 `createRequire(...).resolve()` 和 `process.cwd()` 默认值。在 `utilityProcess.fork()` 前断言 CLI 是普通文件，并把 `DSH_DESKTOP_APP_VERSION` 加入子进程环境但不得记录它。

在创建任一窗口前设置 `app.setAppUserModelId('ai.deepseek.harness.desktop')`，使已安装快捷方式、任务栏分组和通知共享打包身份。

- [ ] **步骤 5：验证并提交**

运行：`pnpm --filter @deepseek-ai/dsh-desktop test -- runtime-context harness-supervisor && pnpm --filter @deepseek-ai/dsh-desktop typecheck`

预期：PASS。

```sh
git add apps/desktop/src apps/desktop/tests
git commit -m "feat(desktop): isolate installed runtime paths"
```

### 任务 3：添加结构化启动状态、日志和安全诊断

**文件：**

- 新建：`apps/desktop/src/startup-state.ts`
- 新建：`apps/desktop/src/desktop-log.ts`
- 新建：`apps/desktop/tests/startup-state.spec.ts`
- 新建：`apps/desktop/tests/desktop-log.spec.ts`
- 修改：`apps/desktop/src/sensitive-text-redactor.ts`

- [ ] **步骤 1：编写失败的状态与遮盖测试**

固定 `waiting-electron -> loading-runtime -> validating-profile -> starting-service -> probing-service -> ready` 转换、从 `failed` 重试以及拒绝陈旧尝试的更新。验证错误展示含稳定错误码和简短操作消息，但不含堆栈、能力、API 密钥、bearer header 或源码仓库绝对路径。

```typescript
expect(reduceStartup(failed, { type: 'retry', attempt: 2 })).toEqual({
  attempt: 2,
  phase: 'loading-runtime',
  status: 'working',
})
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm --filter @deepseek-ai/dsh-desktop test -- startup-state desktop-log`

预期：FAIL，因为状态 reducer 和日志所有者不存在。

- [ ] **步骤 3：实现纯状态模型与轮转日志所有者**

用 `assertNever` 定义带判别字段的 `DesktopStartupState` 与 `DesktopStartupEvent` 联合。`DesktopLog` 创建自有日志目录，为每个生命周期事件追加一行 JSON，在可配置大小下轮转 `desktop.log`，并且只返回当前解析后的日志路径。持久化前用现有敏感文本遮盖器处理每条消息。

- [ ] **步骤 4：验证并提交**

运行：`pnpm --filter @deepseek-ai/dsh-desktop test -- startup-state desktop-log sensitive-text-redactor`

预期：PASS。

```sh
git add apps/desktop/src apps/desktop/tests
git commit -m "feat(desktop): model startup recovery and diagnostics"
```

### 任务 4：显示即时沙箱化启动与恢复窗口

**文件：**

- 新建：`apps/desktop/src/startup-window.ts`
- 新建：`apps/desktop/src/startup-preload.ts`
- 新建：`apps/desktop/src/startup.html`
- 新建：`apps/desktop/tests/startup-window.spec.ts`
- 新建：`apps/desktop/tests/startup-preload.spec.ts`
- 修改：`apps/desktop/src/global.d.ts`
- 修改：`apps/desktop/tsdown.config.ts`

- [ ] **步骤 1：编写失败的窗口隔离测试**

验证窗口使用 `show: true`、本地文件 URL、沙箱和上下文隔离即时创建，禁用 Node 集成，拒绝导航/新窗口，并且冻结 bridge 仅包含 `onState(listener)`、`retry()`、`openLogs()` 和 `exit()`。

- [ ] **步骤 2：运行聚焦测试并确认窗口缺失**

运行：`pnpm --filter @deepseek-ai/dsh-desktop test -- startup-window startup-preload`

预期：FAIL，因为启动窗口入口不存在。

- [ ] **步骤 3：实现本地启动窗口**

在 Harness 启动前创建 `BrowserWindow`。渲染固定本地 HTML/CSS，包含产品名称、阶段标签、不确定进度和错误操作行。渲染器只接收已遮盖的 `DesktopStartupState`；操作 handler 仅向准确的自有 `webContents.id` 注册，并在关闭时 dispose。

```typescript
export interface StartupWindow {
  readonly closed: Promise<void>
  focus(): void
  publish(state: DesktopStartupState): void
  showFailure(state: DesktopStartupFailure): void
  handoffTo(window: DesktopWindow): Promise<void>
}
```

- [ ] **步骤 4：打包专用 preload 并复制 HTML**

把 `startup-preload` 添加为 CommonJS tsdown 入口，并在桌面构建期间把 `startup.html` 复制到 `lib/`。添加测试，在任一打包资源缺失时失败。

- [ ] **步骤 5：验证并提交**

运行：`pnpm --filter @deepseek-ai/dsh-desktop build && pnpm --filter @deepseek-ai/dsh-desktop test -- startup-window startup-preload`

预期：PASS，且存在 `apps/desktop/lib/startup-preload.cjs` 与 `apps/desktop/lib/startup.html`。

```sh
git add apps/desktop
git commit -m "feat(desktop): add native startup recovery surface"
```

### 任务 5：要求经认证的能力就绪探针

**文件：**

- 新建：`apps/desktop/src/readiness-probe.ts`
- 新建：`apps/desktop/tests/readiness-probe.spec.ts`
- 修改：`packages/bundle/desktop-app/src/index.ts`
- 修改：`packages/bundle/desktop-app/tests/desktop-app.spec.ts`
- 修改：`apps/desktop/src/harness-supervisor.ts`

- [ ] **步骤 1：编写失败的探针测试**

覆盖错误状态码、错误 content type、错误版本、缺少必需能力名、超时、中止和有效响应。断言 bearer 能力绝不出现在错误中。

```typescript
await expect(probeDesktopReadiness({
  endpoint,
  capability: 'secret',
  expectedVersion: '0.1.0-rc.7',
  requiredCapabilities: ['host.describe', 'session.list'],
  signal,
})).resolves.toEqual({ version: '0.1.0-rc.7' })
```

- [ ] **步骤 2：运行测试并确认 endpoint 约定缺失**

运行：`pnpm vitest run apps/desktop/tests/readiness-probe.spec.ts packages/bundle/desktop-app/tests/desktop-app.spec.ts`

预期：FAIL，因为桌面就绪路由和探针不存在。

- [ ] **步骤 3：把桌面就绪路由注册为插件 effect**

在 `desktop-app` 中注册一个经认证的精确 GET 路由，返回 `{ product: 'deepseek-harness-desktop', version, capabilities }`。能力必须来自已挂载的权威服务，而不是方法存在性猜测。路由随插件 dispose。

- [ ] **步骤 4：在标准 URL 行之后、渲染器交接之前探测**

保留现有 stdout 就绪行作为 endpoint 发现信号，随后使用相同启动中止 signal 和剩余有界期限调用 `probeDesktopReadiness()`。仅在探针成功后 resolve `startHarness()`。

- [ ] **步骤 5：验证并提交**

运行：`pnpm vitest run apps/desktop/tests/readiness-probe.spec.ts apps/desktop/tests/harness-supervisor.spec.ts packages/bundle/desktop-app/tests/desktop-app.spec.ts`

预期：PASS。

```sh
git add apps/desktop packages/bundle/desktop-app
git commit -m "feat(desktop): authenticate runtime readiness"
```

### 任务 6：集成可重试启动、交接、日志和清理模式

**文件：**

- 新建：`apps/desktop/src/uninstall-cleanup.ts`
- 新建：`apps/desktop/tests/uninstall-cleanup.spec.ts`
- 修改：`apps/desktop/src/main-lifecycle.ts`
- 修改：`apps/desktop/tests/main-lifecycle.spec.ts`
- 修改：`apps/desktop/src/main.ts`

- [ ] **步骤 1：编写失败的生命周期与清理测试**

验证 Electron 就绪后在 Harness 启动前创建启动窗口；启动失败时窗口保持；“重试”在旧子进程结算后只创建一次新尝试；“打开日志”打开自有日志路径；“退出”执行有界清理；成功则原子交接主窗口。验证清理拒绝位于 `%APPDATA%` 外的产品根目录、任一根目录/祖先 reparse point、文件系统根、空路径或不匹配确认 token。

- [ ] **步骤 2：运行聚焦测试并确认旧有失败即退出行为**

运行：`pnpm --filter @deepseek-ai/dsh-desktop test -- main-lifecycle uninstall-cleanup`

预期：FAIL，因为启动失败当前会退出且清理模式不存在。

- [ ] **步骤 3：实现按尝试隔离的重试与交接**

每次尝试拥有独立 `AbortController`、Harness 句柄和单调递增 id。阶段同时发布到启动窗口和日志。陈旧尝试可清理自身子进程，但不能改变当前窗口状态。保留应用单实例锁；第二实例聚焦当前存活的任一自有窗口。

- [ ] **步骤 4：实现显式卸载清理模式**

在正常启动前解析 `--uninstall-delete-user-data=<token>`。校验卸载程序传入的 token，从 `%APPDATA%` 解析产品根目录，对每个已存在祖先和根目录执行 lstat，拒绝 reparse point，并且只在全部检查成功后调用 `rm(productRoot, { recursive: true })`。任何失败都返回非零退出码并保留数据。

- [ ] **步骤 5：验证并提交**

运行：`pnpm --filter @deepseek-ai/dsh-desktop test -- main-lifecycle uninstall-cleanup && pnpm --filter @deepseek-ai/dsh-desktop typecheck`

预期：PASS。

```sh
git add apps/desktop/src apps/desktop/tests
git commit -m "feat(desktop): recover startup and guard uninstall cleanup"
```

### 任务 7：构建引导式当前用户 NSIS 安装程序

**文件：**

- 新建：`apps/desktop/electron-builder.yml`
- 新建：`apps/desktop/build/installer.nsh`
- 新建：`apps/desktop/build/icon.ico`
- 新建：`scripts/desktop/build-installer.ts`
- 新建：`scripts/desktop/build-installer.spec.ts`
- 修改：`apps/desktop/package.json`

- [ ] **步骤 1：编写失败的配置测试**

把 YAML 和 NSIS include 作为数据解析。固定 `appId`、仅 x64 NSIS 目标、`oneClick: false`、`perMachine: false`、`allowElevation: false`、`allowToChangeInstallationDirectory: true`、`runAfterFinish: true`、`allowDowngrade: false`、产物名、稳定 GUID、无 Web 安装程序以及三个已批准选项的默认值。

- [ ] **步骤 2：运行测试并确认配置缺失**

运行：`pnpm vitest run scripts/desktop/build-installer.spec.ts`

预期：FAIL，因为 builder 配置和 include 不存在。

- [ ] **步骤 3：添加 electron-builder 配置**

首个安装程序使用 `asar: false`，使 utility-process CLI 和 loader 资源保持普通文件。通过稳定安装注册表键设置默认当前用户目录，通过 `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` 保留签名自动发现，并在这些变量缺失时允许未签名本地构建。

```yaml
appId: ai.deepseek.harness.desktop
productName: DeepSeek Harness
asar: false
win:
  target:
    - target: nsis
      arch: [x64]
  requestedExecutionLevel: asInvoker
nsis:
  guid: 5e7c4c1c-7429-5bb9-9c22-4e1bf4e2e478
  oneClick: false
  perMachine: false
  allowElevation: false
  allowToChangeInstallationDirectory: true
  allowDowngrade: false
  runAfterFinish: true
  include: build/installer.nsh
  artifactName: DeepSeek-Harness-Setup-${version}-x64.${ext}
```

- [ ] **步骤 4：实现自定义选项与卸载页面**

使用 `nsDialogs` checkbox 提供桌面快捷方式（开）、开始菜单快捷方式（开）和登录时启动（关）。在 HKCU 产品键下保留选择，对 Run 值中的已安装可执行文件进行安全引号处理，并且只创建/移除产品拥有的快捷方式。添加卸载 checkbox“删除以下目录的用户数据：<path>”（关）和二次确认；选中时，在程序文件移除前以不可猜测的一次性 token 调用已安装可执行文件的清理模式。使用 `${isUpdated}` 区分升级和首次安装并保留之前选择。

替换前，使用应用 mutex 和 NSIS 进程 helper 请求并验证关闭；只要仍存在产品拥有的应用进程，就显示“重试”或“取消”。同版本执行进入修复路径；固定的 `allowDowngrade: false` 设置拒绝旧安装程序。保留 electron-builder 的版本化暂存与回滚行为，不得通过自定义 NSIS 代码直接覆盖文件。

- [ ] **步骤 5：构建安装程序并提交**

运行：`pnpm vitest run scripts/desktop/build-installer.spec.ts && pnpm run desktop:package`

预期：PASS，且 `.artifacts/desktop/installer` 下仅存在一个 `DeepSeek-Harness-Setup-0.1.0-rc.7-x64.exe`。

```sh
git add apps/desktop/build apps/desktop/electron-builder.yml apps/desktop/package.json scripts/desktop
git commit -m "build(desktop): add assisted Windows installer"
```

### 任务 8：校验最终打包闭包与发布元数据

**文件：**

- 新建：`scripts/desktop/validate-package.ts`
- 新建：`scripts/desktop/validate-package.spec.ts`
- 新建：`scripts/desktop/checksum.ts`
- 修改：`scripts/desktop/build-installer.ts`
- 修改：`package.json`

- [ ] **步骤 1：编写失败的闭包校验器测试**

fixture 必须拒绝缺失 CLI/profile/Web/原生资源、悬空链接、逃逸打包目录的链接、指向 pnpm store/仓库的目录联接、文本 manifest 内构建绝对路径、错误架构的 `.node`/`.exe` 文件和缺失的必需对等依赖。完整且可迁移 fixture 通过。

- [ ] **步骤 2：运行测试并确认校验器缺失**

运行：`pnpm vitest run scripts/desktop/validate-package.spec.ts`

预期：FAIL，因为校验器不存在。

- [ ] **步骤 3：实现快速失败校验**

使用 `lstat` 遍历，发现期间绝不跟随链接，且放行前检查每个链接目标。从暂存 `package.json` 解析生产 dependency 与 peer dependency 图。解析 PE header 的 x64 machine type，并且只在有大小上限的 UTF-8 配置/manifest 文件中扫描规范化仓库根、用户 profile、pnpm store 和暂存根。

- [ ] **步骤 4：在 NSIS 前校验，在 NSIS 后写 SHA-256**

`build-installer.ts` 必须在创建 NSIS 前校验解包应用，随后验证预期安装程序名称和数量，再写入包含小写 hash 与文件名的 `<installer>.sha256`。存在签名变量时，运行 PowerShell `Get-AuthenticodeSignature` 并要求 `Status -eq 'Valid'`；否则在 `release-metadata.json` 记录 `signed: false`。

- [ ] **步骤 5：验证并提交**

运行：`pnpm vitest run scripts/desktop/validate-package.spec.ts scripts/desktop/build-installer.spec.ts && pnpm run desktop:package && pnpm run desktop:validate-package`

预期：PASS；校验和匹配 EXE，且校验报告不存在外部运行时路径。

```sh
git add scripts/desktop package.json
git commit -m "test(desktop): enforce installer runtime closure"
```

### 任务 9：执行干净安装、升级和两种卸载选择

**文件：**

- 新建：`vitest.desktop-installer.config.ts`
- 新建：`apps/desktop/tests/installer.e2e.ts`
- 新建：`apps/desktop/tests/installer-support.ts`
- 修改：`apps/desktop/tests/desktop.e2e.ts`
- 修改：`package.json`

- [ ] **步骤 1：编写仅限 Windows 的安装程序场景**

以 `DSH_INSTALLER_E2E=1` 和 Windows x64 为门禁。使用唯一临时安装目录及测试拥有的注册表/快捷方式名称。覆盖默认/自定义目标目录、所有选项开/关、从已安装 EXE 启动且环境中移除仓库/Node/pnpm/store 路径、已有 `~/.dsh`、损坏产品 profile、同版本修复、旧版本升级到当前版本、默认保留数据、显式删除数据和拒绝重定向数据目录。

- [ ] **步骤 2：在静默测试开关存在前运行测试套件**

运行：`$env:DSH_INSTALLER_E2E='1'; pnpm run test:desktop:installer`

预期：在第一个不受支持的确定性安装选项处 FAIL。

- [ ] **步骤 3：为 NSIS 添加确定性自动化开关**

支持测试专用 `/DSH_E2E=1`、`/DESKTOPSHORTCUT=0|1`、`/STARTMENUSHORTCUT=0|1`、`/AUTOSTART=0|1`、`/LAUNCH=0|1`、`/DELETEUSERDATA=0|1` 和 NSIS `/D=<absolute directory>`。没有 `/DSH_E2E=1` 时拒绝这些开关；普通交互默认值保持不变。

- [ ] **步骤 4：验证已安装应用与生命周期行为**

使用 Playwright Electron 启动已安装可执行文件，要求启动窗口在五秒内出现，等待主标题和经认证的 host 响应，确认路径位于测试 APPDATA 根目录下，随后干净关闭，并检查文件、HKCU 值、快捷方式、保留会话、删除数据和卸载后的进程不存在。

- [ ] **步骤 5：运行全部桌面验收检查并提交**

运行：`pnpm run test:desktop && pnpm run test:desktop:e2e:ci`

预期：PASS。

运行：`$env:DSH_INSTALLER_E2E='1'; pnpm run test:desktop:installer`

预期：PASS，且没有残留测试拥有的进程、注册表值、快捷方式、安装目录或临时 APPDATA 根目录。

```sh
git add apps/desktop/tests vitest.desktop-installer.config.ts package.json apps/desktop/build/installer.nsh
git commit -m "test(desktop): verify Windows installer lifecycle"
```

### 任务 10：编写文档、记录决策并发布 CI 产物

**文件：**

- 新建：`.github/workflows/desktop-installer.yml`
- 新建：`.agents/notes/implemented/feature/2026-08-24-windows-desktop-installer.md`
- 新建：`.agents/notes/implemented/feature/2026-08-24-windows-desktop-installer.zh.md`
- 新建：`.agents/notes/implemented/feature/2026-08-24-windows-desktop-installer.i18n.yaml`
- 修改：`apps/desktop/README.md`
- 修改：`apps/desktop/README.zh.md`
- 修改：`apps/desktop/README.i18n.yaml`
- 修改：`docs/superpowers/specs/2026-08-24-windows-installer-design.md`
- 修改：`docs/superpowers/specs/2026-08-24-windows-installer-design.zh.md`
- 修改：`docs/superpowers/specs/2026-08-24-windows-installer-design.i18n.yaml`
- 修改：`scripts/run-gates.ts`
- 修改：`scripts/run-gates.spec.ts`

- [ ] **步骤 1：添加 Windows 产物工作流和门禁清单**

在 PR 上构建并校验安装程序，并在原生 Windows lane 上运行一次干净安装/离线启动冒烟测试。在 master 和版本 tag 上运行完整安装程序 e2e 矩阵，上传带保留期的 EXE、SHA-256 和发布元数据，并且绝不把签名秘密暴露给 PR 代码。在 `ci-windows-complete` 中添加具名观察性安装程序门禁，并在 `run-gates.ts` 中显式表达构建依赖。

- [ ] **步骤 2：编写 implemented Agent Note 并更新两侧 README**

记录已交付决策、为何暂存加引导式 NSIS 胜过便携 ZIP/one-click/MSI、数据归属、闭包校验、签名边界和当前排除项。把 README 的“源码仓库执行”限制替换为安装/构建/测试说明和未签名 SmartScreen 警告；继续把自动更新列为排除项。

- [ ] **步骤 3：确认每一双语配对**

运行：

```sh
pnpm run verify-translation-pairing --write apps/desktop/README.md
pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-08-24-windows-desktop-installer.md
pnpm run verify-translation-pairing --write docs/superpowers/specs/2026-08-24-windows-installer-design.md
```

预期：写入三份记录，且每个具名配对一致。

- [ ] **步骤 4：运行最终相关验证**

运行：

```sh
pnpm run test:desktop
pnpm run test:desktop:e2e:ci
$env:DSH_INSTALLER_E2E='1'; pnpm run test:desktop:installer
pnpm run desktop:validate-package
pnpm run typecheck
pnpm run lint
pnpm run hygiene
pnpm run doc-sync
git diff --check
```

预期：所有命令通过。不得用完整仓库单元测试套件或覆盖率门禁代替这些与改动表面匹配的检查。

- [ ] **步骤 5：提交文档与 CI**

```sh
git add .github/workflows/desktop-installer.yml .agents/notes/implemented/feature apps/desktop/README* docs/superpowers/specs/2026-08-24-windows-installer-design* scripts/run-gates.ts scripts/run-gates.spec.ts
git commit -m "ci(desktop): publish verified Windows installer"
```

- [ ] **步骤 6：生成供用户测试的产物**

运行：`pnpm run desktop:package`

预期：生成 `.artifacts/desktop/installer/DeepSeek-Harness-Setup-0.1.0-rc.7-x64.exe`、其 `.sha256` 和 `release-metadata.json`。双击 EXE 会显示引导式安装程序；这就是交给用户验收测试的产物。

## 外部实现参考

- [electron-builder NSIS options](https://www.electron.build/nsis/)
- [electron-builder application contents](https://www.electron.build/docs/contents/)
- [electron-builder Windows code signing](https://www.electron.build/docs/features/code-signing/code-signing-win/)
