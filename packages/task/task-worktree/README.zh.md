# @deepseek-ai/dsh-task-worktree

[English](README.md) | 中文

应用托管执行 worktree 的服务定义。Provider 为根 Task 或隔离写入 Session 创建隔离 Git 检出，并返回完整的分配事实。`taskId` 标识该执行所属的 Session；子 agent 分配不会使子 agent 成为根 Task。消费方将事实记录到所属 Session 日志。`decodeTaskWorktreeAssignment` 严格校验记录的 JSON，而 `inspect` 将这些事实与实时 Git 注册信息比较，不会执行修复或删除。记录基准的后代提交保留同一分配身份。

创建操作可要求精确的 `expectedSourceHead` 和 `requireCleanSource`。隔离写入消费方同时使用两者，在创建检出前拒绝变化或未提交的集成基线；普通根任务创建仍记录脏源状态，但不会复制其内容。

创建操作绝不允许隐式回退到直接工作区。消费方 Host 决定是否将直接执行作为明确备选，并通过普通 Session 所有权记录所选执行目录。

## 模型体验

无，因为此 Host 能力不提供提示词、工具或模型可见的 Session 事件。

#### KV Cache 影响

无；此包既不组装也不改变模型请求。

## 已知限制与后续工作

- 此包不定义 Apply、Commit、Discard 或子写入 Agent 集成操作。
- Provider 特有的仓库支持范围和存储布局不属于此服务定义。
