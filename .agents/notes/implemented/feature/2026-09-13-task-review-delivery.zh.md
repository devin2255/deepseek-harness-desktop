# Agent Note：Task 审查与交付

Status: implemented

[English](2026-09-13-task-review-delivery.md) | 中文

## 问题

应用拥有的 worktree 已经能够隔离并行根 Task，但桌面端无法检查或交付其中的结果。用户必须自行定位受管目录并手动运行 Git，Task 日志也无法证明实际审查、提交、应用或丢弃的是哪个 revision。让 Renderer 获得文件系统或 Git 权限还会破坏桌面权限模型。

## 决策

`dsh-task-review` 定义仅供 Host 使用的审查与交付服务。它公开有界摘要和单文件 diff 读取，以及提交、应用和丢弃变更。每个变更请求都携带确切的审查 revision。`dsh-task-review-local` 通过受管进程能力使用 Git 实现该服务。`dsh-host-apiproxy` 是唯一远程消费方：它解析持久根 Task worktree 分配，强制执行生命周期与序列前提，调用提供方，并通过 `ctx.tasks` 记录成功回执。

审查摘要标识 Task、Workspace、已记录基线、当前 worktree commit、当前源 `HEAD`、分支、源目录脏状态、有界文件列表和不透明 revision。revision 对 worktree 身份及完整变更内容进行哈希，包括未跟踪文件。文件路径必须是该摘要中确切且规范化的成员。文本 diff 是有界统一 patch；二进制与截断结果使用显式值表示，不伪装为空成功结果。

提交要求 Task 已就绪且审查完整、当前有效。它暂存已审查 worktree，在 Task 分支创建一个 commit，不修改源 checkout。应用要求使用确切的已记录 Task commit 和已提交 revision。它按规范源仓库串行执行，要求源目录在请求的 `HEAD` 上保持干净，生成从分配基线到 Task commit 的单个有界二进制 patch，并在任何源目录变更前执行三方检查。临时索引提供第二次无副作用模拟。随后提供方再次检查源 `HEAD` 和状态，把相同字节应用到真实索引与工作树。源 `HEAD` 保持不变。

丢弃只针对 Git 实时注册表中完全一致的受管 worktree。脏的未提交内容必须显式确认损失，并报告为不可恢复。已提交分支会被保留，其 commit 作为恢复信息返回。清理失败时不会声称 worktree 已删除。

Task Session 日志拥有 `task/review-committed`、`task/review-applied` 和 `task/review-discarded`。严格回放会校验 Task 与 Workspace 所有权、操作顺序、分支与 commit 身份、审查 revision 和源 `HEAD` 不变量。通用审查决定可以要求修改或声明就绪，但不能伪造由 Git 支撑的交付结果。TypeScript 与 Python SDK 投影完全相同的操作和值。

客户端运行时拥有异步审查状态和类型化操作。`dsh-client-ui-task-review` 提供独立审查工作区，显示验收标准、风险、验证证据、分支与基线事实、变更文件、统一 diff，以及相互独立的“要求修改”“提交”“应用”和“丢弃”操作。加载、空结果、二进制、截断、过期、冲突、确认、成功和重试状态均保持可见。Renderer 绝不获得原生路径权限或 Git 命令界面。

## 曾考虑的替代方案

**在 Electron Main 或 Renderer 中运行 Git。** 不采用，因为展示代码会获得仓库变更权限，并绕过 Host 生命周期、授权、持久化与插件替换机制。

**Agent 完成后立即应用。** 不采用，因为完成不等于人工批准，并发源状态可能已变化，自动变更也无法证明用户检查过哪些内容。

**把 Task commit merge 或 cherry-pick 到源分支。** 当前阶段不采用，因为两种操作都会移动源历史，并引入更宽的冲突与回滚语义。应用保持源 `HEAD` 不变，留下可检查的暂存结果。

**只使用 worktree `HEAD` 作为审查 token。** 不采用，因为暂存、未暂存和未跟踪更改可以在不移动 `HEAD` 的情况下变化。不透明 revision 包含所有已审查内容。

**丢弃时删除所有 Task 分支。** 不采用，因为已提交分支是恢复机制。系统只删除经验证的受管 worktree。

## 结果

隔离根 Task 现在拥有从并发执行、人工审查到源目录暂存结果的完整路径。过期内容、脏或已移动的源目录、冲突、无效路径、不完整输出和 Git 身份缺失都会显式失败。成功交付事实可在 Renderer 重载和冷态回放后恢复。应用不会创建用户最终的源目录 commit；这仍是有意保留的项目操作。子写入 Agent 隔离、并行写入者自动协调、Task 归档和部分 worktree 创建失败的清理属于独立后续工作。

## 验证

服务与本地提供方测试覆盖类型化注册、严格不变量、真实 Git 摘要与 diff、文本与二进制数据、截断、取消、过期 revision、身份失败、提交、干净源目录应用、脏和已移动源目录拒绝、保持源状态不变的冲突预检，以及感知可恢复性的丢弃。Task 与 Host 测试覆盖严格事件回放、生命周期授权、序列比较、持久回执和安全错误投影。TypeScript 与 Python SDK 测试覆盖一致的协议词汇。客户端测试覆盖运行时刷新和所有用户可见审查状态。无密钥组装 Web 场景覆盖要求修改、提交、应用、文件选择和持久成功。Electron 验收使用一次性真实仓库交付文本与二进制更改，证明冲突预检保持源 `HEAD`、索引、状态和文件字节不变，在丢弃时保留已提交分支，并在 Renderer 重载后比较持久应用和丢弃回执。
