# Task 投影与注意力队列实施计划

[English](2026-09-07-task-projection-attention.md) | 中文

> **供 Agent worker 使用：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐项实施本计划。步骤使用 checkbox（`- [ ]`）跟踪。

**目标：** 交付[已批准设计](../specs/2026-09-07-task-projection-attention-design.md)中的事件溯源 Task 服务、统一注意力队列、Host RPC、客户端 store 和桌面总览集成。

**架构：** `@deepseek-ai/dsh-task` 拥有 branded 公共值和 Service Definition。`@deepseek-ai/dsh-task-session` 根据 Session 日志和 generation-scoped 实时事实实现命令与跨 Session 聚合。Host 暴露 whole-row 基线和变化；客户端 runtime 拒绝过期 generation，任务总览只消费这一份 store。

**技术栈：** TypeScript 6、Cordis service/effect、Session 事件与投影、Typert RPC、Zod wire schema、React 18、Vitest、无密钥 Web 快照、Playwright Electron 验收。

---

### 任务 1：Task 类型与持久事件

**文件：**
- 新建：`packages/task/task/package.json`
- 新建：`packages/task/task/tsconfig.json`
- 新建：`packages/task/task/src/types.ts`
- 新建：`packages/task/task/src/index.ts`
- 新建：`packages/task/task/src/invariant.ts`
- 新建：`packages/task/task/tests/types.spec.ts`
- 新建：`packages/task/README.md`
- 新建：`packages/task/README.zh.md`
- 新建：`packages/task/README.i18n.yaml`
- 新建：`packages/task/task/README.md`
- 新建：`packages/task/task/README.zh.md`
- 新建：`packages/task/task/README.i18n.yaml`
- 修改：`packages/README.md`
- 修改：`packages/README.zh.md`
- 修改：`tsconfig.base.json`
- 修改：`tsconfig.host.json`

- [ ] **步骤 1：编写失败的类型与事件测试**

```text
import { describe, expect, expectTypeOf, it } from 'vitest'
import { AttentionItemId, TaskCriterionId, type TaskDefinition, type TaskSnapshot } from '@deepseek-ai/dsh-task'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'

describe('task public vocabulary', () => {
  it('brands identities and exposes whole-value durable events', () => {
    expect(AttentionItemId('attention-1')).toBe('attention-1')
    expect(TaskCriterionId('criterion-1')).toBe('criterion-1')
    expectTypeOf<SessionEventMap['task/defined']>().toEqualTypeOf<{ definition: TaskDefinition }>()
    expectTypeOf<TaskSnapshot['status']>().toEqualTypeOf<'needs-attention' | 'failed' | 'running' | 'reviewing' | 'ready' | 'settled'>()
  })
})
```

- [ ] **步骤 2：运行测试并确认 RED**

运行：`pnpm exec vitest run packages/task/task/tests/types.spec.ts`

预期：失败，因为 `@deepseek-ai/dsh-task` 尚不存在。

- [ ] **步骤 3：添加包与公共值**

`types.ts` 必须定义并导出以下完整 discriminant 和 record。所有集合均为 readonly；每个标识使用 `Branded<B>`，并提供来自 `@deepseek-ai/dsh-brand` 的对应运行时构造器。

