# 根任务投影

[English](task.md) | 中文

Task 能力把一个根 Session 及其连续的 subagent 后代聚合为一个桌面工作项。应用所有的执行 Worktree、验收条件、证据、风险、评审决策和 Git 交付收据保留在根 Session 日志中；运行时活动与注意事项属于 generation 作用域输入，绝不会被重建为持久事实。

## 持久事实

八种全值 Session 事件定义持久记录：`task/worktree-assigned`、`task/defined`、`task/criterion-updated`、`task/risk-recorded`、`task/review-decided`、`task/review-committed`、`task/review-applied` 和 `task/review-discarded`。Worktree 事件只记录一次不可变的源 Workspace、基础提交、源状态摘要、应用分支和执行目录。人工评审决策只能请求修改或声明准备交付；提交、应用和丢弃事件携带 Git Provider 返回的完整收据，包括准确的评审版本、操作标识、Git 对象 id 和恢复事实。严格折叠会拒绝重复分配、畸形标识、Task 或 Workspace 归属不匹配、额外字段、未规范化的空文本、重复标识、非法证据序号、缺失条件、禁止的状态变化，以及跳过必需阶段的交付事件。[持久化目录](../persistence-catalog.md#taskdefined--log-only)记录其确切声明。

证据指向一个确切的 `(sessionId, seq)` 事件。此包校验其序列化字段；Session Provider 在接受变更前校验该事件存在于同一根任务树中。

## 投影值

`TaskSnapshot` 是 Provider、Host 与客户端共享的分离全行值，其中包括根 Session id、可选源 Workspace id、可选完整 `executionWorkspace`、所属后代 id、持久任务事实与交付收据、派生状态、注意事项、实时数据新鲜度、更新时间，以及用于比较并设置变更的根 Session 序号。应用重启后即使瞬态成员关系不可用，持久 Worktree 分配仍决定投影的 Workspace 标识。`TaskListSnapshot` 建立一个运行时 generation 的有序基线；`TaskListChange` 携带同一 generation 的全行更新与移除项。

当前状态优先级依次为 `needs-attention`、`failed`、`running`、由持久交付收据产生的 `settled`、`reviewing`、经明确证明的 `ready`，最后是空闲 `settled`。仅处于空闲状态绝不代表已经就绪。运行时断开或不可用会通过 `freshness` 明确表达，不会伪装成当前信息。

## 服务行为

[`TaskService`](../../packages/task/task/src/service.ts) 是 Host API 使用、由 Session Provider 实现的服务定义。`assignWorktree` 还会校验分配指向目标根 Task、源 Workspace 仍然存在且源路径与该 Workspace 一致。`recordCommit`、`recordApply` 和 `recordDiscard` 只接受完整 Provider 收据，并在 Task 树仍有活动工作时拒绝操作。每个持久变更都携带 `expectedSeq`；Provider 在追加一个经过校验的事件前，立即将其与根 Session 的下一序号比较。Provider 必须向订阅者发送分离的全行变更，并隔离各订阅者的故障。

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
 * Read one member file diff from an exact review snapshot.
 * @param request - Recorded assignment, repository-relative path, and expected revision.
 * @param signal - Optional cancellation of diff generation.
 * @returns The bounded text or binary diff description.
 */
abstract diff( request: GetTaskFileDiffRequest, signal?: AbortSignal, ): Promise<TaskFileDiff>

/**
 * Commit the exact reviewed state inside its Task worktree.
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
 * Release one Task worktree after exact-state and loss confirmation checks.
 * @param request - Recorded assignment, expected revision, and loss acknowledgement.
 * @param signal - Optional cancellation before worktree removal.
 * @returns Durable cleanup facts for Session logging.
 */
abstract discard( request: DiscardTaskReviewRequest, signal?: AbortSignal, ): Promise<TaskDiscardReceipt>
```

Source: [`packages/task/task-review/src/index.ts:45`](../../packages/task/task-review/src/index.ts)

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
 * Record facts returned by a completed Task commit operation.
 * @param sessionId - root Session identity.
 * @param request - whole commit receipt and expected next sequence.
 * @returns the committed task row.
 */
abstract recordCommit(sessionId: SessionId, request: RecordTaskCommitRequest): Promise<TaskSnapshot>

/**
 * Record facts returned by a completed source application.
 * @param sessionId - root Session identity.
 * @param request - whole apply receipt and expected next sequence.
 * @returns the committed task row.
 */
abstract recordApply(sessionId: SessionId, request: RecordTaskApplyRequest): Promise<TaskSnapshot>

/**
 * Record facts returned by a completed worktree discard.
 * @param sessionId - root Session identity.
 * @param request - whole discard receipt and expected next sequence.
 * @returns the committed task row.
 */
abstract recordDiscard(sessionId: SessionId, request: RecordTaskDiscardRequest): Promise<TaskSnapshot>
```

Types: [SessionId](core.md)

Source: [`packages/task/task/src/service.ts:66`](../../packages/task/task/src/service.ts)

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
