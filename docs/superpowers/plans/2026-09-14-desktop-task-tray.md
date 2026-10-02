# Desktop Task Tray Implementation Plan

English | [中文](2026-09-14-desktop-task-tray.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep active local Tasks running after the last window closes, expose their authoritative state in a native tray, and deliver actionable completion and attention notifications.

**Architecture:** Electron Main consumes the existing authenticated `task.list` and `session.list` projections through a read-only polling observer; it never accepts Task state from Renderer and never creates another durable Task store. A native background-presence controller owns Tray, quit confirmation, and Notification instances. A named one-way Main-to-preload event carries only a validated Session id so the existing Task navigation controller opens the exact root or subagent.

**Tech Stack:** Electron, TypeScript, Host API Proxy schemas, React client plugins, Vitest, and Playwright Electron.

---

### Task 1: Read-only authoritative Task observer

**Files:**
- Create: `apps/desktop/src/task-observer.ts`
- Test: `apps/desktop/tests/task-observer.spec.ts`
- Modify: `apps/desktop/package.json`

- [x] **Step 1: Write failing observer tests**

Cover authenticated `task.list` and `session.list` requests, task-tree running counts, actionable-attention identities, first-baseline silence, transition notifications, no overlapping polls, transient failure recovery, disposal during a request, and malformed-response rejection. The observable value is detached presentation data:

```typescript
interface DesktopTaskState {
  readonly activeTaskCount: number
  readonly activeAgentCount: number
  readonly attentionCount: number
  readonly notifications: readonly DesktopTaskNotification[]
  readonly freshness: 'live' | 'unavailable'
}

interface DesktopTaskNotification {
  readonly key: string
  readonly kind: 'attention' | 'complete' | 'failed'
  readonly taskId: string
  readonly ownerSessionId: string
  readonly title: string
  readonly body: string
}
```

- [x] **Step 2: Verify behavioral failure before implementing the observer**

Run `pnpm exec vitest run apps/desktop/tests/task-observer.spec.ts`; after establishing the minimum exported API, require the authentication, running-count, or transition assertion to fail before implementing that behavior.

- [x] **Step 3: Implement the authenticated observer**

Subclass the existing API Proxy client only to map `/api/*` requests onto the settled Harness endpoint and add `Authorization: Bearer <capability>`. Poll interval and request timeout are separate required positive options. Each serialized poll reads both validated lists, maps running Session ids through each Task's root and descendants, and emits a frozen derived state. The first successful baseline creates no notification; later new actionable attention ids, failed transitions, and transitions from a running tree to review-ready or settled state create one notification key. Derive notifications only from live Task rows, retaining the last live observations for unavailable rows. Aggregate freshness is unavailable if a request fails or a row is not live; request failure retains the last counts. Retain transition keys across transient request failures and retry after the configured positive interval.

- [x] **Step 4: Verify observer behavior**

Run `pnpm exec vitest run apps/desktop/tests/task-observer.spec.ts`; expect all cases to pass without timers or requests left active.

- [x] **Step 5: Commit the observer**

Commit `apps/desktop/src/task-observer.ts`, its focused test, and explicit package dependencies as `feat(desktop): observe authoritative task activity`.

### Task 2: Native background-presence controller

**Files:**
- Create: `apps/desktop/src/background-presence.ts`
- Test: `apps/desktop/tests/background-presence.spec.ts`
- Modify: the existing icon generator and copied build assets to provide a Windows ICO and macOS template PNG with its Retina counterpart

- [x] **Step 1: Write failing controller tests**

Pin one Tray instance, localized running/attention summary, Open and Quit actions, double-click restoration, notification suppression before the first live baseline, notification click routing, unavailable-state copy, idempotent disposal, and contained native callback failures.

- [x] **Step 2: Verify behavioral failure before implementing the controller**

Run `pnpm exec vitest run apps/desktop/tests/background-presence.spec.ts`; after establishing the minimum exported API, require the native ownership or notification assertion to fail before implementing that behavior.

- [x] **Step 3: Implement Tray and Notification ownership**

The controller accepts only these application actions and the observer factory:

```typescript
interface BackgroundPresenceActions {
  readonly openSession: (sessionId?: string) => Promise<void>
  readonly requestQuit: () => void
  readonly reportFailure: (error: unknown) => void
}
```

Create Tray after Electron readiness, rebuild its menu from each derived observer value, and create native Notifications only for transition records. A notification click invokes `openSession(ownerSessionId)`; a tray click without a target restores or recreates the main window. Disposal stops the observer, removes native listeners, destroys Tray once, and prevents late request settlement from creating notifications.

- [x] **Step 4: Verify controller behavior**

Run `pnpm exec vitest run apps/desktop/tests/background-presence.spec.ts`; expect every ownership and failure-containment case to pass.

- [x] **Step 5: Commit the controller**

Commit the controller, tests, and generated tray asset when needed as `feat(desktop): add task-aware background presence`.

### Task 3: Window lifecycle and explicit quit protection

**Files:**
- Modify: `apps/desktop/src/main-lifecycle.ts`
- Modify: `apps/desktop/src/main.ts`
- Modify: `apps/desktop/src/window.ts`
- Create: `apps/desktop/src/desktop-ipc.ts`
- Modify: `apps/desktop/tests/main-lifecycle.spec.ts`
- Modify: `apps/desktop/tests/main-entry.spec.ts`
- Modify: `apps/desktop/tests/window.spec.ts`

- [x] **Step 1: Add failing lifecycle tests**

Require Windows and macOS to retain Harness and background presence after the last window closes; Open must recreate one authorized window. Explicit Quit with live state and no running task cleans up immediately. With running tasks or unavailable state, Continue in Background hides the window and keeps Harness, Stop and Quit performs the existing bounded stop, and Cancel changes nothing. Unavailable-state confirmation states that current activity cannot be confirmed rather than presenting the retained count as live. Concurrent quit attempts share one confirmation. Installer-close and startup-recovery Exit bypass confirmation and still guarantee bounded cleanup.

- [x] **Step 2: Verify the lifecycle tests fail under quit-on-close behavior**

Run `pnpm exec vitest run apps/desktop/tests/main-lifecycle.spec.ts apps/desktop/tests/window.spec.ts`; expect Windows close and active-task quit cases to fail.

- [x] **Step 3: Integrate background presence**

Create background presence only after authenticated Harness readiness and dispose it before stopping Harness. Replace Windows/Linux quit-on-last-window with background retention. Add `show()`, `hide()`, and a named `openSession(sessionId)` operation to `DesktopWindow`; restoration shows a hidden window, and a closed window queues the target until the authorized replacement has loaded. Define the one-way channel in `desktop-ipc.ts`. Keep forced cleanup separate from user-requested quit confirmation so installer and failure recovery cannot be blocked by a dialog.

- [x] **Step 4: Verify lifecycle and entry behavior**

Run `pnpm exec vitest run apps/desktop/tests/main-lifecycle.spec.ts apps/desktop/tests/main-entry.spec.ts apps/desktop/tests/window.spec.ts`; expect all cases to pass and existing startup/shutdown guarantees to remain intact.

- [x] **Step 5: Commit lifecycle integration**

Commit the lifecycle composition as `feat(desktop): keep active tasks running in tray`.

### Task 4: Exact notification navigation

**Files:**
- Modify: `apps/desktop/src/desktop-ipc.ts`
- Modify: `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/global.d.ts`
- Modify: `apps/desktop/tests/preload.spec.ts`
- Create: `packages/client/ui-task-overview/src/client/desktop-navigation.ts`
- Modify: `packages/client/ui-task-overview/src/client/index.ts`
- Modify: `packages/client/ui-task-overview/src/client/TaskOverview.tsx`
- Test: `packages/client/ui-task-overview/tests/desktop-navigation.client.spec.ts`
- Modify: `packages/client/ui-task-overview/README.md`
- Modify: `packages/client/ui-task-overview/README.zh.md`

- [x] **Step 1: Add failing preload and client tests**

Require the frozen preload bridge to expose only `platform` and `onOpenSession(listener)`, validate a non-empty bounded Session id before invoking listeners, retain only the latest target until subscription, and return an idempotent disposer. Require the overview plugin to queue the latest target until its authoritative catalogs are ready, route each delivered id through `createTaskNavigation`, including authoritative subagent resolution, and dispose subscriptions with its Cordis effect. Test early delivery, reload, supersession, and disposal while catalogs load.

- [x] **Step 2: Verify tests fail before the named channel exists**

Run `pnpm exec vitest run apps/desktop/tests/preload.spec.ts packages/client/ui-task-overview/tests/desktop-navigation.client.spec.ts`; expect the bridge and navigation assertions to fail.

- [x] **Step 3: Implement the one-way bridge**

Expose no `send`, `invoke`, or raw `ipcRenderer`. Main sends only validated ids from the Host projection. The client treats bridge absence as ordinary Web behavior and sends received ids through the same navigation controller used by overview clicks. A plugin-owned presentation source records notification-navigation failure; its slot hook renders the failure in the overview alert and shows Home, without changing the selected Session or creating a business-state store. A successful or superseding attempt clears the presentation failure.

- [x] **Step 4: Verify bridge behavior and package types**

Run the focused tests plus `pnpm exec tsc -b packages/client/ui-task-overview/tsconfig.json` and `pnpm --filter @deepseek-ai/dsh-desktop typecheck`; expect all to pass.

- [x] **Step 5: Commit notification navigation**

Commit the named IPC and client consumer as `feat(desktop): open notification task targets`.

### Task 5: Assembled acceptance, documentation, and release evidence

**Files:**
- Modify: `apps/desktop/tests/desktop.e2e.ts`
- Modify: `apps/desktop/README.md`
- Modify: `apps/desktop/README.zh.md`
- Modify: `.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.md`
- Modify: `.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.zh.md`
- Modify this plan and its Chinese counterpart

- [x] **Step 1: Add failing real-Electron acceptance**

Use the existing disposable task-overview fixture to run two root tasks, close the only window, prove both remain active, reopen through Tray, trigger a pending child question, click its native notification, and verify the exact child conversation opens. Cover Continue in Background, Cancel, and Stop and Quit through the real dialog path. Never read or write the user's checkout.

- [x] **Step 2: Verify the new acceptance fails before assembled integration**

Run the focused desktop E2E title under `pnpm --filter @deepseek-ai/dsh-desktop test:e2e`; expect failure at background retention or notification navigation.

- [x] **Step 3: Complete current-state documentation**

Document native background behavior, polling freshness, notification transitions, exact navigation, forced installer cleanup, and limitations in the desktop README pair. Update the Mission Control note without claiming Harness Studio, updates, signing, macOS packaging, or child-writer integration. Mark completed plan steps only after their listed evidence exists.

- [x] **Step 4: Run proportionate verification**

Run focused unit/component tests, desktop real-Electron E2E, affected snapshots, `pnpm run typecheck`, `pnpm run lint`, `pnpm run doc-sync`, `pnpm run build`, `git diff --check`, and the repository pre-push checks. Re-record every edited bilingual pair explicitly.

- [ ] **Step 5: Commit and push the completed slice**

Commit docs and acceptance as `test(desktop): verify task-aware tray lifecycle`, push the stacked branch, and require Windows installer plus main CI evidence before treating this slice as complete.
