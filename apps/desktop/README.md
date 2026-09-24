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

Main enables Chromium's sandbox before readiness and acquires Electron's single-instance lock. On Windows, it also holds an installer-visible mutex through a PowerShell child; macOS and Linux use only Electron's lock and do not launch that Windows helper. After `app.whenReady()`, the owning instance creates the local startup window, starts exactly one Harness with the `desktop` profile on a random loopback port, and hands off to the authorized main window only after authenticated readiness. Native close releases the old window's isolated-session authorization before a tray action or second launch recreates and focuses a window with the existing Harness authority; it never starts another Harness.

Closing the last window leaves Harness and native background presence running on every desktop platform. An explicit quit with no active Task performs bounded cleanup immediately. Running Tasks or unavailable activity open a native choice: continue in the background hides the current window, stop and quit disposes background presence before stopping Harness, and cancel changes nothing. Concurrent quit requests share one decision. Installer replacement and startup-recovery exit bypass this prompt but retain bounded cleanup. After cleanup, an authenticated installer replacement uses `app.exit(0)` so a Renderer close handler cannot keep program files live; every other exit continues through `app.quit()`. A shutdown failure is reported but cannot prevent the final quit.

## Background tasks and notifications

Electron Main polls authenticated `task.list` and `session.list` projections in serialized two-second intervals with a separate ten-second request timeout. The first live baseline is silent. Later values update one tray summary with active Task, Agent, and attention counts; a failed request marks freshness unavailable, retains the last counts, and retries without overlapping requests. Main stores only detached presentation values, never another durable Task record.

New actionable attention, failed transitions, and transitions from a running tree to ready or settled state create native notifications. Clicking a notification restores or recreates the authorized window and opens its exact owner Session, including a subagent. Main sends only a non-blank bounded Session id over the named one-way preload event; the client waits for its authoritative catalogs and uses the same Task navigation controller as an overview click. A missing target opens Tasks with a readable error, and a later successful or superseding navigation clears it.

## Security

The installer close helper uses the same Electron user-data directory as ordinary startup. After validating the sole `--installer-request-close` argument, it sends an explicit single-instance notification and exits without composing Harness or windows. Packaged Windows tests authenticate their appData and home overrides before either launch mode acquires the lock; test metadata is removed from argument classification only after validation. The isolated Electron home keeps CLI dotenv loading inside the fixture without changing native Windows profile environment variables.

