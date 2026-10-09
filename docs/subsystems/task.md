# Root task projection

English | [中文](task.zh.md)

The task capability turns a root Session and its uninterrupted subagent descendants into one desktop work item. Its application-owned execution worktree, acceptance criteria, evidence, risks, review decisions, and Git delivery receipts remain in the root Session log. Live activity and interactive attention are generation-scoped overlays; durable approvals, failures, and integration conflicts are derived separately from logs.

## Durable facts

Nine whole-value Session events define the persistent record: `task/worktree-assigned`, `task/defined`, `task/criterion-updated`, `task/risk-recorded`, `task/review-decided`, `task/delivery-started`, `task/review-committed`, `task/review-applied`, and `task/review-discarded`. The worktree event records one immutable source Workspace, base commit, source status digest, application branch, and execution directory. A human review decision can only request changes or declare readiness. Commit, apply, and discard events carry the complete receipt returned by the Git Provider, including the exact review revision, operation identity, Git object ids, and recovery facts. The strict fold rejects reassignment, malformed identities, mismatched Task or Workspace ownership, extra fields, blank normalized text, duplicate identities, invalid evidence sequences, missing criteria, forbidden status changes, and delivery events that skip required states. The [persistence catalog](../persistence-catalog.md#taskdefined--log-only) records their exact declarations.

`TaskDeliveryIntent` retains the operation id and exact review revision, plus the message, parent HEAD, and target Git tree for `commit`, commit and source HEAD for `apply`, or current worktree HEAD, uncommitted-change flag, and explicit loss confirmation for `discard`. Discard's recovery commit equals its authorized HEAD unless that HEAD is the assignment base, in which case it is absent. It is not constrained to the earlier Commit receipt. `StartTaskDeliveryRequest` adds the authorization's `expectedSeq`. An unmatched intent produces `delivery-unconfirmed` attention; completion requires the same id, kind, revision, and operation-specific inputs. Receipt-only histories and incomplete pre-release intents reject. Unrelated Session events may intervene, but Task metadata, overlapping delivery, and root model steps remain blocked. Git and Session persistence are not an atomic transaction; neither replay nor read-only refresh retries or settles an unconfirmed operation.

The Review Provider supplies these Commit and Discard facts to the caller-owned authorization before changing the user index or removing the worktree:

```ts type-equiv
/** Exact parent and staged Git tree inspected before Commit authorization. */
interface TaskCommitPreflight {
  readonly headCommit: string
  readonly tree: string
}
```

```ts type-equiv
/** Current worktree facts captured before Discard authorization and removal. */
interface TaskDiscardPreflight {
  readonly headCommit: string
  readonly uncommittedChanges: boolean
}
```

Evidence identifies one exact `(sessionId, seq)` event. This package validates its serialized fields; the Session Provider validates that the event exists within the same root task tree before accepting a mutation.

## Delivery inspection

The Review capability declares `TaskDeliveryIntent`, `InspectTaskDeliveryRequest`, `TaskDeliveryInspection`, `TaskDeliveryInspectionRevision`, and `TaskDeliveryEffect`. Inspection takes the recorded assignment and intent and returns a current observation identified by task, workspace, intent, digest revision, and `observedAt`. `completed` includes operation-specific Git facts without an execution timestamp; `not-completed` states that the expected result is absent now; `ambiguous` names changed Task state, changed source state, incomplete removal, or a change between observations. Neither absence nor completion establishes causal attribution to the original operation.

The [Host inspection API](../../packages/host/apiproxy/README.md) reads authorization from the root log, holds execution ownership, and leaves durable pending attention unchanged. The [local Provider](../../packages/task/task-review-local/README.md) checks current Git under the common-repository queue without mutating user indexes, files, or branches. Human settlement remains separate from both this observation and an exact live receipt checkpoint retry.

## Execution worktrees

[`TaskWorktreeService`](../../packages/task/task-worktree/README.md) assigns application-owned worktrees to execution Session ids: root integration Sessions and isolated writer children use the same assignment format without turning a child into a root Task. `decodeTaskWorktreeAssignment` validates and detaches recorded data but does not verify live Git registration; reuse requires the Provider's `inspect` operation.

```ts type-equiv
/** Inputs required to create one application-owned execution worktree. */
interface CreateTaskWorktreeRequest {
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly workspacePath: string
  /** Reject creation if the source HEAD differs from this captured commit. */
  readonly expectedSourceHead?: string
  /** Reject creation when the source has staged, unstaged, or untracked changes. */
  readonly requireCleanSource?: boolean
}
```

The [local Provider](../../packages/task/task-worktree-local/README.md) rejects a captured-HEAD mismatch with `WORKTREE_SOURCE_MOVED` and a required-clean source with changes with `WORKTREE_SOURCE_DIRTY`, before creating the branch or directory. Omitting these optional requirements retains root-task creation from the source's committed HEAD without copying dirty content.

## Writer integration

The optional [writer tools](../../packages/subagent/tool-subagent-control/README.md#isolated-writer-results) consume batch integration independently of root delivery. Exact reviewed commits merge only into the managed root; ordinary durable tool results retain success or non-mutating conflict receipts. The [Session Provider](../../packages/task/task-session/README.md#projection-rules) reconstructs explicit attempts and unresolved conflict attention from those results.

```ts type-equiv
/** One exact committed writer result selected for integration. */
interface TaskIntegrationInput {
  readonly assignment: TaskWorktreeAssignment
  readonly expectedRevision: TaskReviewRevision
  readonly commit: string
}
```

```ts type-equiv
/** Batch of writer commits to merge into their recorded root execution worktree. */
interface IntegrateTaskReviewRequest {
  readonly assignment: TaskWorktreeAssignment
  readonly expectedRevision: TaskReviewRevision
  readonly inputs: readonly TaskIntegrationInput[]
  readonly message: string
}
```

```ts type-equiv
/** Exact contributor identities retained by either integration outcome. */
interface TaskIntegrationContributor {
  readonly sessionId: SessionId
  readonly branch: string
  readonly commit: string
  readonly reviewRevision: TaskReviewRevision
}
```

```ts type-equiv
/** Successful batch integration; the user's source checkout is not changed. */
interface TaskIntegrationReceipt {
  readonly kind: 'integrated'
  readonly operationId: TaskReviewOperationId
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly reviewRevision: TaskReviewRevision
  readonly headBefore: string
  readonly headAfter: string
  readonly contributors: readonly TaskIntegrationContributor[]
  readonly integratedAt: number
}
```

```ts type-equiv
/** Preflight conflict; root and child working trees and branches remain unchanged. */
interface TaskIntegrationConflict {
  readonly kind: 'conflict'
  readonly operationId: TaskReviewOperationId
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly reviewRevision: TaskReviewRevision
  readonly headBefore: string
  readonly contributors: readonly TaskIntegrationContributor[]
  readonly conflictingSessionId: SessionId
  readonly paths: readonly string[]
  readonly detectedAt: number
}
```

```ts type-equiv
/** Integration either publishes the complete batch or reports a non-mutating conflict. */
type TaskIntegrationResult = TaskIntegrationReceipt | TaskIntegrationConflict
```

## Projection values

`TaskSnapshot` is the detached whole-row value shared by providers, hosts, and clients. It includes the root Session id, optional source Workspace id, optional complete `executionWorkspace`, owned descendant ids, durable task facts and delivery receipts, derived status, attention items, live-data freshness, update time, and the root Session sequence used for compare-and-set mutations. A durable worktree assignment owns the projected Workspace identity even if transient membership is unavailable after restart. `TaskListSnapshot` establishes an ordered baseline for one runtime generation. `TaskListChange` carries whole-row upserts and removals for that same generation.

The current status precedence is `needs-attention`, `failed`, `running`, a durable delivery receipt producing `settled`, `reviewing`, explicitly proven `ready`, then idle `settled`. Idle state alone never implies readiness. A disconnected or unavailable runtime remains explicit through `freshness` instead of being presented as current information.

Cold Session repair closes an unfinished turn with an `interrupted` reason and synthetic results for unmatched tool calls. The Task projection presents that marker as a non-actionable run failure owned by the exact Session; process-local question attention is not reconstructed and the tool call is not replayed.

Optional `TaskSnapshot.integrations` contains ordered `TaskIntegrationNode` values with opaque ids derived from the owning root and call sequence. `resolvedBy` names the last later successful batch covering every selected writer; it preserves the original conflict outcome. Missing, spilled, or unverifiable receipts remain unconfirmed, including after loss of live execution ownership. These records are reconstructed from tool events rather than new Task events.

```ts type-equiv
/** Recorded integration outcome; missing or unverifiable receipts never imply Git success. */
type TaskIntegrationOutcome =
  | { readonly kind: 'running' | 'unconfirmed' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'integrated'; readonly result: TaskIntegrationReceipt }
  | { readonly kind: 'conflict'; readonly result: TaskIntegrationConflict }
```

```ts type-equiv
/** One integration attempt reconstructed from native or Code Mode tool events. */
interface TaskIntegrationNode {
  readonly id: TaskIntegrationNodeId
  readonly callSeq: number
  readonly startedAt: number
  readonly writerSessionIds: readonly SessionId[]
  readonly outcome: TaskIntegrationOutcome
  readonly finishedAt?: number
  /** Later successful batches cover every writer selected by this conflict, including revised commits. */
  readonly resolvedBy?: TaskIntegrationNodeId
}
```

## Service behavior

`TaskSnapshot.retryableDeliveryCheckpoint` identifies an existing receipt owned by the original attached Session. `retryDeliveryCheckpoint` only saves that receipt: it runs no Git, appends no event, and requires no readable worktree. Missing or replaced receipts reject; repeated save failures preserve uncertainty. Cold replay has no live retry owner and uses only durable log facts.

[`TaskService`](../../packages/task/task/src/service.ts) is the definition consumed by Host and SDK APIs and implemented by a Session-backed Provider. `assignWorktree` also verifies that the assignment names the target root, its source Workspace still exists, and its source path matches that Workspace. Metadata commands and `startDelivery` compare `expectedSeq` with the root Session's next sequence before appending exactly one validated event; authorization also rejects active Task trees. `recordCommit`, `recordApply`, and `recordDiscard` accept only complete receipts matching the outstanding intent and append at the current sequence. Authorization and completion await the live Session flush participant or cold persistence acknowledgment; missing or failed live checkpoints retain unconfirmed attention. Subscribers receive detached whole-row changes and must be isolated from one another by the Provider.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtaskreview--taskreviewservice-abstract-seam"></a>

### `ctx.taskReview` — `TaskReviewService` (abstract seam)

Service Definition for inspecting and delivering Task-owned worktree changes.

```ts cordis-catalog
/**
 * Inspect the current bounded review state of one Task worktree.
 * @param request - Recorded assignment that owns the review.
 * @param signal - Optional cancellation of repository inspection.
 * @returns One immutable summary and its exact review revision.
 */
abstract summarize( request: SummarizeTaskReviewRequest, signal?: AbortSignal, ): Promise<TaskReviewSummary>

/**
 * Compare current Git state with a recorded delivery authorization without repeating it.
 * Private-index inspection may retain unreachable Git objects, but changes no user index, worktree, or branch.
 * A completed classification supplies observed facts, not proof of execution time or causal attribution.
 * @param request - Recorded worktree assignment and exact pending authorization.
 * @param signal - Optional cancellation of bounded Git inspection.
 * @returns Current completed, absent, or ambiguous result; does not clear delivery uncertainty.
 */
abstract inspectDelivery(request: InspectTaskDeliveryRequest, signal?: AbortSignal): Promise<TaskDeliveryInspection>

/**
 * Read one member file diff from an exact review snapshot.
 * @param request - Recorded assignment, repository-relative path, and expected revision.
 * @param signal - Optional cancellation of diff generation.
 * @returns The bounded text or binary diff description.
 */
abstract diff( request: GetTaskFileDiffRequest, signal?: AbortSignal, ): Promise<TaskFileDiff>

/**
 * Commit the exact reviewed state inside its Task worktree.
 * Private-index preparation may retain unreachable Git objects; hooks or filters changing the authorized tree reject.
 * @param request - Recorded assignment, expected revision, and commit message.
 * @param signal - Optional cancellation before Git commits the state.
 * @returns Durable commit facts for Session logging.
 */
abstract commit( request: CommitTaskReviewRequest, signal?: AbortSignal, ): Promise<TaskCommitReceipt>

/**
 * Apply one reviewed Task commit to its recorded source checkout.
 * @param request - Recorded assignment, expected revision, and exact Task commit.
 * @param signal - Optional cancellation before source mutation.
 * @returns Durable apply facts for Session logging.
 */
abstract apply( request: ApplyTaskReviewRequest, signal?: AbortSignal, ): Promise<TaskApplyReceipt>

/**
 * Preflight all selected writer commits and publish their combined result on the root branch.
 * Requires exact review revisions, clean working trees, and direct child assignments.
 * Conflicts change no working tree or branch; Git objects from preflight may remain unreachable.
 * @param request - root assignment and exact reviewed contributor commits in merge order.
 * @param signal - cancellation before final publication; publication itself is bounded but not caller-cancellable.
 * @returns the complete integration receipt or a preflight conflict with exact contributor identities.
 */
abstract integrate(request: IntegrateTaskReviewRequest, signal?: AbortSignal): Promise<TaskIntegrationResult>

/**
 * Release one Task worktree after exact-state and loss confirmation checks.
 * @param request - Recorded assignment, expected revision, and loss acknowledgement.
 * @param signal - Optional cancellation before worktree removal.
 * @returns Durable cleanup facts for Session logging.
 */
abstract discard( request: DiscardTaskReviewRequest, signal?: AbortSignal, ): Promise<TaskDiscardReceipt>
```

Source: [`packages/task/task-review/src/index.ts:49`](../../packages/task/task-review/src/index.ts)

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
 * Record an explicit human review decision.
 * @param sessionId - root Session identity.
 * @param request - decision and expected next sequence.
 * @returns the committed task row.
 */
abstract review(sessionId: SessionId, request: ReviewTaskRequest): Promise<TaskSnapshot>

/**
 * Authorize one delivery and await its durable Session checkpoint before Git may change.
 * Rejects concurrent delivery or Task metadata changes until a matching result is recorded.
 * @param sessionId - owning root Session identity.
 * @param request - exact mutation and expected authorization sequence.
 * @returns the committed task row after persistence settles; failure never permits Git mutation.
 */
abstract startDelivery(sessionId: SessionId, request: StartTaskDeliveryRequest): Promise<TaskSnapshot>

/**
 * Retry persistence of an existing live delivery receipt without appending events or running Git.
 * Rejects missing receipts, mismatched operations, and replaced or detached Session instances.
 * @param sessionId - owning root Session identity.
 * @param operationId - exact operation advertised by retryableDeliveryCheckpoint.
 * @returns the confirmed Task row; failure retains the unconfirmed delivery.
 */
abstract retryDeliveryCheckpoint(sessionId: SessionId, operationId: TaskReviewOperationId): Promise<TaskSnapshot>

/**
 * Record facts returned by a completed Task commit operation.
 * @param sessionId - root Session identity.
 * @param request - whole commit receipt matching the outstanding intent.
 * @returns the committed task row after its durable checkpoint.
 */
abstract recordCommit(sessionId: SessionId, request: RecordTaskCommitRequest): Promise<TaskSnapshot>

/**
 * Record facts returned by a completed source application.
 * @param sessionId - root Session identity.
 * @param request - whole apply receipt matching the outstanding intent.
 * @returns the committed task row after its durable checkpoint.
 */
abstract recordApply(sessionId: SessionId, request: RecordTaskApplyRequest): Promise<TaskSnapshot>

/**
 * Record facts returned by a completed worktree discard.
 * @param sessionId - root Session identity.
 * @param request - whole discard receipt matching the outstanding intent.
 * @returns the committed task row after its durable checkpoint.
 */
abstract recordDiscard(sessionId: SessionId, request: RecordTaskDiscardRequest): Promise<TaskSnapshot>
```

Types: [SessionId](core.md)

Source: [`packages/task/task/src/service.ts:69`](../../packages/task/task/src/service.ts)

<a id="ctxtaskworktrees--taskworktreeservice-abstract-seam"></a>

### `ctx.taskWorktrees` — `TaskWorktreeService` (abstract seam)

Service Definition for Task-specific execution worktrees.

```ts cordis-catalog
/**
 * Create one application-owned integration worktree without changing the source checkout.
 * @param request - Session identity, source Workspace, and optional captured-HEAD or cleanliness requirements.
 * @param signal - Optional cancellation of inspection and Git execution.
 * @returns Complete assignment facts suitable for durable Session logging.
 */
abstract create( request: CreateTaskWorktreeRequest, signal?: AbortSignal, ): Promise<TaskWorktreeAssignment>

/**
 * Compare durable assignment facts with the current local Git registration.
 * Commits descended from the recorded base do not change assignment identity.
 * @param assignment - Previously recorded worktree assignment.
 * @param signal - Optional cancellation of Git inspection.
 * @returns Whether the exact worktree remains available, is missing, or has diverged.
 */
abstract inspect( assignment: TaskWorktreeAssignment, signal?: AbortSignal, ): Promise<TaskWorktreeAvailability>
```

Source: [`packages/task/task-worktree/src/index.ts:39`](../../packages/task/task-worktree/src/index.ts)
<!-- END GENERATED cordis-surface -->
