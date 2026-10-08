# Agent Note: 根任务交付执行互斥

Status: implemented

[English](2026-10-08-root-delivery-execution-exclusion.md) | 中文

## 问题

[根任务交付](../feature/2026-09-13-task-review-delivery.md)在异步 Git 操作前检查 Task 就绪状态。这一观察不能阻止根 Agent（智能体）随后启动。Provider 的仓库队列为 Git 变更排序，不为文件系统工具或 Agent 执行排序，因此单凭就绪快照无法安全授权并发交付。

## 决策

Host 在调用 Commit、Apply 或 Discard 前获取根任务执行权，并保留到 Provider 和回执记录都完成。已附加 Agent 使用 `Agent.runMaintenance` 现有的同步空闲获取；没有 Agent 的根任务使用[离线 Session 保留](2026-10-08-offline-session-reservations.md)。这一获取过程中的竞争在 Git 开始前返回 `task-active`；生命周期或序号验证可能更早拒绝。不同根任务保留独立的执行归属。

驻留操作组合请求与 Agent 取消信号。取消传递至 Provider，但绝不通过竞争其 Promise 来提前释放执行权。成功的 Provider 结果仍交给回执记录器；成功、Provider 失败和记录失败都在完成后释放归属。不为这一进程内获取增加 Agent 状态或 Session 事件。

## 考虑过的替代方案

**Git 结束后再检查状态。** 拒绝，因为检测前竞争执行可能已经改动文件。

**把每个冷根任务恢复为维护中的 Agent。** 拒绝，因为交付不需要模型执行或 Agent 组合。离线保留无需激活 Session 即可阻止发布。

**只保留仓库变更队列。** 拒绝，因为普通 Agent 文件系统和 shell 写入不使用它。

## 后果

受支持的根任务执行不能与这些 Host 交付操作重叠。维护仍接受排队输入，Task 元数据命令也仍可追加事件。它们改变序号后，可能在 Git 成功后拒绝回执。被中断的变更没有持久化意图记录。因此，这种互斥没有建立原子交付、崩溃核对、子级集成控件、跨进程锁定或完整发布就绪保证。

根任务交付、离线保留、[手动维护](../feature/2026-07-30-queued-manual-compaction.md)、[批量集成](../feature/2026-10-07-batch-writer-integration.md)及[集成历史](../feature/2026-10-08-task-integration-history.md)记录继续保持活跃：本决策加强根任务执行归属，但不替代其独立的权限、发布、回放或输入排序依据。

## 验证

Host 回归分别保持 Provider 与回执结果，拒绝竞争激活或维护，传递两方取消，并验证每种结果后的释放。Loader 快照从真正的冷 Session 开始，执行三种真实 Git 变更，再以驻留 Agent 重复这些操作，验证应用后的源文件字节、未改变的源 HEAD、保留的提交分支、已记录回执和随后的激活。
