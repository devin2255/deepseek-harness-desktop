# Task Review And Delivery Implementation Plan

English | [中文](2026-09-13-task-review-delivery.zh.md)

**Goal:** Give every isolated root Task a complete review and delivery workspace with bounded file summaries and diffs, explicit Commit, safe Apply, revision requests, and recoverability-aware Discard.

**Architecture:** `@deepseek-ai/dsh-task-review` defines a Host-only capability seam. `@deepseek-ai/dsh-task-review-local` implements it through the managed subprocess service and Git, while `host-apiproxy` owns authorization, Task lifecycle validation, and durable event writes. Review data is generated on demand from the recorded `TaskWorktreeAssignment`; only delivery receipts enter the Session log. `@deepseek-ai/dsh-client-ui-task-review` renders a separate review mode through Client slots. Electron Main and the Renderer receive no filesystem or Git authority.

**Safety:** Read operations are output- and time-bounded. Commit never changes the source checkout. Apply requires a committed task delivery, serializes by canonical repository, revalidates the source HEAD and clean status, runs a three-way check before mutation, and fails without touching the source when preflight detects a conflict. Discard is explicit, reports whether uncommitted data is recoverable, preserves committed task branches, and never guesses which directory or branch belongs to the application.

---

## Task 1: Define the review capability and wire vocabulary

**Files:**

- Create: `packages/task/task-review/package.json`
- Create: `packages/task/task-review/tsconfig.json`
- Create: `packages/task/task-review/src/types.ts`
- Create: `packages/task/task-review/src/index.ts`
- Create: `packages/task/task-review/src/invariant.ts`
- Create: `packages/task/task-review/tests/service.spec.ts`
- Create: `packages/task/task-review/tests/invariant.spec.ts`
- Create: `packages/task/task-review/README.md`
- Create: `packages/task/task-review/README.zh.md`
- Create: `packages/task/task-review/README.i18n.yaml`
- Modify: `packages/task/README.md`
- Modify: `packages/task/README.zh.md`

- [ ] **Step 1: Write failing Service Definition tests**

Define branded review snapshot and operation identities. Model `TaskReviewSummary`, `TaskReviewFile`, `TaskFileDiff`, `TaskCommitReceipt`, `TaskApplyReceipt`, and `TaskDiscardReceipt` as immutable wire-safe values. File states cover added, modified, deleted, renamed, copied, type-changed, untracked, and conflicted entries. Binary and truncated diffs remain explicit instead of being represented as empty text.

The service exposes `summarize`, `diff`, `commit`, `apply`, and `discard`. Every method receives the whole recorded worktree assignment and an optional abort signal. Mutation requests carry the exact expected review revision; stale review state fails instead of applying a newer filesystem state than the user reviewed.

- [ ] **Step 2: Confirm RED**

Run: `pnpm exec vitest run packages/task/task-review/tests`

Expected: FAIL because the package and service do not exist.

- [ ] **Step 3: Implement the Service Definition and invariant companion**

Use branded opaque ids, discriminated errors, complete JSDoc, declaration merging for `ctx.taskReview`, effect-owned registration, and package-owned runtime invariants. Do not embed Git commands, UI labels, or deployment defaults in the Service Definition.

- [ ] **Step 4: Confirm GREEN and commit**

Run: `pnpm exec vitest run packages/task/task-review/tests`

Commit: `feat(task): define task review capability`

## Task 2: Implement bounded local review snapshots and file diffs

**Files:**

- Create: `packages/task/task-review-local/package.json`
- Create: `packages/task/task-review-local/tsconfig.json`
- Create: `packages/task/task-review-local/src/config.ts`
- Create: `packages/task/task-review-local/src/git.ts`
- Create: `packages/task/task-review-local/src/index.ts`
- Create: `packages/task/task-review-local/src/invariant.ts`
- Create: `packages/task/task-review-local/tests/review.spec.ts`
- Create: `packages/task/task-review-local/tests/invariant.spec.ts`
- Create: `packages/task/task-review-local/README.md`
- Create: `packages/task/task-review-local/README.zh.md`
- Create: `packages/task/task-review-local/README.i18n.yaml`

- [ ] **Step 1: Write real-Git RED tests**

Use disposable repositories to cover committed changes after the assignment base, staged and unstaged tracked changes, untracked text, rename, delete, binary content, empty review, path traversal rejection, an unavailable or diverged worktree, output truncation, cancellation, and Git failure. The source checkout must remain byte-for-byte and status-for-status unchanged.

- [ ] **Step 2: Implement read-only inspection**

Resolve Git once through `ctx.subprocess`. Verify the assignment against Git's live worktree registry before every operation. Build the file list from NUL-delimited Git output and untracked-file enumeration. Generate one requested path's patch only after exact membership and repository-relative path validation. Hash the normalized review inputs into a revision so mutation calls can reject stale reviews. No method reads arbitrary user-supplied absolute paths.

