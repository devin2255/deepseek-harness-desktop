# Task Overview List-Request State Implementation Plan

English | [中文](2026-09-04-task-overview-list-state.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose existing list request activity and errors to the overview's framework data feed.

**Architecture:** Preserve the SessionManager as the request owner and project its existing state and error into SessionListState. No new request loop, persisted state, connection machine, or renderer is introduced.

**Tech Stack:** TypeScript, Cordis, Vitest, existing client runtime.

## Scope and continuation

This is the first prerequisite of the approved [overview specification](../specs/2026-09-04-parallel-task-overview-design.md), not the whole overview implementation. Subsequent implementation plans cover descendant grouping and attention targets, layout navigation and the desktop plugin, then keyless assembled snapshots and Electron acceptance. Transport disconnection is not inferred from list request state; the connection generation must be integrated separately before presenting rows as live.

## Task 1: Project list request state without changing request behavior

Files: modify `packages/client/runtime/src/client/sessions/service.ts`, `packages/client/runtime/tests/sessions-service.client.spec.ts`, and existing typed SessionListState fixtures under `packages/client/**/tests/` and `packages/test-support/client-runtime/src/sessions.ts`. If typechecking identifies another literal, update only that literal's required fields, not its behavior.

- [x] Add the regression below inside the existing list projection describe block; use the existing bench, feedList, err, and deferred helpers. Confirm the error code against the current RpcError union before running.

```typescript
it('keeps the ready list when a later refresh fails', async () => {
  const b = bench()
  await feedList(b, [{ id: 's1', running: true }])
  const failure = { code: 'internal' as const, message: 'list unavailable', details: {} }
  b.api.onList = () => Promise.resolve(err(failure))
  await b.svc.refresh()
  await Promise.resolve()
  expect(b.svc.list.getSnapshot()).toMatchObject({
    phase: 'ready', state: 'error', error: failure, ids: ['s1'],
  })
  await feedList(b, [{ id: 's1', running: false }])
  expect(b.svc.list.getSnapshot()).toMatchObject({
    phase: 'ready', state: 'idle', error: null,
  })
})
```

- [x] Add assertions for the initial `pending/idle/null` state, an in-flight deferred request (`loading/null`), first-request failure (`pending/error`), a genuine empty success (`ready/idle/null`), and loading while retaining an existing row. Subscribe to the public list store and assert the new request state is observable without changing the selected session.

- [x] Run `pnpm exec vitest run packages/client/runtime/tests/sessions-service.client.spec.ts`. Expected: the new assertions fail because state/error are absent; existing assertions remain passing.

- [x] Import the existing SessionListSnapshot type from the same manager module already imported by service.ts and add these required fields to SessionListState.

```typescript
/** List request activity; independent of initial baseline arrival. */
state: SessionListSnapshot['state']
/** Latest failed list request; null after a new request starts or succeeds. */
error: SessionListSnapshot['error']
```

- [x] Extend the runtime's initial list object with these values.

```typescript
ids: [], byId: {}, current: undefined, phase: 'pending', state: 'idle', error: null,
```

- [x] Project the exact manager fields in projectList, preserving all existing row derivation and selection logic.

```typescript
const {
  items, current, phase, state, error, subagentsByParent, jobsBySession, currentAddress,
} = this.manager.getListSnapshot()
```

```typescript
this.list.set({ ids, byId, current, phase, state, error, subagentsByParent, jobsBySession, currentAddress })
```

- [x] Extend idle typed fixtures with `state: 'idle', error: null`. Fixtures that deliberately represent an error or an in-flight request use `state: 'error'` with their RpcError or `state: 'loading', error: null`. Do not make the fields optional, cast away errors, or manufacture defaults in consumers.

- [x] Run the focused runtime suite and `pnpm run typecheck`; resolve only missing fixture fields introduced by this required-field change. Run affected fixture-owner component suites. The snapshot is read-only information and introduces no user-visible strings; assembled overview snapshots remain required when the UI is implemented.

## Task 2: Record the read semantics and verify

Files: update the bilingual `packages/client/runtime/README.md` pair and the existing bilingual Mission Control proposal at `.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.md`. Update a subsystem reference only if it already describes this type; do not hand-edit generated regions. Maintain the paired records for these files and this plan.

- [x] Document this exact distinction in the runtime README: `phase` tracks whether a first baseline ever arrived; `state` tracks the latest list request; `error` carries that request's failure. A ready list can have a failed refresh and retained rows; idle is not evidence of an active transport.
- [x] Keep the Mission Control proposal proposed and state only that request-state projection is available; task overview, transport freshness, worktrees, and review remain separate delivery requirements.
- [x] Run named translation pairing checks, `pnpm run doc-sync`, `pnpm run lint`, and `git diff --check`. Record actual failures without claiming the overview complete.
- [x] Review specification compliance before code quality. Commit only the scoped files after review; do not push or package an EXE for a data-only prerequisite.

## Review checklist

The implementation is accepted only when all specified request states are visible through the same list source, failed refresh preserves rows and selection, all typed fixtures compile, and no request, persistence, model, or renderer behavior changes. Overall overview acceptance remains governed by the linked specification.
