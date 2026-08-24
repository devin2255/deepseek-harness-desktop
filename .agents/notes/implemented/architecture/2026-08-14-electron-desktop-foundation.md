# Agent Note: Electron desktop security and lifecycle foundation

Status: implemented

English | [中文](2026-08-14-electron-desktop-foundation.zh.md)

## Problem

The desktop application needs local process and window authority without letting model-rendered Renderer content gain Node, Electron IPC, or the Harness loopback capability. Electron lifecycle callbacks can arrive while startup is pending, and asynchronous window recreation can throw after an event callback has returned. A quit that waits indefinitely for `app.whenReady()` leaves Electron unable to terminate its owned startup.

## Decision

[`apps/desktop`](../../../../apps/desktop/README.md) owns the Electron Main foundation: it enables Chromium sandboxing before readiness, takes the single-instance lock, starts one desktop-profile Harness utility process only after readiness, and creates one authorized BrowserWindow from the settled loopback endpoint. Main owns process, window, and application lifecycle only; Harness plugins retain product and Session state.

The Renderer remains sandboxed with context isolation, disabled Node integration, and a frozen platform-only preload bridge. An isolated Electron session adds the per-launch Bearer capability exclusively to the owned renderer's exact HTTP and WebSocket loopback origin. Navigation, redirects, new windows, and permissions deny authority outside that origin.

The lifecycle treats startup cancellation as owned state rather than waiting for Electron readiness. `before-quit` aborts the startup signal, releases the startup readiness wait, waits for owned startup settlement, stops a ready Harness once, and repeats `app.quit()` under a latch. Every Electron callback reports contained failures; the macOS recreation promise catches both window creation and post-creation focus failures.

The built Electron acceptance test runs in the native Windows complete CI inventory after the repository build. Normal unit tests retain mocked Electron boundaries and do not launch Electron.

The broader [desktop agent mission control proposal](../../proposed/feature/2026-08-14-desktop-agent-mission-control.md) remains proposed; it owns task projection, worktree policy, and later product behavior rather than this shipped shell foundation.

## Alternatives considered

**Expose generic Electron or Node APIs to the Renderer.** A presentation-layer compromise would expose local machine authority and the launch capability to model-rendered content. The isolated session and narrow preload bridge preserve the authority split.

**Keep startup blocked on `app.whenReady()` during quit.** Electron cannot make readiness settle before quitting in every lifecycle ordering, so shutdown can deadlock. Startup cancellation releases the application-owned wait while still allowing a later Electron readiness promise to settle harmlessly.

**Run Electron under the ordinary unit-test suite.** Electron requires a native executable and test-specific user-data isolation, making it unsuitable for the source-only unit lane. The real application runs as a built acceptance test on the native Windows CI inventory.

## Consequences

The foundation has one clear owner for OS authority and proves its security posture against a real Electron process, including loopback authorization and renderer isolation. Its lifecycle waits for owned work to reach quiescence and reports callback failures instead of producing unhandled rejections.

Electron remains a native CI dependency, so the acceptance test runs in the non-blocking native Windows inventory rather than the Wine-based required Windows build lane. Tray persistence, task-aware quit choices, updates, and recovery policy remain outside this foundation.