```text
export type TaskCriterionStatus = 'pending' | 'satisfied' | 'failed' | 'waived'
export type TaskRiskSeverity = 'low' | 'medium' | 'high' | 'critical'
export type TaskReviewDecision = 'changes-requested' | 'ready' | 'committed' | 'applied' | 'archived' | 'discarded'
export type TaskStatus = 'needs-attention' | 'failed' | 'running' | 'reviewing' | 'ready' | 'settled'
export type TaskFreshness = 'live' | 'disconnected' | 'unavailable'
export type AttentionKind = 'approval' | 'question' | 'plan-review' | 'run-failure' | 'merge-conflict' | 'validation-failure' | 'review-request'
export type AttentionSeverity = 'info' | 'warning' | 'error' | 'critical'

export interface TaskCriterion {
  readonly id: TaskCriterionId
  readonly text: string
  readonly status: TaskCriterionStatus
  readonly evidence: readonly TaskEvidenceRef[]
}

export interface TaskDefinition {
  readonly goal: string
  readonly criteria: readonly TaskCriterion[]
}

export interface TaskEvidenceRef {
  readonly sessionId: SessionId
  readonly seq: number
}

export interface TaskRisk {
  readonly id: TaskRiskId
  readonly severity: TaskRiskSeverity
  readonly summary: string
  readonly resolution?: string
}

export interface AttentionItem {
  readonly id: AttentionItemId
  readonly taskId: SessionId
  readonly ownerSessionId: SessionId
  readonly kind: AttentionKind
  readonly severity: AttentionSeverity
  readonly summary: string
  readonly createdAt: number
  readonly sourceId: string
  readonly actionable: boolean
}

export interface TaskSnapshot {
  readonly taskId: SessionId
  readonly definition?: TaskDefinition
  readonly descendantSessionIds: readonly SessionId[]
  readonly status: TaskStatus
  readonly freshness: TaskFreshness
  readonly attention: readonly AttentionItem[]
  readonly risks: readonly TaskRisk[]
  readonly reviewDecision?: TaskReviewDecision
  readonly updatedAt: number
  readonly asOfSeq: number
}
```

`index.ts` 在 `SessionEventMap` 上声明 `task/defined`、`task/criterion-updated`、`task/risk-recorded` 和 `task/review-decided`；每个事件携带变更后的完整领域 record，而不是 delta。`invariant.ts` 注册该包拥有的事件流 invariant。

- [ ] **步骤 4：在仓库聚合与文档中注册包**

在两个包层级表和两组源码解析通配列表中加入 `task/` 组，在 `tsconfig.host.json` 加入 `packages/task/task`，并创建配对的包 README，其中包含无直接模型影响说明和明确的跨 Session Provider 延后限制。

- [ ] **步骤 5：确认 GREEN 和包约束**

运行：`pnpm install && pnpm exec vitest run packages/task/task/tests/types.spec.ts && pnpm run constraints`

预期：测试和约束通过。

- [x] **步骤 6：提交**

```sh
git add packages/task/task packages/README.md packages/README.zh.md packages/README.i18n.yaml tsconfig.host.json pnpm-lock.yaml
git commit -m "feat(task): define durable task vocabulary"
```

### 任务 2：纯折叠与 Service Definition

**文件：**
- 在 `packages/task/task/src/` 下新建：`fold.ts` 和 `service.ts`
- 在 `packages/task/task/tests/` 下新建：`fold.spec.ts` 和 `service.spec.ts`
- 修改：`packages/task/task/src/index.ts`
- 修改：`packages/task/task/README.md`
- 修改：`packages/task/task/README.zh.md`

- [x] **步骤 1：编写失败的折叠测试**

覆盖空状态、定义替换、条件更新、风险解决、审查决定、无关事件的引用保持、重复 id、空文本、条件缺失、仍有活动时的终态决定，以及条件未满足时的 `ready`。

```text
it('requires explicit evidence before ready', () => {
  expect(() => foldTask(events(
    defined('ship desktop', criterion('installer')),
    reviewed('ready'),
  ))).toThrow('ready requires every criterion to be satisfied or waived')
})
```

- [x] **步骤 2：确认 RED**

运行：`pnpm exec vitest run packages/task/task/tests`

预期：失败，因为折叠与服务尚不存在。

- [x] **步骤 3：实现严格回放折叠**

`fold.ts` 导出 `emptyTaskFoldState`、`applyTaskEvent` 和 `foldTask`。它验证每个所属事件，对不合法持久数据抛出包含事件序号的 `TaskLogError`，对无关事件返回相同引用，并且不保存实时活动。Whole-value 事件只替换其所属 record；条件更新保持定义顺序。

- [x] **步骤 4：定义 Task service 接口**

