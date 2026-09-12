# Agent Note：应用拥有的任务 worktree

Status: implemented

[English](2026-09-09-application-owned-task-worktrees.md) | 中文

## 问题

桌面任务总览已经能够监督多个根 Session，但在所选项目目录中创建这些 Session，会让并行 Agent 共用同一个可写 checkout。Task 身份也只保留源 Workspace，无法在 Renderer 重载或 Host 冷态回放后证明 Agent 实际使用的分支与目录。

## 决策

本决策实现了更完整的[桌面多 Agent 指挥中心提案](../../proposed/feature/2026-08-14-desktop-agent-mission-control.md)中的根任务隔离阶段。从桌面任务总览创建根任务时，使用 `isolation: worktree` 请求 `session.create`。所选 Workspace 仍表示源项目。Host 在创建 Session 之前向 `taskWorktrees` 能力请求应用拥有的执行目录，使 Session 从该目录启动，并通过 `ctx.tasks` 追加完整分配。worktree Session 不会加入源 Workspace 基于 cwd 的 Session 记账。

`dsh-task-worktree` 是服务定义。分配记录 Task 与 Workspace id、规范化源路径与执行路径、确定的分支、基准提交、源 `HEAD`、源目录脏状态及摘要和创建时间。`dsh-task-worktree-local` 是随产品交付的本地 Git 提供方。`dsh-host-apiproxy` 是消费方，Task Session 提供方负责持久 `task/worktree-assigned` 回放与投影。TypeScript SDK、Python SDK、客户端运行时、任务总览、Workspace 选择器、会话标题栏和 fixture 传输层投影同一组字段，不改写路径。

本地提供方会规范化所选目录，只接受已有 `HEAD` 的 Git 仓库根目录。它会在启动 Agent 前拒绝嵌套在其他 checkout 中的仓库、submodule 工作区、空间不足、受管路径已占用和受管分支已占用。创建操作按源仓库串行执行。受管仓库 key 与任务 key 是 SHA-256 前缀，因此路径与分支分别是 `$DSH_HOME/worktrees/v1/<repository-key>/<task-key>` 和 `dsh/task-<task-key>`，不会嵌入用户路径或 Session 文本。

创建前会读取包含未跟踪文件的源状态。新 worktree 从源目录已提交的 `HEAD` 开始；源目录未提交及未跟踪的更改不会被复制、修改或删除。分配会记录这些更改是否存在及其摘要。Git 创建失败时保留任何已产生的部分目录或分支，并返回恢复信息。部分失败后不会自动清理。

Host 进行幂等重试时，先读取持久 Task 行，验证匹配的 Task 与 Workspace 所有权，再要求提供方检查已记录分配。只有 Git 实时 worktree 注册表仍包含完全一致的规范路径、分支和基准提交时，才能复用。worktree 缺失或身份不一致时会拒绝继续。后续 Session 创建或分配记录失败时，会保留已经创建的 worktree 并报告其路径。

桌面端绝不会静默降级为直接写入。隔离失败时，用户仍停留在任务界面，并可选择“重试隔离”或“直接使用项目”。直接使用项目会明确提示 Agent 可能修改所选项目目录。非 Git 目录只能通过该显式选择使用。

## 曾考虑的替代方案

**复用源 checkout 并通过路径约定协调。** 不采用，因为两个进程仍会观察和修改同一工作树；UI 标记不能提供文件系统隔离。

**复制项目目录。** 不采用，因为副本会失去 Git worktree 注册，复制 ignored 与未跟踪数据，占用更多空间，并使后续整合含义不清。

**把源目录未提交更改带入每个任务 worktree。** 不采用，因为这会复制可能私密或不一致的状态，且使已记录基线无法重现。执行基线是已提交的 `HEAD`；源目录脏状态作为显式元数据保留。

**Git 失败时切换到直接模式。** 不采用，因为界面显示为隔离的任务可能写入用户 checkout。只有在失败可见后，用户通过独立操作才能进入直接模式。

**自动删除部分 worktree。** 不采用，因为 Git 创建分支或目录后的失败可能留下有用的恢复状态，而破坏性清理需要独立且经过验证的所有权生命周期。

## 结果

从同一仓库创建的两个根任务会从同一已提交基线获得不同分支与路径。它们的分配可以在 Renderer 重载和 Session 冷态回放后恢复。创建操作不会改变源 checkout，包括源目录原本已有未提交更改的情况。Git 可用性、仓库布局、可用空间和 Harness home 写入权限现在都是桌面端默认创建路径的显式前提。

本阶段只创建并验证根任务 worktree。它不创建独立的子写入 Agent worktree，不合并并行写入者，不把更改应用到源 checkout，不提交结果，也不归档、丢弃 worktree 或清理由部分失败保留的内容。这些操作属于审查与整合能力，并且必须沿用同样的拒绝式所有权规则。

## 验证

提供方测试使用一次性真实 Git 仓库，覆盖干净与脏源目录、并行创建、不受支持的布局、空间不足、目标占用、检查发现身份不一致和失败保留。Host 测试覆盖显式隔离、幂等复用、能力缺失、预检失败、Session 失败和持久分配记录。Task、客户端、TypeScript SDK 与 Python SDK 测试覆盖严格回放与字段投影。浏览器组装测试通过生产插件清单创建隔离的 fixture Task。真实 Electron 验收从同一个一次性 Git 仓库创建两个隔离 Session，检查不同路径与分支、确认干净源目录不变，然后重载 Renderer 并比较两份持久分配。
