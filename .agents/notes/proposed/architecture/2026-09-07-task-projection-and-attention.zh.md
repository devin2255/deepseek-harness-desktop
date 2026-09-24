# Agent Note：根任务投影与注意事项

状态：提议

[English](2026-09-07-task-projection-and-attention.md) | 中文

## 问题

会话行无法回答桌面端操作者最关心的问题：每个根 Agent 正在追求什么结果、哪些后代属于它、是否需要输入，以及验收标准是否满足。从打开的标签页或瞬态进程状态推断这些答案，会在重连和重启后丢失。把每个普通 fork 都当作委派工作，也会破坏所有权。

## 提案

新增浏览器安全的 `@deepseek-ai/dsh-task` Service Definition 和基于 Session 的 provider。一个 Task 以一个 Session 为根。只有连续不断的 `origin: 'subagent'` 父链才会把后代归入该根；普通 fork 会成为另一个根。用户编写的目标、标准、证据、风险和评审决定都是 Session event。运行时活动和交互注意事项是按 generation 划分的 overlay。完整产品和数据模型见 [Task 投影与注意事项设计](../../../../docs/superpowers/specs/2026-09-07-task-projection-attention-design.md)。

Provider 发布相互分离的整行 snapshot。`snapshot()` 是完整且有序的重连 baseline。`onChanged()` 发出 `{ generation, upserts, removed }`；generation 变化会替换实时 overlay，并隔离来自上一轮 runtime 的迟到 fact。订阅者异常会被隔离，因此一个消费者不能中断其他消费者，也不能回滚已提交状态。

所有变更都根据 `expectedSeq` 执行 compare-and-set append。Provider 会在恰好追加一个 event 前校验根所有权、规范化文本、稳定 identity、重复标准和同一任务树内的证据。冷列表和检查不会恢复 Session。实时 Session 会覆盖冷持久化结果，且不会产生重复行。

### Host 协议

ApiProxy 公开 `task.list`、`task.define`、`task.updateCriterion`、`task.recordRisk` 和 `task.review`。Host 流承载后续 `task/changed` 增量。线路 schema 会严格校验每一层对象，并拒绝空白文本、负 sequence、无效 discriminant、重复 criterion identity 和格式错误的 evidence。每个 `TaskError` 都映射为稳定的小写 RPC code。没有 `ctx.tasks` 的组合返回 `task-unavailable`，且不发送 Task 变化。

客户端在建立或重新建立连接时必须获取 `task.list`，然后只接纳同一 generation 的变化。收到其他 generation 的变化时，客户端必须重新获取 baseline，不能合并来自不同 runtime view 的行。

### 包所有权

- `packages/task/task` 持有持久词汇、fold、错误分类和 Task service。
- `packages/task/task-session` 持有 Session 血缘、冷热聚合、compare-and-set 写入、实时 generation 隔离和 provider invariant。
- `packages/host/apiproxy` 持有浏览器方法、严格线路校验、错误转换和 Host 流交付。
- 桌面客户端包持有镜像、排序、筛选、导航和呈现；它们不会从 transcript 重建 Task 状态。总览隐藏 Workspace 归档集合中的根会话，但不移除其 `task.list` 行。

## 考虑过的替代方案

**把 Session 行直接当作 Task。**不采用，因为一棵委派树会显示成多个互不相关的结果，而普通 fork 也无法与委派区分。

**只在客户端状态中保存 Task 定义。**不采用，因为其他窗口、重连、重启、回退和冷列表会丢失或产生互相矛盾的验收记录。

**只发送变化信号，并在每次变化后重新拉取。**不采用，因为并发变化需要 single-flight 和旧响应处理机制。有界的整行增量已经足够，并能在同一 generation 内维持顺序。

## 验收标准

领域和 provider 套件覆盖词汇、event fold、血缘、状态优先级、冷热协调、generation 隔离、变更校验、串行写入、监听器异常隔离和生命周期清理。Host 套件覆盖所有方法、每个 Task 错误 code、严格的无效 payload、baseline 传输、变化交付和订阅释放。最终桌面阶段必须增加一条无密钥的组装态验收路径，证明重连收敛和操作者可见的任务处理。

## 风险

运行时注意事项不持久化。重启后，在 producer 重新发布前它们不存在；持久 approval 和 failure 证据仍可从 Session event 推导。版本 1 不提供服务端分页，因为桌面目标是本地任务集合；若实际规模证明完整 baseline 过大，分页必须使用绑定 generation 的 cursor。