- [ ] **Step 3: Confirm GREEN and commit**

Run: `pnpm exec vitest run packages/task/task-review-local/tests/review.spec.ts packages/task/task-review-local/tests/invariant.spec.ts`

Commit: `feat(task): inspect isolated task changes`

## Task 3: Implement Commit, preflighted Apply, and explicit Discard

**Files:**

- Modify: `packages/task/task-review-local/src/git.ts`
- Modify: `packages/task/task-review-local/src/index.ts`
- Create the delivery mutation test in the local Provider's `tests/` directory.
- Modify: `packages/task/task-review-local/README.md`
- Modify: `packages/task/task-review-local/README.zh.md`

- [ ] **Step 1: Write mutation RED tests**

Commit stages the exact reviewed Task worktree and creates one Git commit without moving or modifying the source checkout. It fails clearly for an empty change set, missing Git identity, stale review revision, diverged assignment, or Git failure.

Apply consumes a recorded task commit. It requires a clean source checkout, verifies the canonical repository and expected source HEAD, produces the binary patch from the recorded base through the task commit, runs `git apply --check --3way --index` with batch stdin, then applies the same bytes only while the repository lock still owns the unchanged source state. A preflight conflict leaves the source HEAD, index, files, and status unchanged.

Discard reports the precise loss class before mutation. With explicit confirmation it removes only the registered managed worktree; a committed branch remains recoverable. Dirty uncommitted content is never described as recoverable. Failure preserves the directory and diagnostics.

- [ ] **Step 2: Implement serialized mutations**

Serialize all mutations per canonical repository. Bound command time, output, stdin patch size, and termination grace through validated config. Never invoke a shell. Return complete receipts with commit ids, source-before/source-after ids, branch retention, and cleanup outcome.

- [ ] **Step 3: Confirm GREEN and commit**

Run: `pnpm exec vitest run packages/task/task-review-local/tests`

Commit: `feat(task): deliver reviewed worktree changes`

## Task 4: Make delivery state durable and unforgeable

**Files:**

- Modify: `packages/task/task/src/types.ts`
- Modify: `packages/task/task/src/fold.ts`
- Modify: `packages/task/task/src/service.ts`
- Modify: `packages/task/task-session/src/index.ts`
- Modify: `packages/task/task-session/src/aggregate.ts`
- Modify: `packages/task/task/tests`
- Modify: `packages/task/task-session/tests`
- Modify: `packages/core/session/src/known-event-types.ts`
- Modify: `docs/subsystems/task.md`
- Modify: `docs/subsystems/task.zh.md`

- [ ] **Step 1: Write durable transition RED tests**

Add whole-value events for committed delivery, source application, and discard. Receipts include the review revision and exact Git object ids required for recovery. Generic `task.review` can request changes or declare readiness but cannot forge Git-backed terminal states. Replays reject invalid ordering, mismatched Task ids, reassignment, malformed object ids, and terminal actions while descendants run.

- [ ] **Step 2: Implement compare-and-set Task mutations**

Expose dedicated `recordCommit`, `recordApply`, and `recordDiscard` methods. Validate current Task projection and append exactly one event after the Provider operation succeeds. Aggregation derives ready and settled state from durable receipts rather than a user-selectable label.

- [ ] **Step 3: Regenerate event projections and commit**

Run: `pnpm run gen-scoped-events`

Run: `pnpm run gen-persistence-catalog`

Run: `pnpm exec vitest run packages/task/task/tests packages/task/task-session/tests`

Commit: `feat(task): record review delivery receipts`

## Task 5: Expose authorized Host APIs and both SDK projections

**Files:**

- Modify: `packages/host/apiproxy/src/api/tasks.ts`
- Modify: `packages/host/apiproxy/src/api/tasks.schema.ts`
- Modify: `packages/host/apiproxy/src/api/rpc-map.ts`
- Modify: `packages/host/apiproxy/src/api/rpc.schema.ts`
- Modify: `packages/host/apiproxy/src/api-proxy.ts`
- Modify: `packages/host/apiproxy/tests/tasks-api.spec.ts`
- Modify: `packages/sdk/protocol/src/types.ts`
- Modify: `packages/sdk/client/src/client.ts`
- Modify: `packages/sdk/server/src/server.ts`
- Modify: `packages/sdk/client/tests`
- Modify: `packages/sdk/server/tests`
- Modify: `python/sdk/src/deepseek_harness`
- Modify: `python/sdk/tests/test_client.py`

- [ ] **Step 1: Write Host and SDK RED tests**

