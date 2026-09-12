# @deepseek-ai/dsh-task-review-local

[English](README.md) | 中文

`ctx.taskReview` 的本地 Git Provider。每次检查前，它都会使用 Git 的实时 worktree 注册表验证完整、已记录的 worktree 分配，再以记录的基准提交比较 Task worktree。摘要包含已提交、已暂存、未暂存、重命名、删除、冲突与未跟踪变更，同时不会修改源检出目录。

Review revision 会散列 tracked 二进制 patch 和每个 untracked 条目的内容摘要。文件 Diff 必须携带已显示的 revision 和准确的成员路径；任意绝对路径、路径穿越、过期审查、worktree 丢失与分支分叉都会以拒绝方式失败。返回的文件列表和 patch 使用可配置上限，并明确表示截断状态。

每条 Git 命令都不经过 shell，而是通过受管子进程服务运行，并遵守已配置的输出、截止时间和终止上限。

## 配置

- `gitCommand`——Git 可执行文件的名称或绝对路径；默认值为 `git`。
- `commandTimeoutMs`——每条 Git 命令的截止时间；默认值为 30 秒。
- `terminateGraceMs`——受管进程树的终止宽限时间；默认值为 2 秒。
- `maxOutputBytes`——每个完整输出流的校验上限；默认值为 16 MiB。
- `maxDiffBytes`——返回的 UTF-8 patch 上限；默认值为 2 MiB。
- `maxFiles`——摘要返回的文件数量；默认值为 2,000。

## 模型体验

### 仅供操作者使用的 Git 审查

#### 模型看到的内容

没有。本 Provider 为 Host 侧 Consumer 实现 `ctx.taskReview`，不提供工具、提示词、Session 事件或请求字段。

#### Token 影响

每个请求的直接 token 为零。

#### KV Cache 影响

与实时请求无关：本 Provider 绝不触及请求前缀，因此不会使 Provider 缓存复用失效。

## 已知限制与后续工作

- Commit、Apply 与 Discard 变更操作由下一交付阶段实现。
- Submodule 与子 writer worktree 集成不属于只读审查检查范围。
