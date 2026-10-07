# Agent Note: 隔离 subagent 写入准备

Status: implemented

[English](2026-10-06-isolated-subagent-writer-preparation.md) | 中文

## 问题

桌面的普通[只读子 agent](2026-10-06-desktop-read-only-delegation.md) 无法并行实现更改。授予它们共享检出的写权限会破坏[根任务隔离](2026-09-09-application-owned-task-worktrees.md)。写入执行必须在 Agent 可见之前拥有独立目录、固定权限和持久身份。

## 决策

spawn Provider 接受显式 `workspaceMode: isolated-worktree` 选择。只有 cwd 与记录的托管集成 worktree 相符且具备写入权限的根 Task 才能使用它。Provider 在等待准备之前捕获根权限，要求干净且已提交的集成基线，并以预留的子 Session id 创建独立 worktree。worktree 服务在创建分支或目录之前拒绝变化的捕获 HEAD 或脏源状态。根任务创建保留其独立的脏源策略。

共享单次运行驱动器在等待 Provider 的私有准备能力之前捕获元数据和模型路由。准备提供 cwd、`workspace-write`、审批 `never` 和未发布设置；绝不复制根任务的完整访问权限。工厂拥有子 agent 发布和回滚。失败或取消时保留已创建的 worktree 作为恢复数据，而非活跃 Agent。

不可变且模型不可见的 `subagent/worktree-assigned` 事件记录根所有者和完整子分配。Session header 持久化子执行目录。根与子日志共享严格分配解码，Provider 的不变量将事件与实际 Session id、直接父级、来源和 cwd 比较。该事件在读取时必需；不支持的构建会拒绝读取，而非将子 agent 解释为共享工作区执行。

## 考虑过的替代方案

**使普通共享目录子 agent 可写。** 不予采纳，因为权限变化不会分离工作树。共享委派仍由部署选择，桌面保留只读默认值。

**让每个子 agent 通过工具参数选择目录。** 不予采纳，因为建议路径既不改变执行 cwd，也不记录可信所有权。Provider 在发布之前创建并记录 worktree。

**在没有执行记录支持时复用续行管理器。** 不予采纳，因为普通冷续行独立于建立子 agent 的 Provider 重建执行。[自有执行目录的续行](2026-10-07-isolated-writer-continuation.md) 提供必需的记录身份和实时校验，而不转移子 agent 生命周期所有权。

## 后果

显式配置的单次写入 agent 在独立分支和目录中执行，不复制根更改，也不修改源检出。根与子 agent 保留独立日志和权限。通用 workspace-write 仍包含平台文档规定的可写临时区域；worktree 分离不是新的内核沙箱。

桌面工具集合尚未启用此选项。[可续行写入](2026-10-07-isolated-writer-continuation.md) 共享此准备机制；显式 Integration 节点、冲突关注项、worktree 清理和子结果审查界面仍是[任务控制中心提案](../../proposed/feature/2026-08-14-desktop-agent-mission-control.md) 未完成的部分。此执行切片不代表并行协作或桌面 MVP 已完成。

## 验证

真实 Git 与 agent loop（智能体循环）测试让两个写入 agent 同时保持活跃，在相同相对文件名下写入不同内容，验证独立执行路径和相同基线，并在句柄 dispose（资源释放）后检查持久分配。源与根检出内容保持不变。直接提供方测试拒绝只读根、非根委派、缺少审查能力及未提交的集成状态，并验证根完整权限受到限制。驱动器测试验证准备拒绝、进入工厂前取消和准备前的路由捕获。不变量测试在追加和恢复发布前拒绝矛盾或重复分配，并验证配套插件的 dispose。

真实 Loader transcript（文本记录）仅替换模型响应，运行两个写入 agent 和真实文件系统工具，并保留冷检查证据。TypeScript 与 Python SDK 子进程测试在任务树通知中保留同一子分配 fixture（测试前置数据），不会将其加入根事件流。
