# Task 审查与交付实施计划

[English](2026-09-13-task-review-delivery.md) | 中文

**目标：** 为每个隔离的根 Task 提供完整的审查与交付工作区，包括受限的文件摘要与 Diff、显式 Commit、安全 Apply、修改请求，以及能说明可恢复性的 Discard。

**架构：** `@deepseek-ai/dsh-task-review` 定义仅 Host 可用的能力 seam。`@deepseek-ai/dsh-task-review-local` 通过受管 subprocess 服务和 Git 实现该能力，`host-apiproxy` 拥有授权、Task 生命周期校验和持久事件写入。审查数据依据已记录的 `TaskWorktreeAssignment` 按需生成；只有交付回执进入 Session 日志。`@deepseek-ai/dsh-client-ui-task-review` 通过 Client slot 渲染独立审查模式。Electron Main 和 Renderer 都不获得文件系统或 Git 权限。

**安全性：** 读操作均限制输出与时间。Commit 绝不改变源检出。Apply 要求已提交的 Task 交付，按规范仓库串行，重新校验源 HEAD 和干净状态，并在变更前执行三方检查；预检发现冲突时保持源目录不变。Discard 必须显式触发，报告未提交数据是否可恢复，保留已提交的 Task 分支，且绝不猜测哪个目录或分支属于应用。

---

## Task 1：定义审查能力和线路语汇

**文件：**

- 新建：`packages/task/task-review/package.json`
- 新建：`packages/task/task-review/tsconfig.json`
- 新建：`packages/task/task-review/src/types.ts`
- 新建：`packages/task/task-review/src/index.ts`
- 新建：`packages/task/task-review/src/invariant.ts`
- 新建：`packages/task/task-review/tests/service.spec.ts`
- 新建：`packages/task/task-review/tests/invariant.spec.ts`
- 新建：`packages/task/task-review/README.md`
- 新建：`packages/task/task-review/README.zh.md`
- 新建：`packages/task/task-review/README.i18n.yaml`
- 修改：`packages/task/README.md`
- 修改：`packages/task/README.zh.md`

- [ ] **步骤 1：编写失败的 Service Definition 测试**

定义带品牌的审查快照和操作标识。将 `TaskReviewSummary`、`TaskReviewFile`、`TaskFileDiff`、`TaskCommitReceipt`、`TaskApplyReceipt` 和 `TaskDiscardReceipt` 建模为不可变、可安全传输的值。文件状态覆盖新增、修改、删除、重命名、复制、类型变更、未跟踪和冲突。二进制和被截断的 Diff 必须显式表示，不能冒充空文本。

服务暴露 `summarize`、`diff`、`commit`、`apply` 和 `discard`。每个方法都接收完整的 Worktree 分配以及可选的中止信号。变更请求携带确切的预期审查修订号；过期审查状态会失败，不会应用比用户所审内容更新的文件系统状态。

- [ ] **步骤 2：确认 RED**

运行：`pnpm exec vitest run packages/task/task-review/tests`

预期：失败，因为该包和服务尚不存在。

- [ ] **步骤 3：实现 Service Definition 和不变式配套模块**

使用带品牌的不透明 id、可判别错误、完整 JSDoc、`ctx.taskReview` 的声明合并、由 effect 拥有的注册，以及包所有的运行时不变式。不在 Service Definition 中嵌入 Git 命令、UI 标签或部署默认值。

- [ ] **步骤 4：确认 GREEN 并提交**

运行：`pnpm exec vitest run packages/task/task-review/tests`

提交：`feat(task): define task review capability`

## Task 2：实现受限的本地审查快照与文件 Diff

**文件：**

- 新建：`packages/task/task-review-local/package.json`
- 新建：`packages/task/task-review-local/tsconfig.json`
- 新建：`packages/task/task-review-local/src/config.ts`
- 新建：`packages/task/task-review-local/src/git.ts`
- 新建：`packages/task/task-review-local/src/index.ts`
- 新建：`packages/task/task-review-local/src/invariant.ts`
- 新建：`packages/task/task-review-local/tests/review.spec.ts`
- 新建：`packages/task/task-review-local/tests/invariant.spec.ts`
- 新建：`packages/task/task-review-local/README.md`
- 新建：`packages/task/task-review-local/README.zh.md`
- 新建：`packages/task/task-review-local/README.i18n.yaml`

- [ ] **步骤 1：编写真实 Git RED 测试**

使用一次性仓库覆盖：分配基础之后已提交的变更、已暂存与未暂存的跟踪变更、未跟踪文本、重命名、删除、二进制内容、空审查、路径穿越拒绝、不可用或偏离的 Worktree、输出截断、取消和 Git 失败。源检出的字节与状态必须全部保持不变。

- [ ] **步骤 2：实现只读检查**

通过 `ctx.subprocess` 只解析一次 Git。每次操作前都根据 Git 的实时 Worktree 注册信息验证分配。从以 NUL 分隔的 Git 输出和未跟踪文件枚举构建文件列表。只有在完成精确成员关系与仓库相对路径校验后，才为指定路径生成 Patch。将规范化审查输入哈希为修订号，使变更调用能拒绝过期审查。任何方法都不读取用户提供的任意绝对路径。