- Main generates a 32-byte per-launch capability and passes it only to the Harness process and the isolated Electron session. The session adds `Authorization: Bearer <capability>` only for the exact settled HTTP and WebSocket origin and only for the owned renderer.
- The capability is absent from renderer and preload APIs, URLs, DOM state, Web storage, logs, settings, and Session events. Direct loopback clients without the header receive `401`.
- The renderer runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true`. Its frozen preload bridge exposes only `deepseekDesktop.platform` and `onOpenSession(listener)` over the validated Main-owned event; it exposes no generic IPC, process, filesystem, shell, environment, or capability access.
- Navigation and redirects stay on the settled origin, every new-window request is denied, and renderer permission checks and requests deny by default.

## Failures

A Harness startup error, readiness timeout, or initial-window failure keeps the local recovery window available for retry, opening the desktop log, or exit. Each attempt allows 60 seconds for module loading, endpoint discovery, and authenticated readiness together; first reads after installation can be substantially slower than later launches. This is a failure-detection limit, not a fixed startup delay. Timeout logs include a bounded, redacted child-stderr suffix; raw diagnostics never enter the recovery renderer. Startup cancellation and Harness shutdown each have bounded process waits. An `AbortError` caused by requested startup cancellation is silent; a child-exit timeout or other failure discovered after cancellation is reported once as a shutdown failure. Session-handler cleanup and close-subscriber failures are reported without escaping Electron's callback; diagnostic reporting failures are also contained.

An unexpected Harness exit after readiness revokes the old Renderer authorization, destroys any authorized Task window, disposes native background presence, and presents the local recovery window. Main never restarts the Host automatically. Retry starts one new Harness with a new launch capability; cold Session recovery closes an interrupted turn and Task projection exposes the interruption as a durable, non-actionable failure instead of replaying an unconfirmed tool call.

## Model Experience

The Electron application adds no model-visible content. The desktop profile's [`@deepseek-ai/dsh-desktop-app`](../../packages/bundle/desktop-app/README.md) overlay disables the Web-surface prompt section and owns the loopback authorization guard.

## Parallel task workspaces

The Tasks screen creates a root Session in an application-owned Git worktree by default. The selected Workspace remains the project identity shown in the UI, while the Task projection records the exact source path, execution path, branch, base commit, source HEAD, and source-dirty digest in the Session log. Two tasks created from one repository receive different worktree paths and branches from the same committed base; creating them does not copy uncommitted source changes or modify the source checkout.

Isolation requires an accessible Git repository root with a committed `HEAD`, a supported non-nested layout, Git on `PATH`, and sufficient free space under the Harness home. Preflight and creation failures stop Session creation. The recovery panel offers an isolation retry and an explicit direct-project choice with a write-risk warning; it never changes to direct mode silently. A recorded worktree is verified against Git's live registry before reuse, and a missing or diverged path fails closed.

## Task review and delivery

An isolated Task in review, ready, or settled state opens in a separate Review workspace. It shows the recorded source and worktree identities, acceptance criteria, risks, bounded file summaries, and a unified diff for the selected text file. Binary files and truncated output are labeled explicitly. The Renderer obtains these values through typed Host APIs and receives no direct filesystem or Git authority.

Request Changes returns the Task to active work without claiming a delivery result. Commit stages the exact displayed worktree state and creates a commit on the Task branch without changing the source checkout. Apply requires that recorded commit, the reviewed revision, a clean source checkout, and its exact current `HEAD`; it runs a three-way preflight before applying the same patch to the source index and working tree. A conflict, stale revision, moved source, or dirty source fails before mutation. Apply deliberately leaves the source `HEAD` unchanged so the user can inspect and commit the staged result.

Discard always requires an explicit confirmation. Dirty uncommitted content is described as unrecoverable and requires acknowledgement; a committed Task branch remains available after its managed worktree is removed. Commit, Apply, and Discard receipts are Session events, so their exact Git identities and recovery facts survive Renderer reload and cold replay.

## Windows installer development

`pnpm run desktop:package` builds the per-user x64 assisted installer, with a selectable directory and independent desktop, Start-menu, and login-startup choices. Packaging verifies the generated [PowerShell commands](../../scripts/desktop/generate-installer-powershell.ts) and [uninstall file operations](../../scripts/desktop/generate-installer-file-operations.ts) before building. Shortcut ownership inspection reads the Shell Link target through `IShellLinkW` or its bounded stored LinkInfo or RelativePath fields, including when the target no longer exists; WScript and Shell automation remain fallbacks, and only an exact old-or-new executable target authorizes deletion. The exact-process query uses 64-bit PowerShell through `Sysnative`, because the 32-bit NSIS host cannot inspect a running x64 application's module path. The file-operation generator retains electron-builder's relocation and rollback algorithm with extended-length Windows paths; an upstream template change requires review before regeneration with `pnpm run desktop:generate-installer-file-operations`. See the [installer decision](../../.agents/notes/implemented/feature/2026-08-24-retryable-desktop-startup-and-uninstall-cleanup.md) for ownership and cleanup rules.

On Windows x64, after installing repository dependencies, build and verify the distributable from the repository root:

```powershell
pnpm run build
pnpm run desktop:package
pnpm run desktop:validate-package
```

The outputs under `.artifacts/desktop/installer/` are `DeepSeek-Harness-Setup-<version>-x64.exe`, its `.sha256`, `release-metadata.json`, and `latest.yml`. The packaged `resources/app-update.yml` pins the GitHub provider to `devin2255/deepseek-harness-desktop`; package and release validation require that identity and verify `latest.yml` against the exact installer SHA-512. Give testers the setup EXE, not the executable inside `win-unpacked`. Double-clicking setup opens the assisted installer; its default destination is `%LOCALAPPDATA%\Programs\DeepSeek Harness`. Uninstall preserves Harness data and logs under `%APPDATA%\DeepSeek Harness` unless the user explicitly selects and confirms deletion. Release validation reads the PE certificate directory directly for unsigned artifacts and requires Windows Authenticode trust validation whenever a certificate is present. An unsigned build may trigger SmartScreen; checksum validation detects an altered download but does not establish publisher identity or replace signing approval.

Run lifecycle acceptance only on a disposable Windows account without an existing product installation. The suite authenticates isolated application-data paths, uses test-specific shortcuts and login registration, and refuses production identity collisions, but it still exercises the real per-user installer registry:

```powershell
$env:DSH_INSTALLER_E2E = '1'
try { pnpm run test:desktop:installer }
finally { Remove-Item Env:DSH_INSTALLER_E2E }
```

The suite checks startup without API credentials, option changes, running-application replacement using an older registered version, and both uninstall data choices. It does not substitute for disconnected-machine acceptance or upgrading from a separately built older release artifact.

The [Windows installer workflow](../../.github/workflows/desktop-installer.yml) runs the complete installer suite for pull requests, master, and `dsh-v*` pushes on a fresh hosted Windows runner. It retains package-validated EXE, checksum, and metadata files for 30 days, including when a later acceptance test fails; check the run's test result before using an artifact. This workflow has no signing credentials and does not publish a production release.

## macOS arm64 test packaging

On an Apple Silicon Mac with `pnpm` on `PATH`, after `pnpm install` and `pnpm run build`, `pnpm run desktop:package:macos:unsigned` builds the desktop runtime, stages its production dependencies, and creates arm64 DMG and ZIP files under `.artifacts/desktop/installer/`. It verifies the app executable architecture, required Main and preload files, disk image integrity, and ZIP integrity. The command rejects signing credentials and is intended for test packages only.

The [macOS arm64 workflow](../../.github/workflows/desktop-macos.yml) runs the real Electron acceptance test before packaging, then mounts the DMG, copies its application into a temporary installation directory, and checks installed-app startup and loopback authorization before retaining the unsigned archives for 30 days. These files are not a production release: the workflow does not verify Gatekeeper behavior, sign or notarize the app, or publish an update feed. The [Mac qualification decision](../../.agents/notes/implemented/testing/2026-09-23-macos-arm64-desktop-package-qualification.md) records the separation from production publication.

The [production desktop release workflow](../../.github/workflows/desktop-release.yml) is a separate manual operation from a selected `dsh-v<version>` tag reachable from `master`. Its protected `desktop-release` environment must provide `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`. It requires valid Authenticode on both the installer and installed application, repeats the complete installer matrix, creates GitHub build provenance, and only then publishes the EXE, checksum, release metadata, and `latest.yml` as GitHub Release assets. Selecting the workflow with `publish` disabled performs no release job.

## Known Limitations

- **Installer qualification** — Windows lifecycle qualification is required before distribution; unsigned local builds can trigger SmartScreen, while production publication requires the protected signing environment and an explicit manual decision. The Windows update source and manifest are packaged, but the application does not check, download, or install updates yet. macOS Gatekeeper qualification, signing, and notarization are not implemented.
- **Task integration** — task overview, root-task worktree isolation, review, Commit, conflict-safe Apply, and recoverability-aware Discard are available. Child-writer worktrees, automatic reconciliation between concurrent writers, Task archival, and Harness Studio are not implemented.
- **Native integration** — task-aware tray presence and completion or attention notifications are available. Deep links, external-link handling, and persisted window placement are not implemented.
- **Crash recovery** — runtime exit recovery is explicit and local. The application does not relaunch itself after a machine restart or power loss; the next ordinary launch performs cold Session repair.
