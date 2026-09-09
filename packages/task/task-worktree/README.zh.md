# @deepseek-ai/dsh-task-worktree

[English](README.md) | 中文

应用托管 Task 集成 worktree 的服务定义。Provider 为一个根 Task 创建隔离 Git 检出，并返回完整的分配事实，由 Task 消费方将其记录到根 Session 日志。`inspect` 会将这些记录事实与实时 Git 注册信息比较，但不会执行修复或删除。

创建操作绝不允许隐式回退到直接工作区。消费方 Host 决定是否将直接执行作为明确备选，并通过普通 Session 所有权记录所选执行目录。

## 模型体验

无。此包声明 Host 能力，不添加工具或模型可见文本。

## 已知限制与后续工作

- 此包不定义 Apply、Commit、Discard 或子写入 Agent 集成操作。
- Provider 特有的仓库支持范围和存储布局不属于此服务定义。
