# @deepseek-ai/dsh-task

[English](README.md) | 中文

这是根任务、应用所有的执行 Worktree、验收标准、证据、风险、评审决策、Git 交付收据和统一注意力行的持久词汇与服务定义。任务事实使用带严格回放校验的全值 Session 事件，因此恢复不依赖进程本地状态。Worktree 分配只记录一次源 Workspace、创建提交、源目录脏状态摘要、分支和执行路径。证据指向根任务树中的准确事件序号。人工评审只能请求修改或声明准备交付；提交、应用和丢弃状态必须携带完整 Provider 收据。

可选的 `TaskSnapshot.integrations` 包含根级工具调用的有序尝试，不新增 Task 事件。结果区分运行中、未确认、失败、已集成和冲突；`resolvedBy` 标识覆盖全部所选写入者的后续批次，不改写历史冲突。[Session Provider](../task-session/README.md#projection-rules) 负责重建和冲突注意事项。

人工交付先持久化 `task/delivery-started`。`TaskDeliveryIntent` 记录操作 id、审查 revision、类型及确切变更输入。完成要求匹配的 Provider 回执，而非最初的 Session 序列。待完成交付阻止 Task 元数据更改，并产生 `delivery-unconfirmed` 注意事项；无关 Session 事件仍被允许。只有回执的预发布日志会被拒绝。参见[交付日志决策](../../../.agents/notes/implemented/architecture/2026-10-08-root-delivery-journal.md)。

Discard 授权记录当前 worktree HEAD、未提交变更标记和显式损失确认。其回执必须匹配这些事实与当前审查 revision，不依赖较早的 Commit 回执。不完整的预发布丢弃意图会被拒绝。

`retryDeliveryCheckpoint` 保存已追加的实时回执，不执行 Git，也不追加另一条事件。只有原 Session 仍持有该回执时，`TaskSnapshot.retryableDeliveryCheckpoint` 才提供其确切操作 id。回执缺失、Session 被替换或分离时会拒绝；保存失败保留待核实状态。

## 模型体验

无直接影响，因为任务事件仅作为日志事实存在，不进入模型请求或模型可见的 Session 表面。

#### KV 缓存影响

没有影响。记录或回放任务事实不会改变提供方请求。

## 已知限制与待完成工作

- Host 创建 Worktree 并通过此服务记录分配；此包不执行 Git 操作。
- Git 与 Session 持久化不具备原子性；未确认交付需要检查 Git，尚无人工结算操作。
- 此包校验证据引用的结构；Provider 负责验证每个被引用事件都属于同一根任务树。