Add `task.reviewSummary`, `task.reviewDiff`, `task.commit`, `task.apply`, and `task.discard`. Host resolves the root Task and its recorded assignment, rejects direct-workspace tasks, validates lifecycle preconditions, calls the Provider, then records the returned receipt. Cancellation and structured Provider errors survive transport without leaking command lines or full filesystem diagnostics.

- [ ] **Step 2: Implement the Host consumer and both SDKs**

The TypeScript and Python SDKs project the same request and response vocabulary. No SDK performs Git operations or derives review state locally.

- [ ] **Step 3: Confirm GREEN and commit**

Run: `pnpm exec vitest run packages/host/apiproxy/tests/tasks-api.spec.ts packages/sdk/client/tests packages/sdk/server/tests`

Run: `uv run --project python/sdk pytest`

Commit: `feat(host): expose task review delivery`

## Task 6: Add the client review object and separate Review workspace

**Files:**

- Modify: `packages/client/connection/src/client/api.ts`
- Modify: `packages/client/connection/src/client/fixture.ts`
- Modify: `packages/client/runtime/src`
- Create: `packages/client/ui-task-review/package.json`
- Create: `packages/client/ui-task-review/tsconfig.json`
- Create the client entrypoint, `TaskReview.tsx`, its CSS module, and locales under the new package's `src/client/` directory.
- Create: `packages/client/ui-task-review/src/invariant.ts`
- Create: `packages/client/ui-task-review/tests/review.client.spec.tsx`
- Modify: `packages/client/ui-task-overview/src/client/TaskOverview.tsx`
- Modify: `packages/bundle/web-app/cordis.patch.yml`
- Modify: `packages/bundle/web-app/package.json`

- [ ] **Step 1: Write pure-props and runtime RED tests**

The overview opens Review for reviewing, ready, or settled isolated Tasks. The Review workspace presents a file tree, unified diff, criteria and risks, verification evidence, branch and base facts, and distinct Request Changes, Commit, Apply, and Discard actions. Loading, empty, stale, conflict, truncated, binary, success, and retry states remain visible and keyboard reachable. Destructive confirmation states explain branch and uncommitted-data recoverability.

- [ ] **Step 2: Implement slots and runtime actions**

Keep state in the Client runtime and invoke only typed Host APIs. Refresh after every mutation and transport reconnection. Preserve the selected file when still present. Do not render raw ANSI, untrusted HTML, or arbitrary filesystem links.

- [ ] **Step 3: Confirm GREEN and commit**

Run: `pnpm exec vitest run packages/client/runtime/tests packages/client/ui-task-review/tests packages/client/ui-task-overview/tests`

Commit: `feat(client): review and deliver task changes`

## Task 7: Assemble, document, and prove the public loop

**Files:**

- Modify: `apps/web/tests/task-review.snapshot.ts`
- Modify: `apps/desktop/tests/desktop.e2e.ts`
- Modify: `packages/bundle/desktop-app/tests/desktop-app.spec.ts`
- Modify: `apps/desktop/README.md`
- Modify: `apps/desktop/README.zh.md`
- Modify: `docs/architecture.md`
- Modify: `docs/architecture.zh.md`
- Add: `.agents/notes/implemented/feature/2026-09-13-task-review-delivery.md`
- Add: `.agents/notes/implemented/feature/2026-09-13-task-review-delivery.zh.md`
- Add: `.agents/notes/implemented/feature/2026-09-13-task-review-delivery.i18n.yaml`

- [ ] **Step 1: Write assembled RED acceptance**

The keyless Web scenario opens a review-ready Task, selects files, requests changes, commits, applies, and displays durable receipts. Electron acceptance creates a disposable real repository and isolated Task, writes text and binary changes through the Task worktree, reviews them, commits, applies into the clean source checkout, reloads the Renderer, and proves the applied receipt survives. A second scenario proves conflict preflight leaves the source checkout unchanged; a third proves explicit Discard cleanup and branch retention.

- [ ] **Step 2: Mount both Host packages and the Client plugin**

Mount `task-review-local` after subprocess and task-worktree providers, and before `host-apiproxy`. Mount the Client Review plugin after runtime, layout, slots, and task overview dependencies.

- [ ] **Step 3: Regenerate owned artifacts**

Run: `pnpm run gen-cordis-catalog`

Run: `pnpm run gen-config-catalog`

Run: `pnpm run gen-module-graph`

Run: `pnpm run gen-scoped-events`

Run: `pnpm run gen-persistence-catalog`

- [ ] **Step 4: Run release-proportional verification**

Run focused JS/TS and Python suites for every changed package, the keyless Web snapshot, and Electron E2E. Then run `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run doc-sync`, and `git diff --check`.

- [ ] **Step 5: Commit the assembled loop**

Commit: `feat(desktop): ship task review and delivery`
