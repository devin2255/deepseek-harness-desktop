# Task Overview UI Implementation Plan

English | [中文](2026-09-04-task-overview-ui.zh.md)

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement the tasks with test-first development and specification review before quality review.

**Goal:** Implement the desktop overview and its existing-conversation navigation under the [approved specification](../specs/2026-09-04-parallel-task-overview-design.md).

**Architecture:** The layout owns a transient home/conversation selection and an additive home slot. A desktop-only UI plugin derives task rows from the session and workspace snapshots, and routes interactions through existing session services. The runtime invalidates in-flight list responses across disconnects; Electron receives no new task API.

**Tech Stack:** Cordis plugins, TypeScript, React, CSS Modules, Vitest, and Playwright Electron.

## Task 1: Layout navigation and task presentation

Files: modify `packages/client/ui-layout/src/client/{index.ts,service.ts,stores.ts,AppFrame.tsx,AppFrame.module.css}` and the owning tests; update explicit navigation callbacks in `packages/client/ui-sidebar/src/client/index.ts` and `packages/client/ui-workspace/src/client/index.ts`. Add `packages/client/ui-task-overview/` with the standard package manifest, client aggregate reference, build configuration, empty Node apply, justified invariant companion, CSS declarations, and bilingual README. Its client files are `index.ts` (composition), `select-tasks.ts` (pure projection), `navigation.ts` (interaction resolution), `TaskOverview.tsx`, `TasksAction.tsx`, `locales.ts`, and `TaskOverview.module.css`. Register the package only in `packages/bundle/desktop-app/cordis.patch.yml` and its dependency manifest; ordinary Web has no new roster entry.

- [x] Add failing layout tests for initial home occupancy, ordinary Web fallback, explicit conversation navigation with unchanged session id, preserved mounted draft, hidden details on home, and slot disposal. Run `pnpm exec vitest run packages/client/ui-layout/tests` and confirm the new behavior fails.
- [x] Add this presentation state and action pair to the layout store, and forward the two actions through `ILayout` and `LayoutController`.

```typescript
type CenterPage = 'home' | 'conversation'
// Initial centerPage is 'home'; an unoccupied home slot renders conversation.
showHome: (draft: LayoutState) => { draft.centerPage = 'home' },
showConversation: (draft: LayoutState) => { draft.centerPage = 'conversation' },
```

- [x] Declare `shell.home` as a single root-scoped slot owned by the root registration. Supply its occupancy through an inject-bound framework hook. AppFrame renders both surfaces at fixed positions, using a hidden wrapper for the inactive surface; the active test is `panels.centerPage === 'home' && homeAvailable`. Home renders details at zero width without mutating the stored details preference. Sidebar and workspace user navigation explicitly call `showConversation`; no list-selection observer overrides the startup home page.
- [x] Add failing pure-selector tests covering pending priority, running descendants, ordinary forks, cycles, missing parents, archived and blank roots, registry membership rather than cwd matching, descending update time/id ordering, and unread completion remaining Other Tasks. Use this row projection, with the existing branded ids and workspace types.

```typescript
type TaskGroup = 'needs-you' | 'running' | 'other'
interface TaskRow {
  root: SessionSummary
  workspace: WorkspaceView | undefined
  group: TaskGroup
  descendants: readonly SessionSummary[]
  pending: readonly SessionSummary[]
  runningDescendants: number
}
```

- [x] Implement `selectTasks` as a pure function over SessionListState and WorkspaceListState. Roots come only from listed ids, excluding subagent origins, blank rows, and archived ids. Trace descendants only through uninterrupted subagent-origin parent links with cycle protection; ordinary forks terminate the chain. A pending root or descendant takes precedence over any running bit. Match a workspace by registry sessionIds, never cwd. Counts and copy explicitly say known descendants, not exhaustive inventory or success.
- [x] Add component tests before rendering code: three ordered sections with empty messages, title/workspace/state text, every known pending owner, explicit New Task workspace selection, stale/error/loading/empty distinctions, visible navigation failure, and no automatic approval or prompt. Use framework-derived props and existing theme/locale patterns.
- [x] Implement TasksAction in `sidebar.footer.action` and TaskOverview in `shell.home` through `slots.inject`; locale registrations and subscriptions use Cordis effects. Components use `useSessions`, `useWorkspaces`, and inject-bound Host-description hooks. Keep the directory-isolation notice visible. A list with failed/loading request state or absent Host description cannot be presented as synchronized; initial pending and synchronized empty have different copy.
- [x] Test root navigation, authoritative child navigation, missing-address catalog resolution, unavailable targets, settled interactions, and disposal while resolution is pending. Implement the child route by reading `sessions.subagentAddress(id)`, refreshing only the direct parent catalog when absent, then reading the authoritative address again; never synthesize an address from a title or parent id. Only successful target selection calls `layout.showConversation`. Render failures on the overview; actual answers remain in the existing conversation UI.
- [x] Run focused plugin, layout, sidebar, and workspace tests, then typecheck and bundle the affected packages. Update required service fakes and manifests without weakening their types. Review the new package's exports and asset inclusion.

