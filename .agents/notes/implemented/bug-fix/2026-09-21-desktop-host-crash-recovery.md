# Agent Note: Desktop Host crash recovery

Status: implemented

English | [中文](2026-09-21-desktop-host-crash-recovery.zh.md)

## Problem

Electron Main supervised Harness startup and intentional shutdown but did not retain an observable result for a utility process that exited after readiness. A dead Host could leave an authorized Renderer and native background presentation attached to unavailable authority, while an automatic restart could conceal an interrupted turn or repeat a tool action whose outcome was not confirmed.

## Decision

Extending the [retryable desktop startup decision](../feature/2026-08-24-retryable-desktop-startup-and-uninstall-cleanup.md), every ready Harness handle exposes one immutable, non-rejecting exit result. Electron Main observes that result immediately, distinguishes intentional teardown from an unexpected exit, and serializes one recovery operation for the owning startup attempt.

Unexpected exit revokes the authorized Task window, disposes its close subscription and native background presence, records only the attempt id and native exit code, and presents the local startup window in a `service-exited` failure state. Recovery also covers a Task window still loading, startup handoff in progress, a natively closed window, and Quit overtaking delayed recovery-window creation. A late window from the failed attempt is destroyed before it can receive ownership.

Restart remains an explicit user action. Retry waits for process and background cleanup but does not wait for an indefinitely delayed window creation from the failed attempt. It supersedes that attempt and starts one fresh Harness with a new capability. Late exit or window completion from an older attempt cannot affect the replacement.

The [semantic Session checkpoint decision](2026-07-21-semantic-session-checkpoints.md) remains the authority for interrupted work. Cold repair closes unmatched tool calls with synthetic risk-classified results and ends the turn as `interrupted`. Task projection exposes that durable marker as a non-actionable run failure owned by the exact Session; it does not reconstruct process-local question attention or replay the tool call.

## Alternatives considered

**Restart Harness automatically.** This shortens the visible outage but can hide the failure and make a resumed workflow appear to have continuous authority. Explicit Retry keeps the user in control and makes the interruption visible before any new model or tool work starts.

**Keep the existing Renderer open during restart.** Its isolated session carries the dead process's launch capability and origin authorization. Reusing it would retain stale authority and blur ownership between processes, so recovery destroys it and creates a newly authorized Renderer only after readiness.

**Persist pending question promises and resume the exact tool call.** The promise and abort signal are process-local, while the Session log already has a general crash-repair rule for unmatched calls. A second durable question store would compete with Session replay and could duplicate a side effect; recovery therefore projects the interrupted turn instead.

## Consequences

The user sees a stable local recovery surface after foreground or tray-owned Host failure, and no Host restarts before explicit Retry. Each replacement receives a new launch capability, while durable Tasks, worktree assignments, delivery receipts, and completed events survive through ordinary Session persistence.

Focused supervisor, startup-state, window, and lifecycle tests pin process ownership and race behavior. The real Electron acceptance path kills the utility process in both foreground and tray-owned states, verifies no automatic restart, retries into a new authorization, proves prior Tasks remain present, checks that the interrupted tool call becomes one durable failure without another provider dispatch, and confirms dead-Host tray and notification state is released.

Recovery is local application behavior, not an operating-system relaunch service. Power loss or machine restart is repaired on the next ordinary launch. Signing, automatic updates, and platform launch integration remain separate release capabilities.
