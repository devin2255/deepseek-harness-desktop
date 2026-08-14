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

Main enables Chromium's sandbox before readiness and acquires Electron's single-instance lock. The owning instance waits for `app.whenReady()`, starts exactly one Harness with the `desktop` profile on a random loopback port, waits for its canonical readiness line, and then creates one authorized window. Native close clears Main's window ownership so later events never call a stale handle. A second launch restores and focuses a live window without starting another Harness; on macOS, it recreates and focuses a closed window with the existing Harness authority.

The first explicit quit aborts pending Harness startup, waits for startup ownership to settle, stops a ready Harness once, and then repeats `app.quit()` under a latch. A shutdown failure is reported but cannot prevent the final quit. Closing the last window quits on Windows and Linux; on macOS, activation recreates a missing window with the existing Harness authority.

## Security

- Main generates a 32-byte per-launch capability and passes it only to the Harness process and the isolated Electron session. The session adds `Authorization: Bearer <capability>` only for the exact settled HTTP and WebSocket origin and only for the owned renderer.
- The capability is absent from renderer and preload APIs, URLs, DOM state, Web storage, logs, settings, and Session events. Direct loopback clients without the header receive `401`.
- The renderer runs with `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true`. Its frozen preload bridge exposes only `deepseekDesktop.platform`; it exposes no generic IPC, process, filesystem, shell, environment, or capability access.
- Navigation and redirects stay on the settled origin, every new-window request is denied, and renderer permission checks and requests deny by default.

## Failures

A Harness startup error, readiness timeout, or initial-window failure is reported, cleans up any owned Harness or partial window state, and quits. Startup cancellation and Harness shutdown each have bounded process waits. An `AbortError` caused by requested startup cancellation is silent; a child-exit timeout or other failure discovered after cancellation is reported once as a shutdown failure. Session-handler cleanup and close-subscriber failures are reported without escaping Electron's callback; diagnostic reporting failures are also contained.

## Model Experience

The Electron application adds no model-visible content. The desktop profile's [`@deepseek-ai/dsh-desktop-app`](../../packages/bundle/desktop-app/README.md) overlay disables the Web-surface prompt section and owns the loopback authorization guard.

## Known Limitations

- **Source-checkout execution** — this slice does not provide packaged installers, code signing, release provenance, or automatic updates.
- **Foreground window lifecycle** — there is no tray persistence or task-aware background policy; closing the last window exits on Windows and Linux.
- **Foundation UI** — the renderer is the existing Web client, not the planned Mission Control task overview, review mode, or Harness Studio.
- **Native integration** — deep links, native notifications, external-link handling, and persisted window placement are not implemented.
- **Crash recovery** — Main reports startup and shutdown failures but does not yet present task-aware recovery or restart the Harness after an abnormal runtime exit.