`TaskService` 是位于 `ctx.tasks` 的抽象 Cordis service，不拥有 Session 实现。命令方法使用 `expectedSeq`，Provider 必须在追加一个经过验证的 whole-value 事件前立即将其与根 Session 的下一个序号比较。

```text
abstract snapshot(): TaskListSnapshot
abstract onChanged(listener: (change: TaskListChange) => void): () => void

abstract define(sessionId: SessionId, request: {
  readonly goal: string
  readonly criteria: readonly { readonly id?: TaskCriterionId; readonly text: string }[]
  readonly expectedSeq: number
}): Promise<TaskSnapshot>

abstract updateCriterion(sessionId: SessionId, request: {
  readonly criterion: TaskCriterion
  readonly expectedSeq: number
}): Promise<TaskSnapshot>

abstract recordRisk(sessionId: SessionId, request: {
  readonly risk: TaskRisk
  readonly expectedSeq: number
}): Promise<TaskSnapshot>

abstract review(sessionId: SessionId, request: {
  readonly decision: TaskReviewDecision
  readonly expectedSeq: number
}): Promise<TaskSnapshot>
```

Service Definition 导出 `TaskError` 和稳定错误码，但不解析 Session、不验证证据，也不追加事件。`TaskListSnapshot`、`TaskListChange` 和 `LiveTaskFact` 是 Provider、Host Consumer 与测试共享的分离 JSON 值。

- [x] **步骤 5：确认 GREEN**

运行：`pnpm exec vitest run packages/task/task/tests`

预期：所有折叠与命令测试通过。

- [ ] **步骤 6：提交**

```sh
git add packages/task/task
git commit -m "feat(task): define task projection service"
```

### 任务 3：跨 Session Provider 与注意力聚合

**文件：**
- 新建：`packages/task/task-session/package.json`
- 新建：`packages/task/task-session/tsconfig.json`
- 新建：`packages/task/task-session/src/index.ts`
- 新建：`packages/task/task-session/src/aggregate.ts`
- 新建：`packages/task/task-session/src/invariant.ts`
- 新建：`packages/task/task-session/tests/aggregate.spec.ts`
- 新建：`packages/task/task-session/tests/runtime.spec.ts`
- 修改：`packages/task/README.md`
- 修改：`packages/task/README.zh.md`
- 修改：`tsconfig.host.json`

- [ ] **步骤 1：编写失败的聚合测试**

使用真实内存 Session。覆盖根发现、连续 subagent 血缘、普通 fork 分离、循环、缺失后代、状态优先级、准确注意事项标识、相邻事项结束、稳定排序和 generation 失效。

```text
it('keeps sibling attention when one source settles', () => {
  const aggregate = createTaskAggregate(root)
  aggregate.publishLive(generation(1), [question('q1'), approval('a1')])
  aggregate.settleLive(generation(1), 'q1')
  expect(aggregate.snapshot().attention.map(item => item.sourceId)).toEqual(['a1'])
})
```

- [ ] **步骤 2：确认 RED**

运行：`pnpm exec vitest run packages/task/task-session/tests`

预期：失败，因为 `@deepseek-ai/dsh-task-session` 尚不存在。

- [ ] **步骤 3：实现纯聚合**

`aggregate.ts` 接收分离的 root、descendant、持久折叠与实时事实输入。它只追踪连续的 `origin: 'subagent'` 父链，通过 `freshness: 'unavailable'` 报告日志缺失，按设计优先级计算状态，并按 actionable、严重程度、创建时间、任务更新时间、Task id、事项 id 排序。它绝不根据 idle 推断 `ready`。

- [ ] **步骤 4：实现 Provider 生命周期**

`TaskSessionProvider` 扩展 `TaskService`，通过 `ctx.on()` 和 `ctx.effect()` 订阅，从 Session 日志重建持久行，并实现：

```text
snapshot(): TaskListSnapshot
onChanged(listener: (change: TaskListChange) => void): () => void
replaceLiveGeneration(generation: number, facts: readonly LiveTaskFact[]): void
invalidateLiveGeneration(generation: number): void
```

