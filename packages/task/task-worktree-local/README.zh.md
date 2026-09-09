# @deepseek-ai/dsh-task-worktree-local

[English](README.md) | 中文

`ctx.taskWorktrees` 的本地 Git Provider。它从源 Workspace 已提交的 `HEAD` 创建根 Task 的集成 worktree，路径位于 `DSH_HOME/worktrees/v1` 下，并使用确定性的哈希目录和 `dsh/task-*` 分支。源检出中的未提交更改会被记录为状态摘要，但绝不会复制到隔离检出或被其删除。

预检要求 Workspace 是仓库根目录、存在已提交 HEAD、不属于上级仓库、托管路径和分支均未占用，并满足配置的可用空间保留量。每次 Git 调用都通过托管 subprocess 服务执行，不使用 shell，并明确限制输出、截止时间和终止宽限期。创建失败时保留局部目录和分支以供检查，而不是强制删除。

仅当 Git 注册的路径、分支和 HEAD 仍与记录分配一致时，`inspect` 才返回 `available`。缺失或已改变的状态只会报告，不会修复。

## 配置

- `dshHome` — Harness 数据根目录；省略时依次采用 `DSH_HOME` 和 `~/.dsh`。
- `minFreeBytes` — 创建前要求的可用空间；默认 512 MiB。
- `gitCommand` — 裸名称或绝对 Git 可执行文件；默认为 `git`。
- `commandTimeoutMs` — 每条 Git 命令的截止时间；默认 30 秒。
- `terminateGraceMs` — 托管进程树的终止宽限期；默认 2 秒。
- `maxOutputBytes` — 每个流的完整输出上限；默认 1 MiB。

## 模型体验

无。Provider 执行 Host 所有的 Git 操作，不添加模型可见文本。

## 已知限制与后续工作

- Git submodule 和位于仓库根目录下方的 Workspace 会被拒绝。
- Apply、Commit、Discard、子写入 Agent worktree 和孤立目录恢复界面属于后续审查与集成能力。
