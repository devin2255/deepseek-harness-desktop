# @deepseek-ai/dsh-task-review

[English](README.md) | 中文

Task 所有的 worktree 变更审查与交付服务定义。Provider 提供有上限的审查摘要和文件 Diff，并为 Commit、Apply、Discard 与批量写入者集成返回确切回执。

每个文件 Diff 都属于一个准确的 `TaskReviewRevision`。变更操作必须携带同一 revision；用户审查后 worktree 一旦发生变化，操作就会失败。摘要还会携带源检出目录的实时 HEAD 和 dirty 状态；Apply 必须携带已显示的 source HEAD，之后再次移动就会在变更前失败。请求携带完整、已记录的 `TaskWorktreeAssignment`，Consumer 不能提供任意仓库路径。

本包不包含 Git 实现或界面文案。Provider 负责仓库检查、变更操作串行化、预检和操作标识。Commit 回执标识结果 revision，Apply 回执保留操作前后的 source HEAD 事实，Discard 回执区分不可恢复的未提交损失与已保留的 commit；Task Consumer 把成功回执记录到根 Session 日志。

集成选择确切且已提交的子级审查版本和一个根审查版本。冲突返回贡献者身份和冲突路径，不改变分支或工作树。成功只推进根执行分支，并保留贡献者分支；绝不向用户原始检出应用更改。[写入者工具](../../subagent/tool-subagent-control/README.md#isolated-writer-results) 将集成回执保留在普通持久化工具结果中，与根交付回执相互独立。

Commit、Apply 和 Discard 接受可选的进程内 `TaskDeliveryAuthorization`。其回调在预检后、修改用户索引、worktree 或分支前持久化调用方拥有的授权；拒绝会阻止这些变更。Commit 提供 `TaskCommitPreflight`，包含确切父 HEAD 和目标 Git 树；私有索引准备可能留下不可达 Git 对象。Discard 提供 `TaskDiscardPreflight`，包含当前 HEAD 和未提交变更标记，也涵盖较早 Commit 之后的更改。返回回执使用其操作 id。人工 Host 与 SDK 交付提供此授权；未提供的普通工具消费方保留 Provider 生成的 id 和工具结果日志。回调不是协议值。

`TaskDeliveryIntent` 描述已记录授权。`inspectDelivery` 将一个意图与当前 Git 比较，不重复操作，也不清除不确定状态。其 `TaskDeliveryInspection` 区分已完成、当前未完成和无法确认的观察结果。已完成观察包含 `TaskDeliveryEffect`，而不是 Provider 执行回执；`observedAt` 不表示原操作的执行时间。当前未完成只表示结果现在不存在，不代表 Git 从未改变。检查版本是排除观察时间的不透明标识。后续人工确认与持久结算由消费方负责。参见[核验决策](../../../.agents/notes/implemented/feature/2026-10-09-root-delivery-inspection.md)。

## 模型体验

### 审查能力

#### 模型看到的内容

没有直接内容。本包不注册工具、不注入提示词，也不写入 Session 事件。Host 与模型工具 Consumer 负责展示和记录；可选的 `review_agent_changes`、`commit_agent_changes` 和 `integrate_agents` 工具返回本服务的审查数据与操作回执。

#### Token 影响

每个请求的直接 token 为零。

#### KV Cache 影响

与实时请求无关：本包绝不触及请求前缀，因此不会使 Provider 缓存复用失效。

## 已知限制与后续工作

- 仓库支持范围、输出上限与清理策略由选定的 Provider 负责。
- 本服务定义不会授权 Renderer 直接访问 Git 或文件系统。
