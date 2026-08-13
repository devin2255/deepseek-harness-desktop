# Desktop Foundation Implementation Plan

English | [中文](2026-08-14-desktop-foundation.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a real Electron application that starts the existing Harness profile in a supervised utility process, authenticates every loopback request, and renders the current DeepSeek Harness client in a sandboxed desktop window.

**Architecture:** Electron Main generates one launch capability, starts the existing `dsh` profile boot through `utilityProcess`, and waits for the existing settled URL signal. A desktop bundle adds a request guard to the existing Web server, while an isolated Electron session adds the capability only to the exact random loopback origin. The Renderer remains the existing plugin-composed React client with Node integration disabled; the preload bridge exposes only non-authoritative platform metadata.

**Tech Stack:** TypeScript 6, Node.js 24, Electron 43.4.0, Cordis, React 18, Vitest 4, Playwright Electron, pnpm workspace, tsdown.

---

## Plan-series boundary

The approved product specification is split into six independently testable plans. This plan owns the desktop foundation. Later plans own the Task projection and attention queue, local worktree lifecycle, Mission Control client plugins, review and Harness Studio, and signed distribution with updates. No later domain is represented by a temporary desktop-only database or Electron IPC API in this slice.

## Source map

| Path | Responsibility |
|---|---|
| `packages/host/webserver/src/index.ts` | Transport-neutral request-guard registration before HTTP routes, fallbacks, and WebSocket upgrades |
| `packages/bundle/desktop-app/` | Desktop profile patch and launch-capability guard; no window behavior |
| `packages/boot/app-boot/src/profile.ts` | Shipped `desktop` profile template |
| `apps/desktop/src/readiness.ts` | Pure parser for the settled Harness URL line |
| `apps/desktop/src/harness-supervisor.ts` | `utilityProcess` lifecycle, readiness, stderr tail, and bounded shutdown |
| `apps/desktop/src/authorized-session.ts` | Exact-origin capability injection and permission denial |
| `apps/desktop/src/window.ts` | Sandboxed BrowserWindow and navigation policy |
| `apps/desktop/src/main.ts` | Single-instance application lifecycle and composition only |
| `apps/desktop/src/preload.ts` | Narrow frozen desktop metadata bridge |
| `apps/desktop/tests/desktop.e2e.ts` | Real app, real profile, authorized Renderer, and unauthorized direct-client proof |

### Task 1: Add the Web-server request guard

**Files:**

- Modify: `packages/host/webserver/src/index.ts`
- Modify: `packages/host/webserver/tests/webserver.spec.ts`
- Modify: `packages/host/webserver/README.md`
- Modify: `packages/host/webserver/README.zh.md`
- Modify: `packages/host/webserver/README.i18n.yaml`

- [ ] **Step 1: Write failing HTTP and upgrade guard tests**

Add a test that configures `requiredGuards: ['desktop-capability']`, confirms the server returns 401 before that guard exists, then registers it and confirms it runs before an exact route and the fallback. Add an upgrade case that confirms a missing or rejecting required guard destroys the socket before the upgrade owner runs.

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

- [ ] **Step 2: Run the focused test and verify the missing API**

Run: `pnpm vitest run packages/host/webserver/tests/webserver.spec.ts`

Expected: FAIL because `WebServer.registerGuard` does not exist.

- [ ] **Step 3: Implement the guard registry and fail-closed dispatch**

Add `requiredGuards: string[]` to `WebServer.Config`, defaulting to `[]` with duplicate names rejected. Add the exported type and methods below. Call `authorized(req)` before parsing or dispatching an HTTP pathname and before selecting an upgrade route. A required name that has not registered fails closed from the first accepted socket. HTTP rejection writes `401`, `connection: close`, and `unauthorized`; upgrade rejection destroys the socket. A thrown guard error is handled by the existing per-request error path and never authorizes the request.

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

- [ ] **Step 4: Document the guard contract in both package READMEs**

State that guards compose with logical AND, execute before all route kinds, return only an authorization decision, and cannot mutate routing. State that a missing `requiredGuards` entry fails closed for the complete listening lifetime, HTTP rejects with 401, and upgrade rejects by closing the socket. Do not describe the desktop capability here; the provider package owns that policy.

- [ ] **Step 5: Verify the package and bilingual pair**

Run: `pnpm vitest run packages/host/webserver/tests/webserver.spec.ts`

Expected: PASS.

Run: `pnpm run verify-translation-pairing --write packages/host/webserver/README.md && pnpm run verify-translation-pairing packages/host/webserver/README.md`

Expected: one named pair is consistent.

- [ ] **Step 6: Commit the transport contract**

```sh
git add packages/host/webserver
git commit -m "feat(webserver): add pre-dispatch request guards"
```

### Task 2: Add the desktop capability bundle

**Files:**

- Create: `packages/bundle/desktop-app/package.json`
- Create: `packages/bundle/desktop-app/tsconfig.json`
- Create: `packages/bundle/desktop-app/cordis.patch.yml`
- Create: `packages/bundle/desktop-app/src/index.ts`
- Create: `packages/bundle/desktop-app/src/invariant.ts`
- Create: `packages/bundle/desktop-app/tests/desktop-app.spec.ts`
- Create: `packages/bundle/desktop-app/README.md`
- Create: `packages/bundle/desktop-app/README.zh.md`
- Create: `packages/bundle/desktop-app/README.i18n.yaml`
- Modify: `tsconfig.host.json`

- [ ] **Step 1: Write the failing capability tests**

Cover missing/empty environment values, exact bearer acceptance, malformed and duplicate Authorization values, constant-length-independent rejection, and environment removal after the plugin captures the secret. Use a fake `webServer.registerGuard` and an `IncomingMessage`-shaped request; never print or snapshot the capability.

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

- [ ] **Step 2: Run the new test and verify the package is absent**

Run: `pnpm vitest run packages/bundle/desktop-app/tests/desktop-app.spec.ts`

Expected: FAIL because `@deepseek-ai/dsh-desktop-app` has not been created.

- [ ] **Step 3: Create the package skeleton**

Use the root version, published-package repository metadata, ESM package fields, the standard host-package exports/files, and `@deepseek-ai/cordis` in both peer and dev dependencies. Keep `@deepseek-ai/dsh-host-webserver` and `@deepseek-ai/dsh-invariants` as peer dependencies mirrored in dev dependencies; declare the bundle patch in `dsh.bundle.patch`. Add the project reference to `tsconfig.host.json`. The root tsdown workspace already builds `packages/*/*`, so this package does not add a package-local tsdown config.

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

Create `tsconfig.json` with references to Cordis, webserver, and invariants, and create an invariant companion that registers no runtime assertion because the required-guard relation is already fail-closed inside `WebServer` and covered by real request tests.

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

- [ ] **Step 4: Implement the launch-capability guard**

Read `DSH_DESKTOP_CAPABILITY` once during apply, reject startup when it is absent or empty, delete it from `process.env`, and compare UTF-8 buffers with `timingSafeEqual` only after equal-length confirmation. Accept exactly one string Authorization header in the form `Bearer <base64url capability>`. Register the resulting predicate as `desktop-capability`.

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

- [ ] **Step 5: Add the desktop overlay**

The patch replaces `webserver` config completely to preserve invocation host/port resolution and require `desktop-capability` from the first accepted socket. It replaces `web-runtime` config completely to keep the settled URL line, suppress false Web-GUI model context, and retain an empty trusted-host list. The inserted provider registers the required guard; Loader settlement prevents the URL readiness line until registration completes. The Electron launcher supplies `--port 0`; the patch does not hard-code a port.

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

- [ ] **Step 6: Write the package contract and verify**

Document the environment capture, header shape, deletion timing, failure behavior, and absence of model-context effects. The limitations section names that installer signing and task-aware background lifecycle belong to later plans.

Run: `pnpm vitest run packages/bundle/desktop-app/tests/desktop-app.spec.ts`

Expected: PASS.

Run: `pnpm run verify-translation-pairing --write packages/bundle/desktop-app/README.md && pnpm run constraints && pnpm run typecheck`

Expected: all commands exit 0.

- [ ] **Step 7: Commit the capability provider**

```sh
git add packages/bundle/desktop-app tsconfig.host.json
git commit -m "feat(desktop): add launch capability bundle"
```

### Task 3: Register the shipped desktop profile

**Files:**

- Modify: `packages/boot/app-boot/src/profile.ts`
- Modify: `packages/boot/app-boot/tests/profile.spec.ts`
- Modify: `packages/boot/app-boot/README.md`
- Modify: `packages/boot/app-boot/README.zh.md`
- Modify: `packages/boot/app-boot/README.i18n.yaml`
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/reference/README.md`
- Modify: `apps/cli/reference/README.zh.md`
- Modify: `apps/cli/reference/README.i18n.yaml`

- [ ] **Step 1: Extend the profile-template test**

Assert the exact bundle order because later overlays depend on Web routes existing before desktop authorization mounts.

```typescript
expect(PROFILE_TEMPLATES.desktop).toEqual([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-desktop-app',
])
```

- [ ] **Step 2: Run the profile suite and see the absent template**

Run: `pnpm vitest run packages/boot/app-boot/tests/profile.spec.ts`

Expected: FAIL because `PROFILE_TEMPLATES.desktop` is undefined.

- [ ] **Step 3: Add the template and installation dependency**

Add the tuple above to `PROFILE_TEMPLATES`. Add `@deepseek-ai/dsh-desktop-app: workspace:^` to `apps/cli/package.json` dependencies so installation-anchored bundle resolution and the healed profile fallback can resolve the overlay.

- [ ] **Step 4: Update both profile references**

Add `desktop` beside `web` and `headless`, with the exact three-bundle composition and the invariant that the profile is for supervised Electron startup, not direct user invocation.

- [ ] **Step 5: Verify profile initialization and pairing**

Run: `pnpm install && pnpm vitest run packages/boot/app-boot/tests/profile.spec.ts apps/cli/tests/windows-shell.spec.ts`

Expected: PASS, and the lockfile includes the workspace dependency without an external version.

Run the `--write` pairing command for both changed README pairs, then run their scoped pairing checks.

- [ ] **Step 6: Commit the profile**

```sh
git add package.json pnpm-lock.yaml packages/boot/app-boot apps/cli/package.json apps/cli/reference
git commit -m "feat(desktop): register the desktop profile"
```

### Task 4: Create the Electron application and readiness parser

**Files:**

- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/tsdown.config.ts`
- Create: `apps/desktop/src/readiness.ts`
- Create: `apps/desktop/tests/readiness.spec.ts`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `tsconfig.host.json`
- Modify: `tsdown.config.ts`
- Modify: `scripts/check-workspace-constraints.ts`

- [ ] **Step 1: Write the readiness parser test**

The parser accepts chunk boundaries, ignores unrelated output, emits exactly once, accepts only `127.0.0.1` with a valid port, and never treats a LAN URL or trailing text as the canonical endpoint.

```typescript
it('emits one canonical settled endpoint across stdout chunks', () => {
  const parser = createReadinessParser()
  expect(parser.push('booting\ndsh web: http://127.0.0.1:')).toBeUndefined()
  expect(parser.push('49152\n')).toEqual(new URL('http://127.0.0.1:49152'))
  expect(parser.push('dsh web: http://127.0.0.1:4000\n')).toBeUndefined()
})
```

- [ ] **Step 2: Run the test and verify the parser is absent**

Run: `pnpm vitest run apps/desktop/tests/readiness.spec.ts`

Expected: FAIL because `createReadinessParser` does not exist.

- [ ] **Step 3: Implement the bounded parser**

Keep at most 8 KiB of an incomplete line, split only on newline, match `^dsh web: (http://127\.0\.0\.1:(\d+))(?: .*)?$`, require port 1–65535, and latch after the first result. Export only `createReadinessParser` and its return interface.

- [ ] **Step 4: Create the desktop workspace package**

Use Electron 43.4.0 exactly. Add `electron: true` under `allowBuilds` in `pnpm-workspace.yaml`, add `dev:desktop` and `test:desktop` root scripts, add `apps/desktop` to the Host TypeScript aggregate and root tsdown workspace, and build two entries with no Harness duplicate: ESM `main.js` and bundled CommonJS `preload.cjs`, because sandboxed Electron preloads do not support ESM. Extend `appPackageFiles` with `@deepseek-ai/dsh-desktop: ['lib/*.js', 'lib/*.cjs']`; do not weaken the release-member rule.

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

Use this TypeScript project and package-owned tsdown config. Electron stays external because the Electron executable supplies it at runtime.

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

- [ ] **Step 5: Verify package constraints, typechecking, and parser behavior**

Run: `pnpm install && pnpm vitest run apps/desktop/tests/readiness.spec.ts && pnpm run constraints && pnpm run typecheck`

Expected: all commands exit 0.

- [ ] **Step 6: Commit the app skeleton**

```sh
git add apps/desktop package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.host.json tsdown.config.ts scripts/check-workspace-constraints.ts
git commit -m "feat(desktop): scaffold the Electron application"
```

### Task 5: Supervise the Harness utility process

**Files:**

- Create: `apps/desktop/src/harness-supervisor.ts`
- Create: `apps/desktop/tests/harness-supervisor.spec.ts`

- [ ] **Step 1: Write lifecycle tests against a fake utility process**

Cover fork arguments, a 32-byte base64url capability, inherited environment without mutation, `--profile desktop --port 0`, readiness resolution, exit-before-ready rejection with a bounded stderr tail, one idempotent `kill()`, and a bounded wait for the exit event.

```typescript
expect(fork).toHaveBeenCalledWith(cliEntry, ['--profile', 'desktop', '--port', '0'], expect.objectContaining({
  env: expect.objectContaining({ DSH_DESKTOP_CAPABILITY: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }),
  stdio: 'pipe',
  serviceName: 'DeepSeek Harness Runtime',
}))
```

- [ ] **Step 2: Run the focused suite and verify the supervisor is absent**

Run: `pnpm vitest run apps/desktop/tests/harness-supervisor.spec.ts`

Expected: FAIL because `startHarness` does not exist.

- [ ] **Step 3: Implement dependency-injected supervision**

Resolve the installed CLI with `createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js')`. Generate the capability in Main, fork only after `app.whenReady()`, pipe stdout/stderr, and return `{ endpoint, capability, stop }`. `stop()` calls `kill()` once and waits up to five seconds for `exit`; a missing exit rejects with a named shutdown-timeout error. It does not use `process.kill(pid)` or a platform shell.

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

- [ ] **Step 4: Verify lifecycle behavior**

Run: `pnpm vitest run apps/desktop/tests/harness-supervisor.spec.ts`

Expected: PASS with no capability value in snapshots or console output.

- [ ] **Step 5: Commit process supervision**

```sh
git add apps/desktop/src/harness-supervisor.ts apps/desktop/tests/harness-supervisor.spec.ts
git commit -m "feat(desktop): supervise the Harness runtime"
```

### Task 6: Create the authorized session and sandboxed window

**Files:**

- Create: `apps/desktop/src/authorized-session.ts`
- Create: `apps/desktop/src/window.ts`
- Create: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/global.d.ts`
- Create: `apps/desktop/tests/authorized-session.spec.ts`
- Create: `apps/desktop/tests/window.spec.ts`

- [ ] **Step 1: Write request-scope and window-policy tests**

Confirm Authorization is added to `http`, `ws`, fetch, script, image, and main-frame requests for the exact origin only. Confirm it is never added to another port, another hostname, HTTPS, or an external navigation. Assert permission check/request handlers deny by default. Assert BrowserWindow options set `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, and an in-memory partition.

```typescript
expect(windowOptions.webPreferences).toMatchObject({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  partition: 'dsh-desktop',
})
```

- [ ] **Step 2: Run the focused tests and verify both modules are absent**

Run: `pnpm vitest run apps/desktop/tests/authorized-session.spec.ts apps/desktop/tests/window.spec.ts`

Expected: FAIL because the session and window factories do not exist.

- [ ] **Step 3: Implement exact-origin header injection**

Use `session.fromPartition('dsh-desktop', { cache: true })`. Register one `onBeforeSendHeaders` listener covering the exact `http://127.0.0.1:<port>/*` and `ws://127.0.0.1:<port>/*` patterns; preserve all headers and set `Authorization: Bearer <capability>`. The callback cancels any matching request whose `webContentsId` is not the main window after it exists. Install deny-all permission check and request handlers.

- [ ] **Step 4: Implement the secure BrowserWindow**

Load only the settled endpoint. Point BrowserWindow at the absolute bundled `lib/preload.cjs`. Reject `will-navigate` when the next URL's origin differs, deny every `window.open`, and open no external URL in this slice. Attach the request listener before `loadURL`. Set a minimum size of 960×640 and persist no window state yet.

- [ ] **Step 5: Add the narrow preload bridge**

Expose one frozen value and no IPC sender, filesystem, shell, environment, process, or capability.

```typescript
contextBridge.exposeInMainWorld('deepseekDesktop', Object.freeze({
  platform: process.platform,
}))
```

- [ ] **Step 6: Verify the security unit suite**

Run: `pnpm vitest run apps/desktop/tests/authorized-session.spec.ts apps/desktop/tests/window.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit the secure window**

```sh
git add apps/desktop/src apps/desktop/tests
git commit -m "feat(desktop): add the authorized sandboxed window"
```

### Task 7: Compose application lifecycle and prove the vertical slice

**Files:**

- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/tests/desktop.e2e.ts`
- Create: `apps/desktop/README.md`
- Create: `apps/desktop/README.zh.md`
- Create: `apps/desktop/README.i18n.yaml`

- [ ] **Step 1: Implement Main as composition only**

Call `app.enableSandbox()` before readiness. Acquire the single-instance lock; after `app.whenReady()`, start Harness, prepare the authorized session, create the window, and load the endpoint. On `second-instance`, restore/focus the existing window. During `before-quit`, prevent the first quit, await one Harness stop, report a shutdown timeout if one occurs, and quit again under a `finally` latch. On Windows and Linux, closing the only window quits in this foundation slice; macOS recreates a window on activate while Harness remains alive. Task-aware tray behavior belongs to the Task lifecycle plan.

```typescript
app.enableSandbox()
if (!app.requestSingleInstanceLock()) app.quit()
else void app.whenReady().then(startDesktop).catch(reportFatalStartup)
```

- [ ] **Step 2: Write the real Electron acceptance test**

Build required artifacts, launch Electron through Playwright, wait for one window, and assert the existing client title and root render. Read the runtime origin from the page, call `/api/host.describe` with Node `fetch` and no header, and require 401. Call the same endpoint through `page.evaluate(fetch)` and require a non-401 response, proving session-scoped injection rather than a disabled guard. Assert `window.process`, `window.require`, and the capability are absent.

```typescript
expect(await page.title()).toBe('DeepSeek Harness')
expect(await page.evaluate(() => ({
  process: 'process' in window,
  require: 'require' in window,
  bridge: window.deepseekDesktop,
}))).toEqual({ process: false, require: false, bridge: { platform: process.platform } })
```

- [ ] **Step 3: Run the acceptance test and capture the first failure**

Run: `pnpm --filter @deepseek-ai/dsh-desktop build && pnpm playwright test apps/desktop/tests/desktop.e2e.ts`

Expected before lifecycle wiring: FAIL because no application window becomes ready.

- [ ] **Step 4: Add the Vitest inventory and desktop README pair**

The existing `apps/*/tests/**/*.spec.ts` inventory already covers the new unit tests and requires no Vitest configuration change. Document development startup, process ownership, security invariants, failure behavior, and the exact boundary of this foundation slice. Do not claim installers, updates, tray persistence, or Mission Control UI.

- [ ] **Step 5: Run the complete foundation verification**

Run: `pnpm --filter @deepseek-ai/dsh-desktop build`

Expected: Electron Main emits as `lib/main.js`, the sandbox-compatible preload emits as `lib/preload.cjs`, and neither bundle includes Electron.

Run: `pnpm playwright test apps/desktop/tests/desktop.e2e.ts`

Expected: PASS; unauthorized direct access is 401 and the sandboxed Renderer is usable.

Run: `pnpm run test:gui && pnpm run typecheck && pnpm run lint`

Expected: all commands exit 0.

- [ ] **Step 6: Commit the runnable vertical slice**

```sh
git add apps/desktop
git commit -m "feat(desktop): boot the secured desktop application"
```

### Task 8: Close documentation and repository gates

**Files:**

- Modify: `.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.md`
- Modify: `.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.zh.md`
- Modify: `.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.i18n.yaml`

- [ ] **Step 1: Record only the shipped foundation facts**

Keep the note `proposed` because Mission Control is not complete. Replace the foundation paragraphs' future language with the exact shipped process, authorization, and Renderer behavior, and state that Task projection, worktrees, task-aware tray lifecycle, review, Studio, signing, and updates remain unimplemented. Do not add a test inventory or repeat package READMEs.

- [ ] **Step 2: Re-record all changed bilingual pairs**

Run `pnpm run verify-translation-pairing --write` separately for the webserver README, desktop-app README, app-boot README, CLI reference, desktop README, and desktop mission-control Agent Note.

Expected: every scoped check reports one consistent named pair.

- [ ] **Step 3: Run repository documentation and product gates**

Run: `pnpm run doc-sync`

Expected: every documentation gate passes, including package paths, Mermaid, Agent Note format, and translation pairing.

Run: `pnpm run constraints && pnpm run typecheck && pnpm run lint && pnpm run build`

Expected: all commands exit 0.

Run: `git diff --check && git status --short`

Expected: no whitespace errors; status lists only intended foundation changes.

- [ ] **Step 4: Run the desktop acceptance test once more after the full build**

Run: `pnpm playwright test apps/desktop/tests/desktop.e2e.ts`

Expected: PASS against freshly built artifacts.

- [ ] **Step 5: Commit the verified documentation state**

```sh
git add .agents/notes apps/desktop packages/host/webserver packages/bundle/desktop-app packages/boot/app-boot apps/cli/reference
git commit -m "docs: record the desktop foundation contracts"
```

## Completion checkpoint

This plan is complete only when a fresh checkout can build and open the Electron app, the existing Harness client connects through the random loopback port, direct unauthenticated HTTP and WebSocket access is rejected, Renderer Node globals are absent, and closing the application settles the supervised Harness process. Product work then advances to the Task projection and unified attention queue plan; it does not add feature UI directly to Electron Main or preload.