- [ ] **步骤 3：确认 GREEN 并提交**

运行：`pnpm exec vitest run packages/task/task-review-local/tests/review.spec.ts packages/task/task-review-local/tests/invariant.spec.ts`

提交：`feat(task): inspect isolated task changes`

## Task 3：实现 Commit、预检 Apply 和显式 Discard

**文件：**

- 修改：`packages/task/task-review-local/src/git.ts`
- 修改：`packages/task/task-review-local/src/index.ts`
- 新建：`packages/task/task-review-local/tests/delivery.spec.ts`
- 修改：`packages/task/task-review-local/README.md`
- 修改：`packages/task/task-review-local/README.zh.md`

- [ ] **步骤 1：编写变更 RED 测试**

Commit 暂存已审查 Task Worktree 的确切内容并创建一个 Git Commit，不移动或改动源检出。它在变更集为空、Git 身份缺失、审查修订过期、分配偏离或 Git 失败时清晰失败。

Apply 消费已记录的 Task Commit。它要求源检出干净，验证规范仓库与预期源 HEAD，生成从记录基础到 Task Commit 的二进制 Patch，通过批处理 stdin 运行 `git apply --check --3way --index`，然后只在仓库锁仍拥有未变的源状态时应用相同字节。预检冲突会保持源 HEAD、索引、文件和状态不变。

Discard 在变更前报告精确的丢失类型。用户显式确认后，它只移除已注册的受管 Worktree；已提交分支保持可恢复。脏的未提交内容绝不会被描述为可恢复。失败时保留目录和诊断信息。

- [ ] **步骤 2：实现串行变更**

按规范仓库串行所有变更。通过已验证配置限制命令时间、输出、stdin Patch 大小和终止宽限。绝不调用 shell。返回完整回执，包含 Commit id、源操作前后 id、分支保留状态和清理结果。

- [ ] **步骤 3：确认 GREEN 并提交**

运行：`pnpm exec vitest run packages/task/task-review-local/tests`

提交：`feat(task): deliver reviewed worktree changes`

## Task 4：使交付状态持久且无法伪造

**文件：**

- 修改：`packages/task/task/src/types.ts`
- 修改：`packages/task/task/src/fold.ts`
- 修改：`packages/task/task/src/service.ts`
- 修改：`packages/task/task-session/src/index.ts`
- 修改：`packages/task/task-session/src/aggregate.ts`
- 修改：`packages/task/task/tests`
- 修改：`packages/task/task-session/tests`
- 修改：`packages/core/session/src/known-event-types.ts`
- 修改：`docs/subsystems/task.md`
- 修改：`docs/subsystems/task.zh.md`

- [ ] **步骤 1：编写持久转换 RED 测试**

为已提交交付、源应用和丢弃添加全值事件。回执包含审查修订号和恢复所需的精确 Git 对象 id。通用 `task.review` 可以请求修改或声明就绪，但不能伪造由 Git 支撑的终态。回放会拒绝无效顺序、Task id 不匹配、重复分配、异常对象 id，以及后代仍在运行时的终态操作。

- [ ] **步骤 2：实现比较并设置的 Task 变更**

暴露专用 `recordCommit`、`recordApply` 和 `recordDiscard` 方法。校验当前 Task 投影，并只在 Provider 操作成功后追加一个事件。聚合根据持久回执推导就绪和已结束状态，而不是使用用户可选标签。

- [ ] **步骤 3：重新生成事件投影并提交**

运行：`pnpm run gen-scoped-events`

运行：`pnpm run gen-persistence-catalog`

运行：`pnpm exec vitest run packages/task/task/tests packages/task/task-session/tests`

提交：`feat(task): record review delivery receipts`

## Task 5：暴露经授权的 Host API 和两个 SDK 投影

**文件：**

- 修改：`packages/host/apiproxy/src/api/tasks.ts`
- 修改：`packages/host/apiproxy/src/api/tasks.schema.ts`
- 修改：`packages/host/apiproxy/src/api/rpc-map.ts`
- 修改：`packages/host/apiproxy/src/api/rpc.schema.ts`
- 修改：`packages/host/apiproxy/src/api-proxy.ts`
- 修改：`packages/host/apiproxy/tests/tasks-api.spec.ts`
- 修改：`packages/sdk/protocol/src/types.ts`
- 修改：`packages/sdk/client/src/client.ts`
- 修改：`packages/sdk/server/src/server.ts`
- 修改：`packages/sdk/client/tests`
- 修改：`packages/sdk/server/tests`
- 修改：`python/sdk/src/deepseek_harness`
- 修改：`python/sdk/tests/test_client.py`

- [ ] **步骤 1：编写 Host 和 SDK RED 测试**

