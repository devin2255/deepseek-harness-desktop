# Desktop Host Crash Recovery Implementation Plan

English | [中文](2026-09-21-desktop-host-crash-recovery.zh.md)

**Goal:** Detect an unexpected post-readiness Harness exit, revoke the dead runtime's desktop authority, and let the user start one fresh Host that reconstructs durable Tasks without replaying an unconfirmed tool call.

**Architecture:** The Harness supervisor publishes one immutable exit result on every ready handle. Electron Main owns recovery orchestration: an unexpected result retires native background presence and the authorized window, then opens the existing local recovery window. Recovery is explicit rather than automatic. A retry starts a new launch-scoped capability and relies on Session persistence to repair interrupted turns before Task projection resumes.

---

### Task 1: Publish the ready Harness exit result

**Files:**
- Modify: `apps/desktop/src/harness-supervisor.ts`
- Modify: `apps/desktop/tests/harness-supervisor.spec.ts`

- [x] **Step 1: Add failing supervisor tests**

Require a ready handle to expose one non-rejecting exit result carrying the utility-process exit code. Cover exit before and after `stop()`, repeated `stop()`, and listener cleanup.

- [x] **Step 2: Implement the exit result**

Resolve the result from the existing runtime exit listener. Keep startup failures on the startup promise and preserve the current bounded, idempotent stop behavior.

- [x] **Step 3: Verify the focused supervisor suite**

Run `pnpm exec vitest run apps/desktop/tests/harness-supervisor.spec.ts`.

### Task 2: Transfer a runtime crash into local recovery ownership

**Files:**
- Modify: `apps/desktop/src/window.ts`
- Modify: `apps/desktop/src/main-lifecycle.ts`
- Modify: `apps/desktop/src/startup-state.ts`
- Modify: `apps/desktop/tests/window.spec.ts`
- Modify: `apps/desktop/tests/main-lifecycle.spec.ts`
- Modify: `apps/desktop/tests/startup-state.spec.ts`

- [x] **Step 1: Add failing lifecycle tests**

Require an unexpected ready-Harness exit to dispose background presence, destroy the authorized desktop window, publish a redacted `service-exited` failure, and create exactly one local recovery window. Cover a closed desktop window, concurrent Quit, a late exit from a superseded attempt, recovery-window creation failure, and duplicate exit delivery.

- [x] **Step 2: Add explicit desktop-window destruction**

Expose only an idempotent `destroy()` operation backed by the owned `BrowserWindow`. Destruction must trigger the existing authorization disposal path and contained close callbacks.

- [x] **Step 3: Implement serialized crash recovery**

Observe the handle's exit result as soon as startup commits it. Ignore intentional stop, superseded attempts, and shutdown. For an unexpected exit, stop publishing stale activity, revoke the old renderer, expose the local failure surface, and retain the failed attempt until Retry or Exit resolves it.

- [x] **Step 4: Start a fresh authority only after explicit Retry**

Retry waits for crash cleanup, starts one new Harness with a new capability, and hands off only after authenticated readiness. Quit during recovery prevents any later window or process resurrection.

- [x] **Step 5: Verify the focused lifecycle suites**

Run `pnpm exec vitest run apps/desktop/tests/harness-supervisor.spec.ts apps/desktop/tests/main-lifecycle.spec.ts apps/desktop/tests/startup-state.spec.ts apps/desktop/tests/window.spec.ts`.

### Task 3: Prove durable Task recovery through the assembled application

**Files:**
- Modify: `apps/desktop/tests/desktop.e2e.ts`
- Modify: the smallest existing keyless Session or Task recovery example required for assembled evidence

- [x] **Step 1: Add a real-Electron crash scenario**

Create a disposable Task whose turn is in flight, terminate the owned Harness utility process without requesting desktop shutdown, and verify that the authorized task window is replaced by the recovery window.

- [x] **Step 2: Verify manual recovery semantics**

Confirm no Host restarts before Retry. After Retry, require a new authenticated renderer to show the same Task with its interrupted state, committed events intact, and no duplicate tool side effect.

- [x] **Step 3: Verify Renderer and background behavior**

Repeat the crash while the task window is closed and Harness is tray-owned. Require one recovery window and no notification or tray state derived from the dead Host.

- [x] **Step 4: Run assembled evidence**

Run the focused desktop E2E title, affected keyless snapshot, and persistence recovery tests.

### Task 4: Document and qualify the recovered lifecycle

**Files:**
- Modify: `apps/desktop/README.md`
- Modify: `apps/desktop/README.zh.md`
- Modify: `.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.md`
- Modify: `.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.zh.md`
- Modify this plan and its Chinese counterpart

- [x] **Step 1: Record the current recovery behavior**

Document the manual-retry decision, authority replacement, Task reconstruction, and the remaining limits without duplicating Session persistence internals.

- [x] **Step 2: Re-record the bilingual pairs**

Update each counterpart in one pass, then run `pnpm run verify-translation-pairing --write` for every changed pair.

- [x] **Step 3: Run release-proportional checks**

Run focused tests, affected snapshots, desktop real-Electron E2E, `pnpm run typecheck`, `pnpm run lint`, `pnpm run doc-sync`, `pnpm run build`, `git diff --check`, and the repository pre-push workflow.

- [ ] **Step 4: Commit and push the complete recovery slice**

Require main CI and the Windows installer matrix before treating abnormal-Host recovery as shipped.