每条命令解析非 subagent 根且不恢复 Agent，将 `expectedSeq` 与 `session.seq` 比较，根据同一根任务树中的现有事件验证证据引用，并且恰好追加一个事件。它拒绝规范化后为空的字符串、重复 id、外部或缺失证据、过期序号、无效条件转换，以及仍有归属运行活动时的终态审查决定。忽略旧 generation 的发布与结束。失效会在下一份基线前把保留行标记为 disconnected。listener 异常会被记录且不能阻止后续 listener。disposal 在释放 Session 订阅前关闭通知注册。

- [ ] **步骤 5：确认 GREEN 与 invariant**

运行：`pnpm exec vitest run packages/task/task-session/tests && pnpm exec tsc -b packages/task/task-session/tsconfig.json`

预期：Provider 测试和 typecheck 通过。

- [ ] **步骤 6：提交**

```sh
git add packages/task/task-session packages/task/README.md packages/task/README.zh.md packages/task/README.i18n.yaml tsconfig.host.json pnpm-lock.yaml
git commit -m "feat(task): aggregate task activity and attention"
```

### 任务 4：Host Task RPC

**文件：**
- 新建：`packages/host/apiproxy/src/api/{tasks,tasks.schema}.ts`
- 新建：`packages/host/apiproxy/tests/{tasks-api.spec.ts}`
- 修改：`packages/host/apiproxy/src/api/rpc-map.ts`
- 修改：`packages/host/apiproxy/src/api/index.ts`
- 修改：`packages/host/apiproxy/src/api-proxy.ts`
- 修改：`packages/host/apiproxy/package.json`

- [ ] **步骤 1：编写失败的 schema 与分发测试**

覆盖 `task.list`、`task.define`、`task.updateCriterion`、`task.recordRisk` 和 `task.review`；不合法 brand、根缺失、subagent 目标、过期预期序号、服务不可用和 whole-row change frame。

- [ ] **步骤 2：确认 RED**

运行：`pnpm exec vitest run packages/host/apiproxy/tests -t "task"`

预期：失败，因为 Task RPC 方法和 schema 缺失。

- [ ] **步骤 3：添加类型化 RPC 方法与 schema**

向 `RpcMethodMap` 添加以下条目，并从 service 方法派生 request/value 类型：

```text
'task.list': TasksApi['list']
'task.define': TasksApi['define']
'task.updateCriterion': TasksApi['updateCriterion']
'task.recordRisk': TasksApi['recordRisk']
'task.review': TasksApi['review']
```

Schema 拒绝未知字段、空 id、负 generation、负 expected sequence、重复条件 id、不合法证据事件序号和无效 discriminant。API 将根与证据解析委托给 Task service，并将 `TaskError.code` 映射为稳定的小写 RPC code。

- [ ] **步骤 4：发布 whole-row 变化**

API proxy 发送包含 `{ generation, upserts, removed }` 的 `task/changed` downstream frame。Provider 订阅是 effect；断开会在 Task service 能发布另一 frame 前移除它。

- [ ] **步骤 5：确认 GREEN 与受影响 Host 测试**

运行：`pnpm exec vitest run packages/host/apiproxy/tests -t "task|blank"`

预期：所有选定测试通过。

- [ ] **步骤 6：提交**

```sh
git add packages/host/apiproxy
git commit -m "feat(api): expose task state and commands"
```

### 任务 5：客户端 Task store 与重连语义

**文件：**
- 在 `packages/client/runtime/src/client/` 下新建：`tasks/service.ts`、`tasks/manager.ts` 和 `contract/tasks.ts`
- 新建：`packages/client/runtime/tests/{tasks-service,tasks-manager}.client.spec.ts`
- 修改：`packages/client/runtime/src/client/index.ts`
- 修改：`packages/client/runtime/src/client/{apply}.ts`
- 修改：`packages/client/runtime/README.md`
- 修改：`packages/client/runtime/README.zh.md`

- [ ] **步骤 1：编写失败的 store 测试**

覆盖 pending、loading、ready、保留旧行的刷新错误、断线过期、过期成功、过期失败、重叠 generation、whole-row upsert、删除和成功恢复。

