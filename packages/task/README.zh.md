# task/：持久任务投影能力族

[English](README.md) | 中文

持久任务事件词汇及其跨会话投影实现。服务定义将可安全传输的值与基于 Session 的 Host Provider 分离。

| 包 | 角色 | ctx 键 |
|---|---|---|
| `task/` | 服务定义、带品牌的任务值与全值持久 Session 事件 | `tasks` |
| `task-session/` | Session 持久化 Provider、子 Agent 树聚合、实时代次与注意事项投影 | `tasks` |
| `task-worktree/` | Task 所有的隔离 Git worktree 服务定义 | `taskWorktrees` |
| `task-worktree-local/` | 提供拒绝式预检和实时分配检查的本地 Git Provider | `taskWorktrees` |

任务事实仅写入日志，不进入模型请求或模型可见的 Session 表面。Provider 启动时列出已持久化 Session，再以准确的实时 Session 日志覆盖，并且只把连续的 `origin: 'subagent'` 祖先链归入根 Task。普通 fork 仍是独立根任务。

`TaskSessionProvider` 发布分离的全行快照。持久定义、条件、风险、审查决定、待处理审批和最近一次运行失败都从 Session 事件回放。按代次划分的活动和注意事项可以原子替换；代次失效后保留最近事实并标记为 `disconnected`，直到新的基线到达。命令使用 `expectedSeq` 比较根日志，针对同一 Task 树验证证据，并在不恢复 Agent 的情况下只追加一个事件。

Task worktree Provider 创建和检查执行目录；Task 消费方仍负责把返回的分配事实记录到根 Session 日志。创建操作绝不会静默回退到用户的源检出目录。
