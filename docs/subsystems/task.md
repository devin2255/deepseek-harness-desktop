# Root task projection

English | [中文](task.zh.md)

The task capability turns a root Session and its uninterrupted subagent descendants into one desktop work item. Its application-owned execution worktree, acceptance criteria, evidence, risks, and review decisions remain in the root Session log. Runtime activity and attention are generation-scoped inputs and are never reconstructed as durable facts.

## Durable facts

Five whole-value Session events define the persistent record: `task/worktree-assigned`, `task/defined`, `task/criterion-updated`, `task/risk-recorded`, and `task/review-decided`. The worktree event records one immutable source Workspace, base commit, source status digest, application branch, and execution directory. The strict fold rejects reassignment, malformed Git identities, extra fields, blank normalized text, duplicate identities, invalid evidence sequences, missing criteria, forbidden status changes, and review decisions that skip required states. The [persistence catalog](../persistence-catalog.md#taskdefined--log-only) records their exact declarations.

Evidence identifies one exact `(sessionId, seq)` event. This package validates its serialized fields; the Session Provider validates that the event exists within the same root task tree before accepting a mutation.

## Projection values

`TaskSnapshot` is the detached whole-row value shared by providers, hosts, and clients. It includes the root Session id, optional source Workspace id, optional complete `executionWorkspace`, owned descendant ids, durable task facts, derived status, attention items, live-data freshness, update time, and the root Session sequence used for compare-and-set mutations. A durable worktree assignment owns the projected Workspace identity even if transient membership is unavailable after restart. `TaskListSnapshot` establishes an ordered baseline for one runtime generation. `TaskListChange` carries whole-row upserts and removals for that same generation.

The current status precedence is `needs-attention`, `failed`, `running`, `reviewing`, `ready`, then `settled`. Idle state alone never implies readiness. A disconnected or unavailable runtime remains explicit through `freshness` instead of being presented as current information.

## Service behavior

[`TaskService`](../../packages/task/task/src/service.ts) is the definition consumed by Host APIs and implemented by a Session-backed Provider. `assignWorktree` also verifies that the assignment names the target root, its source Workspace still exists, and its source path matches that Workspace. Every durable mutation carries `expectedSeq`; the Provider compares it with the root Session's next sequence immediately before appending exactly one validated event. Subscribers receive detached whole-row changes and must be isolated from one another by the Provider.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtasks--taskservice-abstract-seam"></a>

### `ctx.tasks` — `TaskService` (abstract seam)

Root-task projection seam. Implementations own Session resolution, replay, compare-and-set appends, live generations, and subscriber containment.

```ts cordis-catalog
/**
 * Read the current task-list baseline.
 * @returns a detached whole-list baseline for the current generation.
 */
abstract snapshot(): TaskListSnapshot

/**
 * Subscribe to whole-row changes.
 * @param listener - callback invoked for each committed change batch.
 * @returns a disposer that removes this exact subscription.
 */
abstract onChanged(listener: (change: TaskListChange) => void): () => void

/**
 * Replace the complete process-local activity and attention baseline.
 * @param generation - monotonically increasing live-source generation.
 * @param facts - complete detached fact set for that generation.
 */
abstract replaceLiveGeneration(generation: number, facts: readonly LiveTaskFact[]): void

/**
 * Retain the last live baseline but mark it disconnected.
 * @param generation - exact generation whose source disconnected.
 */
abstract invalidateLiveGeneration(generation: number): void

/**
 * Record the immutable execution worktree created for one root Task.
 * @param sessionId - root Session identity.
 * @param request - complete assignment facts and expected next sequence.
 * @returns the committed task row.
 */
abstract assignWorktree(sessionId: SessionId, request: AssignTaskWorktreeRequest): Promise<TaskSnapshot>

/**
 * Define or replace one root Task.
 * @param sessionId - root Session identity.
 * @param request - normalized definition input and expected next sequence.
 * @returns the committed task row.
 */
abstract define(sessionId: SessionId, request: DefineTaskRequest): Promise<TaskSnapshot>

/**
 * Replace one criterion by stable identity.
 * @param sessionId - root Session identity.
 * @param request - complete criterion and expected next sequence.
 * @returns the committed task row.
 */
abstract updateCriterion(sessionId: SessionId, request: UpdateTaskCriterionRequest): Promise<TaskSnapshot>

/**
 * Record or resolve one risk by stable identity.
 * @param sessionId - root Session identity.
 * @param request - complete risk and expected next sequence.
 * @returns the committed task row.
 */
abstract recordRisk(sessionId: SessionId, request: RecordTaskRiskRequest): Promise<TaskSnapshot>

/**
 * Record an explicit review or delivery decision.
 * @param sessionId - root Session identity.
 * @param request - decision and expected next sequence.
 * @returns the committed task row.
 */
abstract review(sessionId: SessionId, request: ReviewTaskRequest): Promise<TaskSnapshot>
```

Types: [SessionId](core.md)

Source: [`packages/task/task/src/service.ts:60`](../../packages/task/task/src/service.ts)

<a id="ctxtaskworktrees--taskworktreeservice-abstract-seam"></a>

### `ctx.taskWorktrees` — `TaskWorktreeService` (abstract seam)

Service Definition for Task-specific execution worktrees.

```ts cordis-catalog
/**
 * Create one application-owned integration worktree without changing the source checkout.
 * @param request - Task identity and registered source Workspace.
 * @param signal - Optional cancellation of inspection and Git execution.
 * @returns Complete assignment facts suitable for durable Session logging.
 */
abstract create( request: CreateTaskWorktreeRequest, signal?: AbortSignal, ): Promise<TaskWorktreeAssignment>

/**
 * Compare durable assignment facts with the current local Git registration.
 * @param assignment - Previously recorded worktree assignment.
 * @param signal - Optional cancellation of Git inspection.
 * @returns Whether the exact worktree remains available, is missing, or has diverged.
 */
abstract inspect( assignment: TaskWorktreeAssignment, signal?: AbortSignal, ): Promise<TaskWorktreeAvailability>
```

Source: [`packages/task/task-worktree/src/index.ts:38`](../../packages/task/task-worktree/src/index.ts)
<!-- END GENERATED cordis-surface -->
