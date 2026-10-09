# Task 投影与注意力队列设计

[English](2026-09-07-task-projection-attention-design.md) | 中文

状态：从已批准的桌面产品规格中提取；持久词汇、严格回放、服务定义和基于 Session 的 Provider 已经实现，Host、客户端与验收工作仍待完成。

## 目标

本阶段把桌面的活动总览升级为持久 Task 模型，但不创建第二套历史存储。一个根 Session 仍对应一个 Task，subagent Session 仍是该 Task 拥有的运行实例，Session 日志继续作为所有持久事实的权威来源。Task 服务将这些事实与明确标记的实时运行状态组合，并向 Host API 和客户端发布一份带版本的快照。

本阶段交付真实的任务状态、用户定义的成功条件、统一注意力队列和审查就绪状态。本阶段不创建 worktree、不应用变更、不渲染完整审查工作区、不增加原生通知，也不调度任务；后续阶段将消费此 Task 模型。

## 所有权

`packages/task/` 组拥有 Task 类型和实现。`@deepseek-ai/dsh-task` 是 Service Definition 和仅类型的客户端出口；`@deepseek-ai/dsh-task-session` 是折叠 Session 事件并聚合根与后代状态的 Provider。desktop bundle 组合 Provider，Host API 是远程 Consumer，客户端 runtime 将响应投影为可观察 store。

该服务不拥有 Session 创建、Agent 执行、工作区注册、交互回答、Git 状态或验证命令。它接收这些所有者提供的标识与事实，绝不根据不活跃、回合关闭或未读完成标记推断成功结果。

## 持久事实

新的 Task 事实以 whole-value Session 事件写入根 Session：

- `task/defined` 保存规范化任务目标和完整有序的成功条件列表。
- `task/criterion-updated` 保存一个已标识条件变更后的完整值，包括状态和可选证据引用。
- `task/risk-recorded` 保存一个未解决或已解决的风险，包含稳定 id、严重程度、摘要和解决说明。
- `task/review-decided` 保存明确的审查结果：要求修改、就绪、已提交、已应用、已归档或已丢弃。

Task id 和条件 id 使用 branded 类型。首个版本的证据引用指向根或其一个后代上的准确事件序号；Provider 在接受前验证该事件存在于同一 Task 树中。定义会拒绝空目标、重复条件 id、无效状态转换、外部或缺失的证据引用，以及仍有归属运行活动时的终态审查决定。更新 Task 必须通过所属服务追加事件；调用方不能直接修改投影状态。

首个任务提示词可以在 Agent 执行前创建 `task/defined`。没有定义的现有根 Session 仍作为兼容任务展示，目标未定义且没有条件；读取它们绝不写入迁移事件。

## 运行时快照

Provider 为每个非 subagent 根 Session 发布分离的 `TaskSnapshot`，其中包含根标识、已知的工作区引用、后代、活动、注意事项、条件、风险、审查状态和新鲜度标记。持久字段只来自事件回放；实时字段显式携带 `live`、`disconnected` 或 `unavailable` 新鲜度，并在其所属运行时 generation 结束时清空或标记为过期。

Task 状态采用以下优先级：

| 优先级 | 状态 | 条件 |
|---:|---|---|
| 1 | `needs-attention` | 至少存在一个可操作的注意事项。 |
| 2 | `failed` | 一个归属运行以尚未解决的失败结束。 |
| 3 | `running` | 根或后代存在权威的实时活动。 |
| 4 | `reviewing` | 执行已结束且存在审查事实，但尚未证明就绪。 |
| 5 | `ready` | 所有条件均满足、没有未解决风险，并且存在明确的就绪决定。 |
| 6 | `settled` | 执行已结束，但事实不足以声明就绪或失败。 |

绝不根据 Agent 进入 idle 推断 `ready`。断线快照不能新增或清除实时失败、运行状态或注意事项。终态交付决定在重启后仍保持持久。

## 注意力队列

`AttentionItem` 包含 branded id、所属根 Task id、准确的所属 Session id、种类、严重程度、摘要、创建时间、来源引用和可操作状态。首个版本支持审批、提问、计划审查、运行失败、合并冲突、验证失败和审查请求。未来不受支持的种类仍可通过 merge-extensible 类型表表达，但不会获得虚构的 UI 行为。

持久审批、失败、验证和审查事件可回放为注意事项。实时 Host 交互贡献 generation-scoped 的提问和计划审查事项。来源结束时只移除或解决匹配项，绝不清除相邻事项。事项标识来自来源请求或事件 id，而不是显示文本。

队列先排列可操作事项，再排列仅供参考的已解决事项，随后按严重程度、创建时间、任务更新时间、Task id 和事项 id 排序。导航使用准确的所属 Session 和权威 subagent 地址。Task 服务不回答交互；它返回由现有审批、提问、计划或审查 UI 消费的操作描述。

## API 与客户端行为

Host 通过 `task.list` 暴露完整当前快照，并通过 generation-scoped `task.changed` 流发送 whole task rows 和删除项。初始列表和每次重连基线都包含单调递增的 generation token。客户端丢弃旧 generation 的帧，并在新基线成功前保留旧行且明确显示为过期。

`task.define`、`task.updateCriterion`、`task.recordRisk` 和 `task.review` 是类型化命令。每条命令在追加事件前根据根的下一个事件序号验证目标根 Session 和 `expectedSeq`，因此两个窗口不能静默覆盖较新的 Task 事实。业务失败使用稳定 RPC code；不合法 wire 输入在分发前由 schema 拒绝。

客户端 runtime 拥有一个 `TaskListState` store，包含 `phase`、请求 `state`、`error`、`freshness`、有序 id 和按 id 索引的行。task-overview 插件从本地 Session 选择器迁移到该 store。迁移期间，没有 Task 服务的普通 Web 组合继续使用现有 Session 派生总览，并明确标注能力受限；desktop profile 强制要求 Task API，缺失时组合失败。

## 失败与生命周期行为

Provider 通过回放根日志和后代日志重建持久状态，然后订阅已提交事件。后代日志缺失时，它将其视为不可用证据并报告受影响的运行，而不是省略该运行。Session disposal 只有在排队的变更发布达到静止后才释放订阅。

交互和 Agent generation 变化必须先使实时贡献失效，才能接受任何新帧。来自旧 generation 的延迟列表响应、事件回调或交互结束不能清除较新的错误、解决较新的注意事项或发布当前新鲜度。订阅者故障会被隔离并报告，不会阻止后续订阅者。

## 验证

单元测试覆盖每种事件折叠、无效转换、状态优先级、血缘循环、缺失后代、注意事项标识、相邻事项结束、排序规则和 generation 竞态。Provider 测试使用回放事件和实时事件重建相同快照。API schema 和分发测试覆盖每个方法、过期预期序号、缺失根 Session 和能力不可用。

无密钥组装快照覆盖 Task 创建、两个并行根任务、后代注意事项、条件更新、失败、审查就绪和重连过期。真实 Electron 验收证明相同 Task 和注意事项标识可跨导航及 Renderer 重载保持。Task API 加入公开循环时，同步更新 TypeScript 与 Python SDK 投影。

## 后续阶段

下一阶段增加应用拥有的 Git worktree，并将其生命周期记录为 Task 工件和注意事项来源。审查工作区随后消费变更文件、验证证据、风险和交付决定。托盘通知、Harness Studio、签名、更新、macOS 打包和发布遥测仍是已批准桌面 MVP 中的独立交付项。
