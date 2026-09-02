# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

The Electron application boots the secured desktop profile, owns one supervised Harness utility process, and presents the existing plugin-composed Web client in a sandboxed renderer. Electron Main owns only process, window, and application lifecycle; product task state remains in Harness plugins and Session events.

## Development

Install the repository dependencies, then build the Harness libraries, Web frontend, Electron Main entry, and CommonJS preload before starting Electron:

```sh
pnpm install
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop build
pnpm --filter @deepseek-ai/dsh-desktop start
```

`start` runs the built `lib/main.js`; it does not compile source files. The invoking directory becomes the Harness working directory, while `DSH_HOME` selects the profile and persistence root through the ordinary CLI rules.

## Runtime Lifecycle

Main enables Chromium's sandbox before readiness and acquires Electron's single-instance lock. After `app.whenReady()`, the owning instance creates the local startup window, starts exactly one Harness with the `desktop` profile on a random loopback port, and hands off to the authorized main window only after authenticated readiness. Native close clears Main's window ownership so later events never call a stale handle. A second launch restores and focuses a live window without starting another Harness; on macOS, it recreates and focuses a closed window with the existing Harness authority.

The first explicit quit aborts pending Harness startup, waits for startup ownership to settle, stops a ready Harness once, and then repeats `app.quit()` under a latch. A shutdown failure is reported but cannot prevent the final quit. Closing the last window quits on Windows and Linux; on macOS, activation recreates a missing window with the existing Harness authority.

## Security

The installer close helper uses the same Electron user-data directory as ordinary startup. After validating the sole `--installer-request-close` argument, it sends an explicit single-instance notification and exits without composing Harness or windows. Packaged Windows tests authenticate their appData and home overrides before either launch mode acquires the lock; test metadata is removed from argument classification only after validation. The isolated Electron home keeps CLI dotenv loading inside the fixture without changing native Windows profile environment variables.

- Main generates a 32-byte per-launch capability and passes it only to the Harness process and the isolated Electron session. The session adds `Authorization: Bearer <capability>` only for the exact settled HTTP and WebSocket origin and only for the owned renderer.
- The capability is absent from renderer and preload APIs, URLs, DOM state, Web storage, logs, settings, and Session events. Direct loopback clients without the header receive `401`.
- The renderer runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true`. Its frozen preload bridge exposes only `deepseekDesktop.platform`; it exposes no generic IPC, process, filesystem, shell, environment, or capability access.
- Navigation and redirects stay on the settled origin, every new-window request is denied, and renderer permission checks and requests deny by default.

## Failures

A Harness startup error, readiness timeout, or initial-window failure keeps the local recovery window available for retry, opening the desktop log, or exit. Each attempt allows 60 seconds for module loading, endpoint discovery, and authenticated readiness together; first reads after installation can be substantially slower than later launches. This is a failure-detection limit, not a fixed startup delay. Timeout logs include a bounded, redacted child-stderr suffix; raw diagnostics never enter the recovery renderer. Startup cancellation and Harness shutdown each have bounded process waits. An `AbortError` caused by requested startup cancellation is silent; a child-exit timeout or other failure discovered after cancellation is reported once as a shutdown failure. Session-handler cleanup and close-subscriber failures are reported without escaping Electron's callback; diagnostic reporting failures are also contained.

## Model Experience

The Electron application adds no model-visible content. The desktop profile's [`@deepseek-ai/dsh-desktop-app`](../../packages/bundle/desktop-app/README.md) overlay disables the Web-surface prompt section and owns the loopback authorization guard.

## Windows installer development

`pnpm run desktop:package` builds the per-user x64 assisted installer, with a selectable directory and independent desktop, Start-menu, and login-startup choices. Packaging verifies the generated [PowerShell commands](../../scripts/desktop/generate-installer-powershell.ts) and [uninstall file operations](../../scripts/desktop/generate-installer-file-operations.ts) before building. The latter retain electron-builder's relocation and rollback algorithm with extended-length Windows paths; an upstream template change requires review before regeneration with `pnpm run desktop:generate-installer-file-operations`. See the [installer decision](../../.agents/notes/implemented/feature/2026-08-24-retryable-desktop-startup-and-uninstall-cleanup.md) for ownership and cleanup rules.

On Windows x64, after installing repository dependencies, build and verify the distributable from the repository root:

```powershell
pnpm run build
pnpm run desktop:package
pnpm run desktop:validate-package
```

The outputs under `.artifacts/desktop/installer/` are `DeepSeek-Harness-Setup-<version>-x64.exe`, its `.sha256`, and `release-metadata.json`. Give testers the setup EXE, not the executable inside `win-unpacked`. Double-clicking setup opens the assisted installer; its default destination is `%LOCALAPPDATA%\Programs\DeepSeek Harness`. Uninstall preserves Harness data and logs under `%APPDATA%\DeepSeek Harness` unless the user explicitly selects and confirms deletion. An unsigned build may trigger SmartScreen; checksum validation detects an altered download but does not establish publisher identity or replace signing approval.

Run lifecycle acceptance only on a disposable Windows account without an existing product installation. The suite authenticates isolated application-data paths, uses test-specific shortcuts and login registration, and refuses production identity collisions, but it still exercises the real per-user installer registry:

```powershell
$env:DSH_INSTALLER_E2E = '1'
try { pnpm run test:desktop:installer }
finally { Remove-Item Env:DSH_INSTALLER_E2E }
```

The suite checks startup without API credentials, option changes, running-application replacement using an older registered version, and both uninstall data choices. It does not substitute for disconnected-machine acceptance or upgrading from a separately built older release artifact.

The [Windows installer workflow](../../.github/workflows/desktop-installer.yml) runs the clean-install smoke for pull requests and the complete installer suite for master and `dsh-v*` pushes on a fresh hosted Windows runner. It retains package-validated EXE, checksum, and metadata files for 30 days, including when a later acceptance test fails; check the run's test result before using an artifact. This workflow has no signing credentials and does not publish a production release.

## Known Limitations

- **Installer qualification** — Windows lifecycle qualification is required before distribution; unsigned local builds can trigger SmartScreen. Automatic updates are not implemented.
- **Foreground window lifecycle** — there is no tray persistence or task-aware background policy; closing the last window exits on Windows and Linux.
- **Foundation UI** — the renderer is the existing Web client, not the planned Mission Control task overview, review mode, or Harness Studio.
- **Native integration** — deep links, native notifications, external-link handling, and persisted window placement are not implemented.
- **Crash recovery** — Main reports startup and shutdown failures but does not yet present task-aware recovery or restart the Harness after an abnormal runtime exit.
