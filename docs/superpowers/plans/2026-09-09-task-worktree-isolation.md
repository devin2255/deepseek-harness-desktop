# Task Worktree Isolation Implementation Plan

English | [中文](2026-09-09-task-worktree-isolation.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a workspace-backed writing task run in an application-owned Git worktree while preserving its source Workspace identity and recoverable Git facts in the root Session log.

**Architecture:** `@deepseek-ai/dsh-task-worktree` defines a task-specific worktree service, `@deepseek-ai/dsh-task-worktree-local` implements it with the managed subprocess service and directories below `DSH_HOME`, and Host API Proxy consumes it from `session.create`. A new whole-value `task/worktree-assigned` Session event records the original Workspace, base commit, branch, isolated path, and source-checkout status digest; Task projection prefers that durable Workspace identity over ordinary cwd membership. Electron Main and the Renderer receive no filesystem or Git authority.

**Tech Stack:** TypeScript, Cordis services and effects, managed subprocesses, Git porcelain output, Session events, Zod wire validation, Vitest, React client plugins, keyless Web snapshots, Electron Playwright acceptance.

---

### Task 1: Define the Task Worktree capability

**Files:**
- Create: `packages/task/task-worktree/package.json`
- Create: `packages/task/task-worktree/tsconfig.json`
- Create: `packages/task/task-worktree/src/index.ts`
- Create: `packages/task/task-worktree/src/invariant.ts`
- Create: `packages/task/task-worktree/tests/service.spec.ts`
- Create: `packages/task/task-worktree/tests/invariant.spec.ts`
- Modify: `packages/task/README.md`
- Modify: `packages/task/README.zh.md`

- [x] **Step 1: Write the failing Service Definition tests**

Define the wished-for public API in the test before the package exists:

```ts
const request = {
  taskId: SessionId('task-1'),
  workspaceId: WorkspaceId('workspace-1'),
  workspacePath: repository,
}
const created = await ctx.taskWorktrees.create(request)
expect(created).toMatchObject({
  taskId: request.taskId,
  workspaceId: request.workspaceId,
  sourcePath: repository,
  kind: 'git-worktree',
  sourceDirty: false,
})
```

Also assert the stable error codes `WORKTREE_NOT_GIT`, `WORKTREE_NESTED_REPOSITORY`, `WORKTREE_UNBORN_HEAD`, `WORKTREE_INSUFFICIENT_SPACE`, `WORKTREE_TARGET_OCCUPIED`, `WORKTREE_BRANCH_OCCUPIED`, `WORKTREE_GIT_FAILED`, and `WORKTREE_UNAVAILABLE`.

- [x] **Step 2: Run the tests and confirm RED**

Run: `pnpm exec vitest run packages/task/task-worktree/tests`

Expected: FAIL because `@deepseek-ai/dsh-task-worktree` does not exist.

- [x] **Step 3: Implement the Service Definition**

Export these exact public values:

```ts
export interface TaskWorktreeAssignment {
  readonly kind: 'git-worktree'
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly sourcePath: string
  readonly path: string
  readonly branch: string
  readonly baseCommit: string
  readonly sourceHead: string
  readonly sourceDirty: boolean
  readonly sourceStatusDigest: string
  readonly createdAt: number
}

export interface CreateTaskWorktreeRequest {
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly workspacePath: string
}

export abstract class TaskWorktreeService extends Service {
  abstract create(request: CreateTaskWorktreeRequest, signal?: AbortSignal): Promise<TaskWorktreeAssignment>
  abstract inspect(assignment: TaskWorktreeAssignment, signal?: AbortSignal): Promise<'available' | 'missing' | 'diverged'>
}
```

`TaskWorktreeError` carries one stable code from the list above. The invariant asserts that `ctx.taskWorktrees` is mounted when the package is configured.

- [x] **Step 4: Run the tests and confirm GREEN**

Run: `pnpm exec vitest run packages/task/task-worktree/tests`

Expected: PASS.

- [x] **Step 5: Commit the capability definition**

```powershell
git add packages/task/task-worktree packages/task/README.md packages/task/README.zh.md
git commit -m "feat(task): define task worktree capability"
```

### Task 2: Implement the local Git worktree Provider

**Files:**
- Create: `packages/task/task-worktree-local/package.json`
- Create: `packages/task/task-worktree-local/tsconfig.json`
- Create: `packages/task/task-worktree-local/src/config.ts`
- Create: `packages/task/task-worktree-local/src/git.ts`
- Create: `packages/task/task-worktree-local/src/index.ts`
- Create: `packages/task/task-worktree-local/src/invariant.ts`
- Create: `packages/task/task-worktree-local/tests/local.spec.ts`
- Create: `packages/task/task-worktree-local/tests/invariant.spec.ts`
- Create: `packages/task/task-worktree-local/README.md`
- Create: `packages/task/task-worktree-local/README.zh.md`
- Create: `packages/task/task-worktree-local/README.i18n.yaml`
- Modify: `packages/task/README.md`
- Modify: `packages/task/README.zh.md`

- [x] **Step 1: Write real-Git failing tests**

Create disposable repositories and assert:

```ts
const assignment = await ctx.taskWorktrees.create({ taskId, workspaceId, workspacePath: repository })
expect(await readFile(join(assignment.path, 'tracked.txt'), 'utf8')).toBe('base\n')
expect(git(repository, ['status', '--porcelain=v1'])).toBe('')
expect(await ctx.taskWorktrees.inspect(assignment)).toBe('available')
```

Separate tests prove that two task ids produce separate branches and paths, uncommitted source changes are neither copied nor modified, nested repositories and unborn HEADs fail loudly, occupied deterministic targets are preserved, insufficient configured free space fails before Git mutation, and a failed Git add preserves diagnostics and any partial directory.

- [x] **Step 2: Run the Provider tests and confirm RED**

Run: `pnpm exec vitest run packages/task/task-worktree-local/tests`

Expected: FAIL because the Provider is absent.

- [x] **Step 3: Implement fail-closed preflight and creation**

Resolve configuration before use:

```ts
export interface Config {
  dshHome?: string
  minFreeBytes: number
  gitCommand: string
  commandTimeoutMs: number
  terminateGraceMs: number
  maxOutputBytes: number
}
```

Defaults are `resolveDshHome()`, 512 MiB, `git`, 30 seconds, 2 seconds, and 1 MiB. Use `ctx.subprocess.resolveExecutable` and `ctx.subprocess.spawn`; never invoke a shell. Before `git worktree add`, require the selected Workspace path to equal `git rev-parse --show-toplevel`, reject a non-empty `--show-superproject-working-tree`, require a forty-hex `HEAD`, hash `git status --porcelain=v1 -z` with SHA-256, and check `statfs.availableBlocks * blockSize`. Derive the branch and path from SHA-256 hashes of the canonical repository and Task id:

```ts
const branch = `dsh/task-${digest(taskId).slice(0, 24)}`
const path = join(home, 'worktrees', 'v1', digest(sourcePath).slice(0, 24), digest(taskId).slice(0, 24))
```

Serialize create calls per canonical repository. Create only with `git worktree add -b <branch> <path> <baseCommit>`. Do not delete a partial path or branch after a failure. `inspect` parses `git worktree list --porcelain -z` and returns `available` only when path, branch, and HEAD all match the durable assignment.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run: `pnpm exec vitest run packages/task/task-worktree-local/tests`

Expected: PASS on Windows and POSIX; platform-specific permission probes may skip only with an explicit OS predicate.

- [x] **Step 5: Commit the Provider**

```powershell
git add packages/task/task-worktree-local packages/task/README.md packages/task/README.zh.md
git commit -m "feat(task): create local task worktrees"
```

### Task 3: Record and project the execution Workspace

**Files:**
- Modify: `packages/task/task/src/types.ts`
- Modify: `packages/task/task/src/fold.ts`
- Modify: `packages/task/task/src/index.ts`
- Modify: `packages/task/task/src/service.ts`
- Modify: `packages/task/task/tests/fold.spec.ts`
- Modify: `packages/task/task/tests/types.spec.ts`
- Modify: `packages/task/task-session/src/aggregate.ts`
- Modify: `packages/task/task-session/src/index.ts`
- Modify: `packages/task/task-session/tests/aggregate.spec.ts`
- Modify: `packages/task/task-session/tests/runtime.spec.ts`
- Modify: `docs/subsystems/task.md`
- Modify: `docs/subsystems/task.zh.md`

- [x] **Step 1: Write failing durable replay tests**

Append a complete assignment event and prove strict replay plus Workspace grouping:

```ts
session.append({ type: 'task/worktree-assigned', data: { assignment } })
expect(applyTaskEvent(emptyTaskFoldState(), session.events.at(-1)!)).toMatchObject({ assignment })
expect(provider.snapshot().tasks[0]).toMatchObject({ workspaceId, executionWorkspace: assignment })
```

Malformed commit ids, digests, branch refs, timestamps, extra fields, duplicate assignment, and reassignment after execution must fail with the exact event sequence. Unknown merge-extensible events remain unchanged.

- [x] **Step 2: Run the Task tests and confirm RED**

Run: `pnpm exec vitest run packages/task/task/tests packages/task/task-session/tests`

Expected: FAIL because the event and projection field are absent.

- [x] **Step 3: Add the durable event and mutation**

Add `executionWorkspace?: TaskWorktreeAssignment` to `TaskSnapshot` and `assignment?: TaskWorktreeAssignment` to `TaskFoldState`. Declare the event through `SessionEventMap`:

```ts
'task/worktree-assigned': {
  assignment: TaskWorktreeAssignment
}
```

Add `TaskService.assignWorktree(sessionId, { assignment, expectedSeq })`. The Session Provider validates that the target is a root, the assignment Task id matches it, the referenced Workspace exists, the event is the first assignment, and `expectedSeq` matches before appending exactly one event. Aggregation uses the assignment's `workspaceId`; cwd-based Workspace membership remains the fallback for direct tasks.

- [x] **Step 4: Run focused tests and confirm GREEN**

Run: `pnpm exec vitest run packages/task/task/tests packages/task/task-session/tests`

Expected: PASS.

- [x] **Step 5: Commit durable assignment projection**

```powershell
git add packages/task/task packages/task/task-session docs/subsystems/task.md docs/subsystems/task.zh.md
git commit -m "feat(task): record isolated execution workspaces"
```

### Task 4: Make Host session creation request isolation explicitly

**Files:**
- Modify: `packages/host/apiproxy/src/api/sessions.ts`
- Modify: `packages/host/apiproxy/src/api/sessions.schema.ts`
- Modify: `packages/host/apiproxy/src/api/rpc.ts`
- Modify: `packages/host/apiproxy/src/api/rpc.schema.ts`
- Modify: `packages/host/apiproxy/src/api/tasks.schema.ts`
- Modify: `packages/host/apiproxy/src/api-proxy.ts`
- Modify: `packages/host/apiproxy/tests/api-proxy-workspace.spec.ts`
- Modify: `packages/host/apiproxy/tests/tasks-api.spec.ts`
- Modify: `packages/host/apiproxy/tests/rpc-schemas.spec.ts`

- [x] **Step 1: Write failing Host behavior tests**

Assert that `session.create({ workspaceId, isolation: 'worktree' })` calls the worktree service before Session creation, creates the Session with the isolated cwd, records the assignment, returns it, and leaves the source Workspace untouched. Assert that `isolation: 'direct'` retains current attachment behavior. A missing worktree service or preflight failure returns `workspace-isolation-unavailable` and never creates a Session; the Host never silently changes the requested mode.

- [x] **Step 2: Run the Host tests and confirm RED**

Run: `pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-workspace.spec.ts packages/host/apiproxy/tests/tasks-api.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts`

Expected: FAIL because `isolation` is rejected by the strict request schema.

- [x] **Step 3: Implement the Host consumer**

Extend the request and response:

```ts
create(request: RpcRequest<{
  workspaceId?: WorkspaceId
  cwd?: string
  sessionId?: SessionId
  agentPreset?: string
  isolation?: 'direct' | 'worktree'
}>): Promise<RpcResponse<{
  sessionId: SessionId
  agentPreset?: string
  executionWorkspace?: TaskWorktreeAssignment
}>>
```

`worktree` requires `workspaceId` and `ctx.taskWorktrees`; it allocates the Session id first, creates the Git worktree, starts the Session at `assignment.path`, then calls `ctx.tasks.assignWorktree`. Direct creation keeps the existing Workspace attachment. Any failure after Git creation reports the preserved path in redacted structured details and never removes it automatically.

- [x] **Step 4: Run the Host tests and confirm GREEN**

Run the command from Step 2.

Expected: PASS.

- [x] **Step 5: Commit Host integration**

```powershell
git add packages/host/apiproxy
git commit -m "feat(host): create sessions in task worktrees"
```

### Task 5: Expose isolation through both SDKs and the client runtime

**Files:**
- Modify: `packages/sdk/sdk/src/client.ts`
- Modify: `packages/sdk/sdk/src/types.ts`
- Modify: `packages/sdk/sdk/tests/client.spec.ts`
- Modify: `packages/sdk/sdk/tests/expected-api.ts`
- Modify: `python/deepseek_harness/client.py`
- Modify: `python/deepseek_harness/types.py`
- Modify: `python/tests/test_client.py`
- Modify: `python/tests/expected_api.py`
- Modify: `packages/client/runtime/src/client/contract/workspaces.ts`
- Modify: `packages/client/runtime/src/client/workspaces/manager.ts`
- Modify: `packages/client/runtime/src/client/workspaces/service.ts`
- Modify: `packages/client/runtime/tests/workspaces-service.client.spec.ts`

- [ ] **Step 1: Write failing SDK and client tests**

Prove both SDKs serialize `isolation: 'worktree'`, parse the assignment, and expose it without path rewriting. Prove `WorkspaceRuntime.connectWorkspace(id, 'worktree')` never reuses a direct blank Session and `connectWorkspace(id, 'direct')` preserves current reuse.

- [ ] **Step 2: Run the tests and confirm RED**

Run: `pnpm exec vitest run packages/sdk/sdk/tests packages/client/runtime/tests/workspaces-service.client.spec.ts`

Run: `python -m pytest python/tests/test_client.py`

Expected: FAIL because the request and response types do not carry isolation.

- [ ] **Step 3: Implement both SDK and runtime projections**

Use the same discriminants and field names as Host. No client infers Git state. The client defaults only the desktop task-creation action to `worktree`; reusable APIs require an explicit mode so Web/automation callers do not change behavior accidentally.

- [ ] **Step 4: Run both suites and confirm GREEN**

Run the two commands from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit the consumers**

```powershell
git add packages/sdk python packages/client/runtime
git commit -m "feat(client): request isolated task sessions"
```

### Task 6: Add the desktop task-creation recovery flow

**Files:**
- Modify: `packages/client/ui-task-overview/src/client/TaskOverview.tsx`
- Modify: `packages/client/ui-task-overview/src/client/TaskOverview.module.css`
- Modify: `packages/client/ui-task-overview/src/client/locales.ts`
- Modify: `packages/client/ui-task-overview/tests/overview.client.spec.tsx`
- Modify: `packages/client/ui-workspace/src/client/WorkspacePicker.tsx`
- Modify: `packages/client/ui-workspace/src/client/locales.ts`
- Modify: `packages/client/ui-workspace/tests/workspace-picker.client.spec.tsx`
- Modify: `packages/client/connection/src/client/fixture.ts`

- [ ] **Step 1: Write failing component tests**

The Tasks empty state and New Task action select a Workspace and request `worktree`. When Host returns `workspace-isolation-unavailable`, show the exact safe choices “Retry isolation” and “Use project directly”; do not retry as direct until the user selects it. The task card and header label an assigned path as `Worktree` and keep the original Workspace title.

- [ ] **Step 2: Run the component tests and confirm RED**

Run: `pnpm exec vitest run packages/client/ui-task-overview/tests packages/client/ui-workspace/tests/workspace-picker.client.spec.tsx`

Expected: FAIL because the isolation actions and recovery state are absent.

- [ ] **Step 3: Implement the visible flow**

Keep Git diagnostics in Host-provided user-safe text. The UI sends only the Workspace id and explicit mode; it never receives a generic path or process API. Keyboard focus moves into the error panel and returns to the triggering action after a successful retry.

- [ ] **Step 4: Run the component tests and confirm GREEN**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit the desktop flow**

```powershell
git add packages/client/ui-task-overview packages/client/ui-workspace packages/client/connection
git commit -m "feat(desktop): create isolated tasks by default"
```

### Task 7: Assemble, document, and verify the public loop

**Files:**
- Modify: `packages/bundle/web-app/cordis.patch.yml`
- Modify: `packages/bundle/web-app/package.json`
- Modify: `apps/web/tests/task-overview.snapshot.ts`
- Modify: `apps/web/tests/snapshots/task-overview/groups.expected.json`
- Modify: `apps/desktop/tests/desktop.e2e.ts`
- Modify: `apps/desktop/README.md`
- Modify: `apps/desktop/README.zh.md`
- Modify: `docs/architecture.md`
- Modify: `docs/architecture.zh.md`
- Create: `.agents/notes/implemented/feature/2026-09-09-application-owned-task-worktrees.md`
- Create: `.agents/notes/implemented/feature/2026-09-09-application-owned-task-worktrees.zh.md`

- [ ] **Step 1: Write failing assembled acceptance**

The keyless scenario creates two isolated task sessions from one disposable Git Workspace and records each Task row's original Workspace id, distinct path, branch, clean base, and unchanged source checkout. Electron acceptance reloads the Renderer and confirms both rows and worktree identities survive.

- [ ] **Step 2: Run assembled tests and confirm RED**

Run: `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/task-overview.snapshot.ts`

Run: `pnpm --filter @deepseek-ai/dsh-desktop test:e2e`

Expected: FAIL because the bundle does not mount the local Provider and fixtures cannot create isolated sessions.

- [ ] **Step 3: Mount and document the complete capability**

Mount `task-worktree-local` on the Host plane after `subprocess-local` and before `host-apiproxy`. Update architecture and desktop limitations to state that application-owned root-task worktrees are available while child-writer integration, Apply, Commit, and Discard remain owned by the review slice. Add the implemented Agent Note with alternatives, failure preservation, source-checkout guarantees, and exact test tiers.

- [ ] **Step 4: Regenerate owned artifacts**

Run:

```powershell
pnpm run gen-cordis-catalog
pnpm run gen-config-catalog
pnpm run gen-module-graph
pnpm run gen-scoped-events
pnpm run gen-persistence-catalog
```

Expected: generated sources include both worktree packages and `task/worktree-assigned`.

- [ ] **Step 5: Run release-proportional verification**

Run:

```powershell
pnpm exec vitest run packages/task/task-worktree/tests packages/task/task-worktree-local/tests packages/task/task/tests packages/task/task-session/tests packages/host/apiproxy/tests packages/client/runtime/tests packages/client/ui-task-overview/tests packages/client/ui-workspace/tests packages/sdk/sdk/tests
python -m pytest python/tests
pnpm run test:snapshot -- -t "task worktree"
pnpm run build
pnpm run typecheck
pnpm run doc-sync
git diff --check
```

Expected: every command passes; any environment-only memory failure is reported separately and does not support a passing claim.

- [ ] **Step 6: Commit the assembled public loop**

```powershell
git add packages/bundle apps docs .agents/notes packages/task packages/host packages/client packages/sdk python
git commit -m "feat(desktop): ship isolated task worktrees"
```
