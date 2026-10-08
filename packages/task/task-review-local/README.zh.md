# @deepseek-ai/dsh-task-review-local

[English](README.md) | 中文

`ctx.taskReview` 的本地 Git Provider。每次检查前，它都会使用 Git 的实时 worktree 注册表验证完整、已记录的 worktree 分配，再以记录的基准提交比较 Task worktree。摘要包含已提交、已暂存、未暂存、重命名、删除、冲突与未跟踪变更，同时不会修改源检出目录。

Review revision 会散列相对于记录基准的最终变更路径、条目模式与内容，并归一化不会改变结果文件的纯暂存状态变化。文件 Diff 必须携带已显示的 revision 和准确的成员路径；任意绝对路径、路径穿越、过期审查、worktree 丢失与分支分叉都会以拒绝方式失败。返回的文件列表和 patch 使用可配置上限，并明确表示截断状态。

Commit 会暂存完整、已审查的最终文件树，并在 Task 分支写入一个 commit。Apply 要求 Task worktree 已提交且干净，并要求源检出目录在已显示的 source HEAD 上保持干净。它先运行 Git 三方检查，再针对隔离的临时 index 模拟完整三方 Apply；只有模拟成功，同一份有上限 patch 才会进入真实 source index。Discard 会在移除未提交数据前要求明确确认，保留 Task 分支，并报告是否仍有可恢复 commit。

每条 Git 命令都不经过 shell，而是通过受管子进程服务运行，并遵守已配置的输出、截止时间和终止上限。

Commit、Apply、Integrate 和 Discard 按规范化的 Git 公共目录共享同一个进程内变更队列。因此，即使记录的源目录不同，根与子 worktree 的 Provider 变更也不会交叉执行；不同仓库仍相互独立。仓库发现发生在入队之前，排队操作开始执行时会再次检查取消。这不会阻止 agent（智能体）的文件系统写入、外部 Git 命令、钩子或其他进程改变仓库。

批量集成要求 Git 支持 `merge-tree --write-tree`，根与已提交子级的审查版本准确，且工作树干净。它将完整合并历史准备为不可达 Git 对象，重新检查每项选择，再向根执行 worktree 发布一次快进。冲突不改变任何分支、index 或工作树。调用方取消会停止准备，但不会中断最终有界发布或验证。发布失败会报告错误，不进行破坏性 reset；外部 Git 写入者与钩子不受锁定。参见[集成决策](../../../.agents/notes/implemented/feature/2026-10-07-batch-writer-integration.md)。

## 配置

- `gitCommand`——Git 可执行文件的名称或绝对路径；默认值为 `git`。
- `commandTimeoutMs`——每条 Git 命令的截止时间；默认值为 30 秒。
- `terminateGraceMs`——受管进程树的终止宽限时间；默认值为 2 秒。
- `maxOutputBytes`——每个完整输出流的校验上限；默认值为 16 MiB。
- `maxDiffBytes`——返回的 UTF-8 patch 上限；默认值为 2 MiB。
- `maxPatchBytes`——Apply stdin 的完整二进制 patch 上限；默认值为 16 MiB。
- `maxFiles`——摘要返回的文件数量；默认值为 2,000。
- `maxIntegrationInputs`——每批集成选中的写入者数量上限；默认值为 16。

## 模型体验

### Git 审查能力

#### 模型看到的内容

没有直接内容。本 Provider 不提供工具、提示词、Session 事件或请求字段；Consumer 负责展示和记录。可选的 `review_agent_changes`、`commit_agent_changes` 和 `integrate_agents` 工具公开它的有上限 Git 审查数据与操作回执。

#### Token 影响

每个请求的直接 token 为零。

#### KV Cache 影响

与实时请求无关：本 Provider 绝不触及请求前缀，因此不会使 Provider 缓存复用失效。

## 已知限制与后续工作

- Apply 会在源检出目录暂存已审查 patch，但不会在源分支创建 commit。
- 暂不支持 Submodule、自动解决冲突和跨进程执行租约。
