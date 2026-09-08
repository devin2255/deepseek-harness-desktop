# @deepseek-ai/dsh-task-session

[English](README.md) | 中文

持久 Task 服务的 Session Provider。每个非子 Agent 根 Session 重建为一个 Task，只有连续的 `origin: 'subagent'` 后代才归入该根，并将持久日志与按代次划分的实时事实组合起来。冷态历史无需恢复 Agent 即可检查；准确的实时 Session 日志会覆盖持久快照。

## 服务：`TaskSessionProvider`（ctx 键：`tasks`）

### 公开 API

- `snapshot(): TaskListSnapshot` 返回分离的基线，包含全部已知根、后代 id、持久任务事实、派生状态、注意事项、新鲜度和当前运行时代次。
- `onChanged(listener): () => void` 发布分离的全行 upsert 与移除项。单个监听器失败会被记录，且不会阻止后续监听器。
- `replaceLiveGeneration(generation, facts): void` 原子替换当前或更新代次的活动与交互注意事项。旧代次或已失效代次的发布会被忽略。
- `invalidateLiveGeneration(generation): void` 保留最近已知的实时事实，但将受影响行标为 `disconnected`，直到更新的基线到达。
- `define`、`updateCriterion`、`recordRisk` 和 `review` 串行执行比较并设置写入，验证根与同树证据，并且只追加一个全值事件。

## 投影规则

即使普通 fork 的 header 指向父 Session，它仍是独立根 Task。子 Agent 链必须无环地抵达一个当前存在的非子 Agent 根；祖先关系畸形时，Provider 启动会失败，而不是把工作静默分配给错误 Task。已知 Session 的日志无法检查时，仍以 `unavailable` 行显示。

状态优先级依次为：可执行注意事项、未解决失败、运行中活动、审查中、显式证明的就绪，最后是已安定。就绪必须有 `ready` 决定、所有条件均为满足或豁免，并且所有风险均已解决。空闲状态绝不代表完成。

待处理的持久审批与最近一次未解决的轮次失败会成为注意事项，其标识来自源请求或事件，而不是展示文本。实时事实同时指定根和准确的所属 Session；所属 Session 缺失或不属于该根的事实会被忽略。

## 模型体验

### 仅面向操作人员的 Task 投影

#### 模型可见内容

无。`TaskSessionProvider` 读取面向操作人员的 Session 事件与实时事实，但不注册工具、不注入提示词，也不贡献模型可见消息或请求字段。

#### Token 影响

每次请求的直接 token 数为零。

#### KV Cache 影响

与实时请求无关：该 Provider 从不组装或修改请求前缀，因此不会使提供方缓存复用失效。

## 已知限制与暂缓事项

- Provider 当前在进程内暴露服务；Host RPC 与客户端 store 投影是后续独立 Consumer。
- 持久注意事项当前来自审批审计对和终止轮次失败。验证、合并与审查系统接入各自能力时，必须发布其支持的注意事项事实。
- 外部持久化变化只在启动或实时 Session 生命周期经过本进程时被观察；跨进程日志修改尚无监听流。
- 从实时集合移除且从未物化到持久化的 Session 会同时移除其 Task 行，因为已不存在持久事实来源。
