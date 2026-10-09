# Agent Note: Main-owned desktop window placement

Status: implemented

English | [中文](2026-10-10-desktop-window-placement.zh.md)

## Problem

Task supervision repeatedly closes and reopens the native window while Harness remains active. A fixed creation size loses the user's layout, and blindly restoring old coordinates can leave the application outside every attached display. Native geometry is a device preference, not a Task or Session fact.

## Decision

Electron Main owns a versioned normal rectangle and maximization preference in the product-data directory. The [desktop foundation](../architecture/2026-08-14-electron-desktop-foundation.md) retains process and authorization ownership; the preference adds no Renderer API, model input, or Session event. [Electron normal bounds](https://www.electronjs.org/docs/latest/api/browser-window#wingetnormalbounds) preserve the ordinary rectangle during maximization, minimization, and fullscreen. Only maximization is restored; transient modes never hide the next window.

Creation selects the current work area with the largest intersection with the saved rectangle. No intersection selects the primary display. Dimensions and the entire frame are clamped into that work area in device-independent pixels, including negative monitor coordinates. A work area smaller than the normal minimum lowers the native minimum to fit. Display information is read after Electron readiness for each recreation, not retained from a prior launch.

Before observation or maximization, Main applies the rectangle and reads the native result. Bounded feedback corrects measured frame and fractional-scale rounding, including the native minimum dimensions, without hardcoded DPI offsets. Constructor values alone are insufficient: native acceptance at 125% Windows scaling observes creation growth and a smaller setter discrepancy. A native window that cannot settle its requested rectangle is destroyed and reported through startup recovery rather than publishing a drifting preference.

The store accepts only a bounded, regular file with the exact version and fields. Read or parse failures are diagnosed without blocking startup. Native changes capture a detached value immediately and debounce publication through the existing atomic writer. One serialized writer publishes the latest captured state without an older write overtaking it. Window closure releases listeners and starts publication. Explicit shutdown captures live geometry, removes observers, and awaits publication before releasing the application mutex; late window events cannot enqueue more writes after that cleanup. Storage and diagnostic failures do not escape native callbacks or terminate Tasks.

## Alternatives considered

**Store geometry in Session events or Renderer storage.** The preference belongs to the device rather than one Task, and an authorized-window replacement receives a new Renderer. Main already owns native lifecycle, so another transport or task fact adds no useful authority.

**Restore the saved rectangle without current-display checks.** Removed monitors, changed scale, and reduced work areas can make the title bar unreachable. The current work area is authoritative for creation.

**Save only when the window closes.** Background operation and abrupt exit can bypass an ordinary close. Coalesced ongoing writes preserve the last published preference, while explicit shutdown owns final publication. Saving every movement synchronously instead would stall native dispatch and perform unnecessary disk writes.

## Consequences

Window recreation preserves the user's layout without starting another Harness. The bounded preference format rejects unsupported versions rather than maintaining compatibility shims. Atomic replacement prevents partial JSON from becoming the published file but does not promise power-loss durability; termination before publication can lose the latest layout. Fullscreen is intentionally not a remembered mode. Display adjustment applies when creating a window; this store does not reposition a live window during a native display change.

## Verification

Geometry and storage tests cover missing monitors, negative coordinates, reduced displays, invalid durable data, serialized writes, listener cleanup, and failures. The keyless built Electron journey snapshots disk publication, same-process reopening with one Harness, cold-start maximization, normal-size restoration, off-screen recovery, and diagnosed malformed preferences. Native acceptance is part of the Windows and macOS desktop lane; a run on one host does not qualify the other platform or a signed installer.