添加 `task.reviewSummary`、`task.reviewDiff`、`task.commit`、`task.apply` 和 `task.discard`。Host 解析根 Task 及其已记录分配，拒绝直接工作区 Task，校验生命周期前置条件，调用 Provider，然后记录返回的回执。取消和结构化 Provider 错误原样通过传输，不泄漏命令行或完整文件系统诊断。

- [ ] **步骤 2：实现 Host 消费方和两个 SDK**

TypeScript 与 Python SDK 投影相同的请求和响应语汇。任何 SDK 都不执行 Git 操作或在本地推导审查状态。

- [ ] **步骤 3：确认 GREEN 并提交**

运行：`pnpm exec vitest run packages/host/apiproxy/tests/tasks-api.spec.ts packages/sdk/client/tests packages/sdk/server/tests`

运行：`uv run --project python/sdk pytest`

提交：`feat(host): expose task review delivery`

## Task 6：添加 Client 审查对象与独立 Review 工作区

**文件：**

- 修改：`packages/client/connection/src/client/api.ts`
- 修改：`packages/client/connection/src/client/fixture.ts`
- 修改：`packages/client/runtime/src`
- 新建：`packages/client/ui-task-review/package.json`
- 新建：`packages/client/ui-task-review/tsconfig.json`
- 在新包的 `src/client/` 目录下新建 Client 入口、`TaskReview.tsx`、对应 CSS module 与 locales。
- 新建：`packages/client/ui-task-review/src/invariant.ts`
- 新建：`packages/client/ui-task-review/tests/review.client.spec.tsx`
- 修改：`packages/client/ui-task-overview/src/client/TaskOverview.tsx`
- 修改：`packages/bundle/web-app/cordis.patch.yml`
- 修改：`packages/bundle/web-app/package.json`

- [ ] **步骤 1：编写纯 props 与运行时 RED 测试**

概览界面为正在审查、已就绪或已结束的隔离 Task 打开 Review。Review 工作区显示文件树、统一 Diff、验收条件与风险、验证证据、分支和基础事实，并提供独立的 Request Changes、Commit、Apply 与 Discard 操作。加载、空内容、过期、冲突、截断、二进制、成功和重试状态始终可见且可通过键盘访问。破坏性确认状态必须说明分支与未提交数据的可恢复性。

- [ ] **步骤 2：实现 slot 和运行时操作**

将状态保持在 Client 运行时，并仅调用带类型的 Host API。每次变更和传输重连后都刷新。所选文件仍存在时保留选择。不渲染原始 ANSI、不可信 HTML 或任意文件系统链接。

- [ ] **步骤 3：确认 GREEN 并提交**

运行：`pnpm exec vitest run packages/client/runtime/tests packages/client/ui-task-review/tests packages/client/ui-task-overview/tests`

提交：`feat(client): review and deliver task changes`

## Task 7：装配、记录并证明公开闭环

**文件：**

- 修改：`apps/web/tests/task-review.snapshot.ts`
- 修改：`apps/desktop/tests/desktop.e2e.ts`
- 修改：`packages/bundle/desktop-app/tests/desktop-app.spec.ts`
- 修改：`apps/desktop/README.md`
- 修改：`apps/desktop/README.zh.md`
- 修改：`docs/architecture.md`
- 修改：`docs/architecture.zh.md`
- 新建：`.agents/notes/implemented/feature/2026-09-13-task-review-delivery.md`
- 新建：`.agents/notes/implemented/feature/2026-09-13-task-review-delivery.zh.md`
- 新建：`.agents/notes/implemented/feature/2026-09-13-task-review-delivery.i18n.yaml`

- [ ] **步骤 1：编写已装配 RED 验收**

无密钥 Web 场景打开就绪审查的 Task，选择文件、请求修改、Commit、Apply，并显示持久回执。Electron 验收创建一次性真实仓库和隔离 Task，通过 Task Worktree 写入文本和二进制变更，审查、Commit 并 Apply 到干净源检出，重载 Renderer，然后证明已应用回执得以保留。第二个场景证明冲突预检保持源检出不变；第三个场景证明显式 Discard 清理与分支保留。

- [ ] **步骤 2：挂载两个 Host 包和 Client 插件**

在 subprocess 与 task-worktree Provider 之后、`host-apiproxy` 之前挂载 `task-review-local`。在 runtime、layout、slots 和 task overview 依赖之后挂载 Client Review 插件。

- [ ] **步骤 3：重新生成所有产物**

运行：`pnpm run gen-cordis-catalog`

运行：`pnpm run gen-config-catalog`

运行：`pnpm run gen-module-graph`

运行：`pnpm run gen-scoped-events`

运行：`pnpm run gen-persistence-catalog`

- [ ] **步骤 4：运行与发布风险相称的验证**

为每个已改包运行聚焦的 JS/TS 与 Python 测试、无密钥 Web 快照和 Electron E2E。随后运行 `pnpm run build`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run doc-sync` 以及 `git diff --check`。

- [ ] **步骤 5：提交已装配闭环**

提交：`feat(desktop): ship task review and delivery`