```text
it('cannot publish an old baseline after reconnect', async () => {
  const oldRequest = deferred<TaskListSnapshot>()
  api.taskList.mockReturnValueOnce(oldRequest.promise).mockResolvedValueOnce(freshSnapshot(2))
  const first = manager.refresh()
  manager.disconnect(1)
  await manager.connect(2)
  oldRequest.resolve(staleSnapshot(1))
  await first
  expect(manager.snapshot().generation).toBe(2)
})
```

- [ ] **步骤 2：确认 RED**

运行：`pnpm exec vitest run packages/client/runtime/tests -t "task"`

预期：失败，因为 Task manager 和 contract 尚不存在。

- [ ] **步骤 3：实现 manager 与公共 store**

`TaskListState` 包含 `phase`、`state`、`error`、`freshness`、`generation`、`ids` 和 `byId`。每个请求捕获 manager generation。断线会在发布保留旧行前使旧所有权失效。只有当前请求可以在 `then`、`catch` 或 `finally` 中改变 loading/error 状态。

- [ ] **步骤 4：连接 downstream frame 与命令**

共享客户端 frame dispatcher 仅在 `task/changed` 的 generation 等于当前基线时将其传给 manager。公共命令方法调用类型化 API，并且只在 acknowledgment 成功后刷新；错误保持结构化。

- [ ] **步骤 5：确认 GREEN 与客户端 typecheck**

运行：`pnpm exec vitest run packages/client/runtime/tests -t "task" && pnpm -s run typecheck:client`

预期：Task store 测试和客户端 typecheck 通过。

- [ ] **步骤 6：提交**

```sh
git add packages/client/runtime
git commit -m "feat(client): project task list state"
```

### 任务 6：迁移桌面总览

**文件：**
- 修改：`packages/client/ui-task-overview/src/client/select-tasks.ts`
- 修改：`packages/client/ui-task-overview/src/client/TaskOverview.tsx`
- 修改：`packages/client/ui-task-overview/src/client/navigation.ts`
- 修改：`packages/client/ui-task-overview/src/client/locales.ts`
- 修改：`packages/client/ui-task-overview/tests/select-tasks.client.spec.ts`
- 修改：`packages/client/ui-task-overview/tests/overview.client.spec.tsx`
- 修改：`packages/client/ui-task-overview/tests/navigation-runtime.client.spec.ts`
- 修改：`packages/client/ui-task-overview/README.md`
- 修改：`packages/client/ui-task-overview/README.zh.md`
- 修改：`packages/bundle/desktop-app/cordis.patch.yml`
- 修改：`packages/bundle/desktop-app/package.json`

- [ ] **步骤 1：用 Task 快照替换选择器 fixture 并确认 RED**

测试必须证明全部六种状态、条件进度、风险数量、每个注意事项所有者、过期/错误/加载差异、Task 命令失败和普通 Web fallback 标签。

运行：`pnpm exec vitest run packages/client/ui-task-overview/tests`

预期：失败，因为组件仍消费 Session 派生行。

- [ ] **步骤 2：渲染 Task store**

desktop profile 强制要求 `useTasks`；行展示任务目标、工作区、状态、活动后代、条件进度、未解决风险和注意事项操作。导航使用 `ownerSessionId` 加现有权威 subagent 地址解析器。组件绝不在导航期间回答、批准、标记就绪或清除事项。

- [ ] **步骤 3：保留显式 Web fallback**

当 desktop profile 之外无法使用 `useTasks` 时，继续调用现有纯 Session 选择器，并显示本地化能力标签 `Session activity only` / `仅显示会话活动`。Fallback 行不得报告条件、风险、审查就绪或当前新鲜度。

- [ ] **步骤 4：在 desktop bundle 中强制要求 Provider**

向 bundle manifest 添加 Task service 和 Provider 依赖，并在 Host API 与任务总览之前挂载它们。扩展 bundle invariant，在任一 service 或 UI contribution 缺失时失败。

- [ ] **步骤 5：确认 GREEN**

