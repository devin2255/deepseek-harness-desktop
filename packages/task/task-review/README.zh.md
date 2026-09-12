# @deepseek-ai/dsh-task-review

[English](README.md) | 中文

Task 所有的 worktree 变更审查与交付服务定义。Provider 提供有上限的审查摘要和文件 Diff，并为 Commit、Apply 与 Discard 操作返回可持久化回执。

每个文件 Diff 都属于一个准确的 `TaskReviewRevision`。变更操作必须携带同一 revision；用户审查后 worktree 一旦发生变化，操作就会失败。请求携带完整、已记录的 `TaskWorktreeAssignment`，Consumer 不能提供任意仓库路径。

本包不包含 Git 实现或界面文案。Provider 负责仓库检查、变更操作串行化、预检和操作标识；Task Consumer 把成功回执记录到根 Session 日志。

## 模型体验

### 仅供操作者使用的 Task 审查

#### 模型看到的内容

没有。`ctx.taskReview` 只服务于 Host 侧 Consumer：本包不注册工具、不注入提示词，也不写入 Session 事件，因此没有请求字段会携带它的数据。

#### Token 影响

每个请求的直接 token 为零。

#### KV Cache 影响

与实时请求无关：本包绝不触及请求前缀，因此不会使 Provider 缓存复用失效。

## 已知限制与后续工作

- 仓库支持范围、输出上限与清理策略由选定的 Provider 负责。
- 本服务定义不会授权 Renderer 直接访问 Git 或文件系统。
