# Windows Installer Implementation Plan

English | [中文](2026-08-24-windows-installer.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one self-contained Windows x64 setup EXE that installs, starts, upgrades, and uninstalls DeepSeek Harness Desktop on a clean user account without Node.js, pnpm, the repository, network access, or administrator privileges.

**Architecture:** A deterministic staging command deploys the desktop workspace and its complete production dependency closure into `.artifacts/desktop/stage`, then electron-builder packages that closed tree with Electron and an assisted NSIS installer. Electron Main owns an immediate local startup/recovery window, an application-data root under `%APPDATA%`, an authenticated readiness probe, and the existing supervised Harness child. A custom NSIS include owns optional shortcuts, current-user login startup, retained installer choices, safe user-data deletion, and upgrade process coordination.

**Tech Stack:** TypeScript 6, Node.js 24, Electron 43.4.0, electron-builder 26.15.3, NSIS 3, Vitest 4, Playwright Electron, PowerShell, pnpm 11, GitHub Actions Windows runners.

---

## Plan boundary

This is one plan because packaging closure, startup recovery, installer behavior, and installed-app verification share one release artifact and cannot be accepted independently. Each task still ends in a focused test and commit. Automatic in-application updates, certificate procurement, ARM64, MSI, and non-Windows targets remain outside this plan.

## Source map

| Path | Responsibility |
|---|---|
| `scripts/desktop/stage.ts` | Create a clean production deployment for the desktop workspace |
| `scripts/desktop/packaging-layout.ts` | Define stable staging, unpacked, installer, and checksum paths |
| `scripts/desktop/validate-package.ts` | Fail closed on an incomplete or build-machine-bound packaged closure |
| `scripts/desktop/build-installer.ts` | Invoke electron-builder for one x64 NSIS artifact and write its checksum |
| `apps/desktop/electron-builder.yml` | Stable application identity, file layout, NSIS defaults, and signing hooks |
| `apps/desktop/build/installer.nsh` | User choices, retained options, login startup, shortcuts, and uninstall data page |
| `apps/desktop/src/runtime-context.ts` | Resolve installed resources, application data, Harness home, logs, and child environment |
| `apps/desktop/src/startup-state.ts` | Pure startup/recovery state machine and safe user-facing error projection |
| `apps/desktop/src/startup-window.ts` | Sandboxed immediate startup window and its narrow action bridge |
| `apps/desktop/src/readiness-probe.ts` | Authenticated version-and-capability readiness check |
| `apps/desktop/src/main-lifecycle.ts` | Retryable startup, one-instance focus, shutdown, and window handoff |
| `apps/desktop/src/uninstall-cleanup.ts` | Product-root validation and explicit user-data deletion mode |
| `apps/desktop/tests/installer.e2e.ts` | Clean install, custom install, upgrade, preserve/delete uninstall, and offline launch |
| `.github/workflows/desktop-installer.yml` | Windows build, E2E verification, checksum, and installer artifact publication |

### Task 1: Establish deterministic production staging

**Files:**

- Create: `scripts/desktop/packaging-layout.ts`
- Create: `scripts/desktop/stage.ts`
- Create: `scripts/desktop/stage.spec.ts`
- Modify: `apps/desktop/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write the failing layout and manifest tests**

Test that every output stays beneath `.artifacts/desktop`, that the generated deployment manifest keeps `main: lib/main.js`, removes development scripts, and records the source version without absolute repository paths.

```typescript
it('creates a relocatable desktop deployment manifest', () => {
  const manifest = deploymentManifest(sourceManifest)
  expect(manifest).toMatchObject({ name: '@deepseek-ai/dsh-desktop', main: 'lib/main.js' })
  expect(manifest.scripts).toBeUndefined()
  expect(JSON.stringify(manifest)).not.toContain(repositoryRoot)
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run scripts/desktop/stage.spec.ts`

Expected: FAIL because `packaging-layout.ts` and `stage.ts` do not exist.

- [ ] **Step 3: Implement the owned output layout and staging command**

Define all paths from the repository root and reject any resolved destination outside the owned artifact root. `stage.ts` removes only the validated stage directory, executes `pnpm --filter @deepseek-ai/dsh-desktop deploy --prod --legacy <stage>`, rewrites the staged manifest through `deploymentManifest()`, and verifies that `lib/main.js`, `lib/preload.cjs`, `node_modules/@deepseek-ai/dsh/lib/bin.js`, and the desktop profile bundles exist.

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

- [ ] **Step 4: Add packaging dependencies and scripts**

Add `electron-builder` as an exact desktop dev dependency, allow its reviewed install scripts in `pnpm-workspace.yaml` if the immutable install identifies any, and add these commands:

```json
{
  "desktop:stage": "tsx scripts/desktop/stage.ts",
  "desktop:package": "tsx scripts/desktop/build-installer.ts",
  "desktop:validate-package": "tsx scripts/desktop/validate-package.ts",
  "test:desktop:installer": "vitest run --config vitest.desktop-installer.config.ts"
}
```

- [ ] **Step 5: Verify staging and commit**

Run: `pnpm vitest run scripts/desktop/stage.spec.ts && pnpm run build && pnpm run desktop:stage`

Expected: PASS and `.artifacts/desktop/stage` contains only ordinary files/directories whose application entry resolves inside the stage.

```sh
git add package.json pnpm-lock.yaml pnpm-workspace.yaml apps/desktop/package.json scripts/desktop
git commit -m "build(desktop): stage a production runtime closure"
```

### Task 2: Isolate installed runtime paths from the development machine

**Files:**

- Create: `apps/desktop/src/runtime-context.ts`
- Create: `apps/desktop/tests/runtime-context.spec.ts`
- Modify: `apps/desktop/src/harness-supervisor.ts`
- Modify: `apps/desktop/tests/harness-supervisor.spec.ts`
- Modify: `apps/desktop/src/main.ts`

- [ ] **Step 1: Write failing production-path tests**

Cover packaged and development modes. Packaged mode must resolve the CLI below `process.resourcesPath`, set `DSH_HOME` to `%APPDATA%\DeepSeek Harness\Harness`, set the log directory below the product data root, choose a user-owned working directory, and remove inherited `DSH_HOME`, `NODE_PATH`, `PNPM_HOME`, and repository-only launch variables.

```typescript
expect(resolveRuntimeContext(fakeApp, packagedProcess)).toEqual(expect.objectContaining({
  cliEntry: join(resources, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  harnessHome: join(roaming, 'DeepSeek Harness', 'Harness'),
  logs: join(roaming, 'DeepSeek Harness', 'logs'),
}))
```

- [ ] **Step 2: Run the focused tests and verify the missing resolver**

Run: `pnpm --filter @deepseek-ai/dsh-desktop test -- runtime-context harness-supervisor`

Expected: FAIL because `resolveRuntimeContext` does not exist.

- [ ] **Step 3: Implement the explicit runtime context**

Use `app.getPath('appData')`, `app.getPath('home')`, `process.resourcesPath`, and `app.isPackaged`; never derive installed resources from `process.cwd()`. Preserve ordinary environment values but delete the named development overrides before setting the owned `DSH_HOME`.

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

- [ ] **Step 4: Pass paths explicitly into the Harness supervisor**

Replace the production `createRequire(...).resolve()` and `process.cwd()` defaults with `HarnessLaunchSpec { cliEntry, cwd, environment }`. Assert that the CLI is an ordinary file before `utilityProcess.fork()` and include `DSH_DESKTOP_APP_VERSION` in the child environment without logging it.

Set `app.setAppUserModelId('ai.deepseek.harness.desktop')` before creating either window so installed shortcuts, taskbar grouping, and notifications share the package identity.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @deepseek-ai/dsh-desktop test -- runtime-context harness-supervisor && pnpm --filter @deepseek-ai/dsh-desktop typecheck`

Expected: PASS.

```sh
git add apps/desktop/src apps/desktop/tests
git commit -m "feat(desktop): isolate installed runtime paths"
```

### Task 3: Add structured startup state, logs, and safe diagnostics

**Files:**

- Create: `apps/desktop/src/startup-state.ts`
- Create: `apps/desktop/src/desktop-log.ts`
- Create: `apps/desktop/tests/startup-state.spec.ts`
- Create: `apps/desktop/tests/desktop-log.spec.ts`
- Modify: `apps/desktop/src/sensitive-text-redactor.ts`

- [ ] **Step 1: Write failing state and redaction tests**

Pin the transitions `waiting-electron -> loading-runtime -> validating-profile -> starting-service -> probing-service -> ready`, retry from `failed`, and reject stale attempt updates. Verify that error projection contains a stable code and short action message but no stack, capability, API key, bearer header, or absolute repository path.

```typescript
expect(reduceStartup(failed, { type: 'retry', attempt: 2 })).toEqual({
  attempt: 2,
  phase: 'loading-runtime',
  status: 'working',
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm --filter @deepseek-ai/dsh-desktop test -- startup-state desktop-log`

Expected: FAIL because the state reducer and log owner do not exist.

- [ ] **Step 3: Implement the pure state model and rotating log owner**

Define discriminated `DesktopStartupState` and `DesktopStartupEvent` unions with `assertNever`. `DesktopLog` creates the owned log directory, appends one JSON line per lifecycle event, rotates `desktop.log` at a configurable size, and returns only the current resolved log path. Run every message through the existing sensitive-text redactor before persistence.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @deepseek-ai/dsh-desktop test -- startup-state desktop-log sensitive-text-redactor`

Expected: PASS.

```sh
git add apps/desktop/src apps/desktop/tests
git commit -m "feat(desktop): model startup recovery and diagnostics"
```

### Task 4: Show an immediate sandboxed startup and recovery window

**Files:**

- Create: `apps/desktop/src/startup-window.ts`
- Create: `apps/desktop/src/startup-preload.ts`
- Create: `apps/desktop/src/startup.html`
- Create: `apps/desktop/tests/startup-window.spec.ts`
- Create: `apps/desktop/tests/startup-preload.spec.ts`
- Modify: `apps/desktop/src/global.d.ts`
- Modify: `apps/desktop/tsdown.config.ts`

- [ ] **Step 1: Write failing window containment tests**

Verify immediate creation with `show: true`, a local file URL, sandboxing, context isolation, Node integration disabled, navigation/new windows denied, and a frozen bridge containing only `onState(listener)`, `retry()`, `openLogs()`, and `exit()`.

- [ ] **Step 2: Run the focused tests and verify the window is absent**

Run: `pnpm --filter @deepseek-ai/dsh-desktop test -- startup-window startup-preload`

Expected: FAIL because the startup window entrypoints do not exist.

- [ ] **Step 3: Implement the local startup window**

Create a `BrowserWindow` before Harness startup. Render fixed local HTML/CSS with product name, phase label, indeterminate progress, and an error action row. The renderer receives only redacted `DesktopStartupState`; action handlers are registered against the exact owned `webContents.id` and disposed on close.

```typescript
export interface StartupWindow {
  readonly closed: Promise<void>
  focus(): void
  publish(state: DesktopStartupState): void
  showFailure(state: DesktopStartupFailure): void
  handoffTo(window: DesktopWindow): Promise<void>
}
```

- [ ] **Step 4: Bundle the dedicated preload and copy the HTML**

Add `startup-preload` as a CommonJS tsdown entry and copy `startup.html` into `lib/` during the desktop build. Add a test that fails if either packaged asset is absent.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @deepseek-ai/dsh-desktop build && pnpm --filter @deepseek-ai/dsh-desktop test -- startup-window startup-preload`

Expected: PASS and `apps/desktop/lib/startup-preload.cjs` plus `apps/desktop/lib/startup.html` exist.

```sh
git add apps/desktop
git commit -m "feat(desktop): add native startup recovery surface"
```

### Task 5: Require an authenticated capability readiness probe

**Files:**

- Create: `apps/desktop/src/readiness-probe.ts`
- Create: `apps/desktop/tests/readiness-probe.spec.ts`
- Modify: `packages/bundle/desktop-app/src/index.ts`
- Modify: `packages/bundle/desktop-app/tests/desktop-app.spec.ts`
- Modify: `apps/desktop/src/harness-supervisor.ts`

- [ ] **Step 1: Write failing probe tests**

Cover wrong status, wrong content type, wrong version, missing required capability names, timeout, abort, and a valid response. Assert that the bearer capability never appears in an error.

```typescript
await expect(probeDesktopReadiness({
  endpoint,
  capability: 'secret',
  expectedVersion: '0.1.0-rc.7',
  requiredCapabilities: ['host.describe', 'session.list'],
  signal,
})).resolves.toEqual({ version: '0.1.0-rc.7' })
```

- [ ] **Step 2: Run the tests and verify the endpoint contract is absent**

Run: `pnpm vitest run apps/desktop/tests/readiness-probe.spec.ts packages/bundle/desktop-app/tests/desktop-app.spec.ts`

Expected: FAIL because the desktop readiness route and probe do not exist.

- [ ] **Step 3: Register the desktop readiness route as a plugin effect**

In `desktop-app`, register an exact authenticated GET route returning `{ product: 'deepseek-harness-desktop', version, capabilities }`. Derive capabilities from authoritative mounted services, not method-presence guesses. Dispose the route with the plugin.

- [ ] **Step 4: Probe after the canonical URL line and before renderer handoff**

Keep the existing stdout readiness line as the endpoint discovery signal, then call `probeDesktopReadiness()` with the same startup abort signal and the remaining bounded deadline. Only resolve `startHarness()` after the probe succeeds.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run apps/desktop/tests/readiness-probe.spec.ts apps/desktop/tests/harness-supervisor.spec.ts packages/bundle/desktop-app/tests/desktop-app.spec.ts`

Expected: PASS.

```sh
git add apps/desktop packages/bundle/desktop-app
git commit -m "feat(desktop): authenticate runtime readiness"
```

### Task 6: Integrate retryable startup, handoff, logs, and cleanup mode

**Files:**

- Create: `apps/desktop/src/uninstall-cleanup.ts`
- Create: `apps/desktop/tests/uninstall-cleanup.spec.ts`
- Modify: `apps/desktop/src/main-lifecycle.ts`
- Modify: `apps/desktop/tests/main-lifecycle.spec.ts`
- Modify: `apps/desktop/src/main.ts`

- [ ] **Step 1: Write failing lifecycle and cleanup tests**

Verify that Electron readiness creates the startup window before Harness begins; startup failure keeps the window open; Retry creates exactly one fresh attempt after the old child settles; Open Logs opens the owned log path; Exit performs bounded cleanup; success atomically hands off to the main window. Verify that cleanup rejects a product root outside `%APPDATA%`, any root/ancestor reparse point, filesystem root, empty path, or mismatched confirmation token.

- [ ] **Step 2: Run the focused tests and verify the old quit-on-failure behavior**

Run: `pnpm --filter @deepseek-ai/dsh-desktop test -- main-lifecycle uninstall-cleanup`

Expected: FAIL because startup failure currently quits and cleanup mode does not exist.

- [ ] **Step 3: Implement attempt-scoped retry and handoff**

Give each attempt its own `AbortController`, Harness handle, and monotonically increasing id. Publish stages to both the startup window and log. A stale attempt may clean up its own child but cannot change the current window state. Keep the application single-instance lock; second-instance focuses whichever owned window is live.

- [ ] **Step 4: Implement explicit uninstall cleanup mode**

Parse `--uninstall-delete-user-data=<token>` before normal startup. Validate the token passed by the uninstaller, resolve the product root from `%APPDATA%`, lstat every existing ancestor and the root, refuse reparse points, and call `rm(productRoot, { recursive: true })` only after every check succeeds. Return a nonzero exit code and leave data intact on any failure.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @deepseek-ai/dsh-desktop test -- main-lifecycle uninstall-cleanup && pnpm --filter @deepseek-ai/dsh-desktop typecheck`

Expected: PASS.

```sh
git add apps/desktop/src apps/desktop/tests
git commit -m "feat(desktop): recover startup and guard uninstall cleanup"
```

### Task 7: Build the assisted per-user NSIS installer

**Files:**

- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/build/installer.nsh`
- Create: `apps/desktop/build/icon.ico`
- Create: `scripts/desktop/build-installer.ts`
- Create: `scripts/desktop/build-installer.spec.ts`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Write failing configuration tests**

Parse the YAML and NSIS include as data. Pin `appId`, x64-only NSIS target, `oneClick: false`, `perMachine: false`, `allowElevation: false`, `allowToChangeInstallationDirectory: true`, `runAfterFinish: true`, `allowDowngrade: false`, artifact name, stable GUID, no web installer, and the three approved option defaults.

- [ ] **Step 2: Run the test and verify configuration is absent**

Run: `pnpm vitest run scripts/desktop/build-installer.spec.ts`

Expected: FAIL because the builder configuration and include do not exist.

- [ ] **Step 3: Add electron-builder configuration**

Use `asar: false` for the first installer so the utility-process CLI and loader resources are ordinary files. Set the default per-user directory through the stable install registry key, keep signing auto-discovery enabled through `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`, and let unsigned local builds proceed when those variables are absent.

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

- [ ] **Step 4: Implement the custom options and uninstall pages**

Use `nsDialogs` checkboxes for Desktop shortcut (ON), Start Menu shortcut (ON), and login startup (OFF). Persist choices under an HKCU product key, safely quote the installed executable in the Run value, and create/remove only product-owned shortcuts. Add an uninstall checkbox “Delete user data from: <path>” (OFF) plus confirmation; on selection invoke the installed executable's cleanup mode with an unguessable per-run token before files are removed. Use `${isUpdated}` to distinguish upgrade from first install and preserve prior choices.

Before replacement, use the application mutex and NSIS process helper to request/verify shutdown, showing Retry or Cancel while any owned application process remains. Same-version execution follows the repair path; the fixed `allowDowngrade: false` setting rejects older installers. Keep electron-builder's versioned staging and rollback behavior intact rather than overwriting files from custom NSIS code.

- [ ] **Step 5: Build the installer and commit**

Run: `pnpm vitest run scripts/desktop/build-installer.spec.ts && pnpm run desktop:package`

Expected: PASS and exactly one `DeepSeek-Harness-Setup-0.1.0-rc.7-x64.exe` exists under `.artifacts/desktop/installer`.

```sh
git add apps/desktop/build apps/desktop/electron-builder.yml apps/desktop/package.json scripts/desktop
git commit -m "build(desktop): add assisted Windows installer"
```

### Task 8: Validate the final package closure and release metadata

**Files:**

- Create: `scripts/desktop/validate-package.ts`
- Create: `scripts/desktop/validate-package.spec.ts`
- Create: `scripts/desktop/checksum.ts`
- Modify: `scripts/desktop/build-installer.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing closure-validator tests**

Fixtures must reject missing CLI/profile/web/native resources, dangling links, links escaping the package, junctions into a pnpm store/repository, absolute build paths in text manifests, wrong-architecture `.node`/`.exe` files, and absent required peer dependencies. A complete relocatable fixture passes.

- [ ] **Step 2: Run the tests and verify the validator is absent**

Run: `pnpm vitest run scripts/desktop/validate-package.spec.ts`

Expected: FAIL because the validator does not exist.

- [ ] **Step 3: Implement fail-closed validation**

Walk with `lstat`, never follow links during discovery, and inspect every link target before allowing it. Resolve production dependency and peer-dependency graphs from the staged `package.json` files. Parse PE headers for x64 machine type and scan only bounded UTF-8 configuration/manifest files for the normalized repository root, user profile, pnpm store, and staging root.

- [ ] **Step 4: Validate before NSIS and write SHA-256 after NSIS**

`build-installer.ts` must validate the unpacked app before creating NSIS, verify the expected installer name and count afterward, then write `<installer>.sha256` containing lowercase hash plus filename. When signing variables are present, run PowerShell `Get-AuthenticodeSignature` and require `Status -eq 'Valid'`; otherwise record `signed: false` in `release-metadata.json`.

- [ ] **Step 5: Verify and commit**

Run: `pnpm vitest run scripts/desktop/validate-package.spec.ts scripts/desktop/build-installer.spec.ts && pnpm run desktop:package && pnpm run desktop:validate-package`

Expected: PASS; checksum matches the EXE and validation reports no external runtime paths.

```sh
git add scripts/desktop package.json
git commit -m "test(desktop): enforce installer runtime closure"
```

### Task 9: Exercise clean install, upgrade, and both uninstall choices

**Files:**

- Create: `vitest.desktop-installer.config.ts`
- Create: `apps/desktop/tests/installer.e2e.ts`
- Create: `apps/desktop/tests/installer-support.ts`
- Modify: `apps/desktop/tests/desktop.e2e.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the Windows-only installer scenarios**

Gate the suite behind `DSH_INSTALLER_E2E=1` and Windows x64. Use a unique temporary install directory and test-owned registry/shortcut names. Cover default/custom destination, every option ON/OFF, launch from installed EXE with repository/Node/pnpm/store paths removed from the environment, existing `~/.dsh`, corrupt product profile, same-version repair, older-to-current upgrade, default data preservation, explicit deletion, and redirected-data refusal.

- [ ] **Step 2: Run the suite before its silent test switches exist**

Run: `$env:DSH_INSTALLER_E2E='1'; pnpm run test:desktop:installer`

Expected: FAIL on the first unsupported deterministic installer option.

- [ ] **Step 3: Add deterministic automation switches to NSIS**

Support test-only `/DSH_E2E=1`, `/DESKTOPSHORTCUT=0|1`, `/STARTMENUSHORTCUT=0|1`, `/AUTOSTART=0|1`, `/LAUNCH=0|1`, `/DELETEUSERDATA=0|1`, and NSIS `/D=<absolute directory>`. Reject these switches without `/DSH_E2E=1`; keep the ordinary interactive defaults unchanged.

- [ ] **Step 4: Verify installed application and lifecycle behavior**

Launch the installed executable with Playwright Electron, require the startup window to appear within five seconds, wait for the main title and authorized host response, confirm paths are beneath the test APPDATA root, close cleanly, then inspect files, HKCU values, shortcuts, preserved sessions, deleted data, and process absence after uninstall.

- [ ] **Step 5: Run all desktop acceptance checks and commit**

Run: `pnpm run test:desktop && pnpm run test:desktop:e2e:ci`

Expected: PASS.

Run: `$env:DSH_INSTALLER_E2E='1'; pnpm run test:desktop:installer`

Expected: PASS with no remaining test-owned processes, registry values, shortcuts, install directories, or temporary APPDATA roots.

```sh
git add apps/desktop/tests vitest.desktop-installer.config.ts package.json apps/desktop/build/installer.nsh
git commit -m "test(desktop): verify Windows installer lifecycle"
```

### Task 10: Document, record the decision, and publish the CI artifact

**Files:**

- Create: `.github/workflows/desktop-installer.yml`
- Create: `.agents/notes/implemented/feature/2026-08-24-windows-desktop-installer.md`
- Create: `.agents/notes/implemented/feature/2026-08-24-windows-desktop-installer.zh.md`
- Create: `.agents/notes/implemented/feature/2026-08-24-windows-desktop-installer.i18n.yaml`
- Modify: `apps/desktop/README.md`
- Modify: `apps/desktop/README.zh.md`
- Modify: `apps/desktop/README.i18n.yaml`
- Modify: `docs/superpowers/specs/2026-08-24-windows-installer-design.md`
- Modify: `docs/superpowers/specs/2026-08-24-windows-installer-design.zh.md`
- Modify: `docs/superpowers/specs/2026-08-24-windows-installer-design.i18n.yaml`
- Modify: `scripts/run-gates.ts`
- Modify: `scripts/run-gates.spec.ts`

- [ ] **Step 1: Add the Windows artifact workflow and gate inventory**

On pull requests, build and validate the installer and run one clean-install/offline-launch smoke on the native Windows lane. On master and version tags, run the complete installer E2E matrix, upload the EXE, SHA-256, and release metadata with retention, and never expose signing secrets to pull-request code. Add a named observational installer gate to `ci-windows-complete` with the build dependency expressed in `run-gates.ts`.

- [ ] **Step 2: Write the implemented Agent Note and update both READMEs**

Record the shipped decision, why staging plus assisted NSIS won over portable ZIP/one-click/MSI, data ownership, closure validation, signing boundary, and current exclusions. Replace the README “Source-checkout execution” limitation with installation/build/test instructions and an unsigned SmartScreen warning; keep automatic updates listed as excluded.

- [ ] **Step 3: Confirm every bilingual pair**

Run:

```sh
pnpm run verify-translation-pairing --write apps/desktop/README.md
pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-08-24-windows-desktop-installer.md
pnpm run verify-translation-pairing --write docs/superpowers/specs/2026-08-24-windows-installer-design.md
```

Expected: three records written and each named pair consistent.

- [ ] **Step 4: Run final relevant verification**

Run:

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

Expected: every command passes. Do not substitute the full repository unit suite or coverage gate for these surface-matched checks.

- [ ] **Step 5: Commit documentation and CI**

```sh
git add .github/workflows/desktop-installer.yml .agents/notes/implemented/feature apps/desktop/README* docs/superpowers/specs/2026-08-24-windows-installer-design* scripts/run-gates.ts scripts/run-gates.spec.ts
git commit -m "ci(desktop): publish verified Windows installer"
```

- [ ] **Step 6: Produce the user-test artifact**

Run: `pnpm run desktop:package`

Expected: `.artifacts/desktop/installer/DeepSeek-Harness-Setup-0.1.0-rc.7-x64.exe`, its `.sha256`, and `release-metadata.json`. Double-clicking the EXE shows the assisted installer; this is the artifact handed to the user for acceptance testing.

## External implementation references

- [electron-builder NSIS options](https://www.electron.build/nsis/)
- [electron-builder application contents](https://www.electron.build/docs/contents/)
- [electron-builder Windows code signing](https://www.electron.build/docs/features/code-signing/code-signing-win/)