## Task 2: Fresh baseline ownership and retry

Files: modify `packages/client/runtime/src/client/sessions/manager.ts`, `workspaces/manager.ts`, `workspaces/service.ts`, `index.ts`, `contract/sessions.ts`, `contract/workspaces.ts`, their focused tests, and required test-service doubles. Update the runtime README pair. Both metadata lists require generation invalidation because workspace membership and archive baselines also determine visible tasks.

- [x] Add a deferred-response regression proving that a list pull started before disconnect cannot finish synchronization after reconnection, overwrite newer rows, clear a newer error, or release the newer request's single-flight ownership. Run the focused manager tests and observe failure.
- [x] Give each list pull a captured generation. On disconnect invalidate that generation, clear the old single-flight/mutation ownership, publish loading while preserving rows, and leave pending-interaction cleanup in its existing owner. Guard success, failure, and finally blocks against obsolete generations. Reconnect starts a fresh pull; only its successful response returns request state to idle.

```typescript
const generation = this.listGeneration
// Immediately after awaiting the list response, and before catch/finally writes:
if (generation !== this.listGeneration) return
```

- [x] Expose the already implemented `refresh(): Promise<void>` on both outward list service interfaces and their test doubles. The overview retry invokes both owners; loading disables duplicate retry, and absent Host description disables offline retry. No UI component owns an HTTP list request or retry timer.
- [x] Verify initial failure, failure with retained rows, disconnect, obsolete success/failure, overlapping generations, and successful recovery. Run focused runtime tests and typecheck; no new durable field or model-visible content is introduced.

## Task 3: Assembled acceptance and delivery evidence

Files: add `apps/web/tests/task-overview.snapshot.ts` using the existing built-app harness and a desktop roster opt-in; update `apps/web/tests/assembled-boot.ts` only to support that explicit roster. Add desktop acceptance under `apps/desktop/tests/`, and snapshots in the owning application snapshot directory. Update the existing Mission Control proposal without marking the larger product implemented.

- [x] Build and boot the actual plugin graph, then pin a keyless visible journey: overview, root navigation, Tasks return, retained draft, known child attention and running groups, and normal Web without overview. Assert user-visible semantic output rather than internal classes.
- [x] Exercise the real Electron desktop profile with isolated temporary user data and disposable workspaces. Verify navigation, parallel execution, pending target routing, and disconnect/reconnect. Mock only the nondeterministic model boundary; do not use user working directories for file-writing acceptance.
- [x] Run `pnpm run test:gui`, `DSH_SNAPSHOT=replay pnpm run test:web`, the focused assembled snapshot, desktop acceptance, `pnpm run typecheck`, `pnpm run lint`, `pnpm run doc-sync`, and `git diff --check`. Record actual failures and distinguish source implementation from assembled/installer verification.
- [x] Review specification compliance, then code quality; fix findings and rerun affected checks. Record bilingual pairing after updating owned READMEs, this plan, and the proposed note. Commit scoped changes only after verification. Do not push, install, or generate a release EXE as an unrequested side effect.

## Acceptance status

Tasks 1 and 2 have source, focused-test and typecheck evidence. The built keyless assembled snapshot covers root navigation, Tasks return, retained drafts, known descendant activity and question routing, and ordinary Web fallback. Real Electron acceptance covers fresh-profile onboarding, the overview, New Task navigation, concurrent roots in separate disposable workspaces, root navigation while both remain Running, retained rows across a real transport disconnect and reconnect, authoritative navigation to a child that owns a pending question, secured transport, and process shutdown. The full Web replay run retains existing Windows failures from raw backslash fixture substitution, unavailable Bash and terminal inspection, `spawn pnpm ENOENT`, and shared settings state; the task-overview snapshot passes independently. This plan does not claim the complete desktop product, worktree isolation, installer verification, or release readiness.