运行：`pnpm exec vitest run packages/client/ui-task-overview/tests packages/bundle/desktop-app/tests && pnpm -s run typecheck:client`

预期：总览、bundle 和客户端 typecheck 通过。

- [ ] **步骤 6：提交**

```sh
git add packages/client/ui-task-overview packages/bundle/desktop-app pnpm-lock.yaml
git commit -m "feat(desktop): show durable task readiness and attention"
```

### 任务 7：公开循环投影与组装验收

**文件：**
- 修改：`packages/sdk/client/src/api.ts`
- 修改：`packages/sdk/client/src/client.ts`
- 修改：`packages/sdk/client/src/types.ts`
- 修改：`packages/sdk/client/tests/sdk-client.spec.ts`
- 修改：`python/sdk/src/deepseek_harness/api.py`
- 修改：`python/sdk/src/deepseek_harness/client.py`
- 修改：`python/sdk/src/deepseek_harness/models.py`
- 修改：`python/sdk/tests/test_client.py`
- 新建：`apps/web/tests/task-attention.snapshot.ts`
- 新建：`examples/snapshots/task-attention/cordis.yml`
- 新建：`examples/snapshots/task-attention/fixture.jsonl`
- 修改：`apps/desktop/tests/desktop.e2e.ts`
- 修改：`.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.md`
- 修改：`.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.zh.md`
- 修改：`docs/superpowers/plans/2026-09-07-task-projection-attention.md`
- 修改：`docs/superpowers/plans/2026-09-07-task-projection-attention.zh.md`

- [ ] **步骤 1：编写失败的 SDK 与组装测试**

SDK 测试断言 Task list 和 command 的请求/响应投影。无密钥场景执行两个根、后代注意事项、条件更新、失败、ready 审查和断线保留行。Electron 验收重载 Renderer，并验证 Task 与注意事项 id 不变。

- [ ] **步骤 2：确认 RED**

分别运行以下三个命令：

```sh
pnpm exec vitest run packages/sdk/client/tests/sdk-client.spec.ts
uv run --project python/sdk pytest python/sdk/tests/test_client.py
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/task-attention.snapshot.ts
```

预期：在每个公开循环中第一个缺失的 Task 投影处失败。

- [ ] **步骤 3：通过两个 SDK 投影 Task API**

添加类型化 Task 方法，不增加 SDK 自有状态。Python 值准确保留 wire discriminant 和标识；不合法响应通过现有 protocol error 路径失败。

- [ ] **步骤 4：完成无密钥与 Electron 验收**

使用真实 desktop composition，只替换不确定模型 provider。断言面向用户的状态、条件、风险与操作路由；不检查 CSS class 或私有 store。Electron 测试使用隔离 app data 和可丢弃工作区。

- [ ] **步骤 5：更新决策状态与计划 checkbox**

在两种语言的 Mission Control Note 中记录已交付的 Task 投影与注意力行为，同时将 worktree、审查工作区、托盘、Studio、签名和更新保留为后续阶段。将所有已完成计划步骤标记为 `[x]`，并重新记录两组双语 pair。

- [ ] **步骤 6：运行最终相关验证**

运行：

```sh
pnpm exec vitest run packages/task/task/tests packages/task/task-session/tests packages/host/apiproxy/tests packages/client/runtime/tests packages/client/ui-task-overview/tests packages/bundle/desktop-app/tests packages/sdk/client/tests/sdk-client.spec.ts
uv run --project python/sdk pytest
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/task-attention.snapshot.ts
pnpm --filter @deepseek-ai/dsh-desktop test:built
pnpm --filter @deepseek-ai/dsh-desktop test:e2e
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
pnpm run build
pnpm run hygiene
git diff --check
```

预期：所有列出的命令通过；平台 skip 保持明确，且不隐藏新的广泛测试失败。

- [ ] **步骤 7：提交**

```sh
git add packages/sdk/client python/sdk apps/web examples apps/desktop .agents/notes/proposed/feature docs/superpowers/plans
git commit -m "test(desktop): accept task attention lifecycle"
```
