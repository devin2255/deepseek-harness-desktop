# 桌面端 Host 崩溃恢复实施计划

[English](2026-09-21-desktop-host-crash-recovery.md) | 中文

**目标：** 检测 Harness 在就绪后的意外退出，撤销失效运行时的桌面权限，并允许用户启动一个新的 Host；新 Host 重建持久化 Task，且不重放尚未确认的工具调用。

**架构：** Harness supervisor 在每个就绪 handle 上发布一次不可变的退出结果。Electron Main 负责恢复编排：意外退出会退役原生后台状态与授权窗口，然后打开现有的本地恢复窗口。恢复必须由用户显式触发，不能自动重启。Retry 创建新的单次启动 capability，并依靠 Session 持久化在 Task 投影恢复前修复被中断的 turn。

---

### 任务 1：发布就绪 Harness 的退出结果

**文件：**
- 修改：`apps/desktop/src/harness-supervisor.ts`
- 修改：`apps/desktop/tests/harness-supervisor.spec.ts`

- [x] **步骤 1：增加失败的 supervisor 测试**

要求就绪 handle 暴露一个不会 reject 的退出结果，并携带 utility process 退出码。覆盖 `stop()` 前后退出、重复 `stop()` 和监听器清理。

- [x] **步骤 2：实现退出结果**

使用现有运行期 exit 监听器 resolve 该结果。启动失败仍由启动 Promise 承担，并保留当前有界且幂等的停止行为。

- [x] **步骤 3：验证聚焦 supervisor 测试套件**

运行 `pnpm exec vitest run apps/desktop/tests/harness-supervisor.spec.ts`。

### 任务 2：把运行时崩溃转移给本地恢复流程

**文件：**
- 修改：`apps/desktop/src/window.ts`
- 修改：`apps/desktop/src/main-lifecycle.ts`
- 修改：`apps/desktop/src/startup-state.ts`
- 修改：`apps/desktop/tests/window.spec.ts`
- 修改：`apps/desktop/tests/main-lifecycle.spec.ts`
- 修改：`apps/desktop/tests/startup-state.spec.ts`

- [x] **步骤 1：增加失败的生命周期测试**

要求就绪 Harness 意外退出后释放后台状态、销毁授权桌面窗口、发布已脱敏的 `service-exited` 失败，并且只创建一个本地恢复窗口。覆盖桌面窗口已关闭、并发 Quit、已被替代 attempt 的延迟退出、恢复窗口创建失败和重复退出通知。

- [x] **步骤 2：增加显式桌面窗口销毁操作**

只暴露由所属 `BrowserWindow` 支持的幂等 `destroy()` 操作。销毁必须触发现有的授权释放路径和受控 close 回调。

- [x] **步骤 3：实现串行化崩溃恢复**

启动过程一旦提交 handle 就观察其退出结果。忽略主动停止、已被替代的 attempt 和关机。意外退出时停止发布过期活动、撤销旧 Renderer、显示本地失败界面，并保留失败 attempt，直到 Retry 或 Exit 完成处理。

- [x] **步骤 4：只在显式 Retry 后启动新的权限**

Retry 等待崩溃清理完成，使用新的 capability 启动一个 Harness，并且只在鉴权就绪后完成窗口交接。恢复期间的 Quit 必须阻止任何延迟窗口或进程再次出现。

- [x] **步骤 5：验证聚焦生命周期测试套件**

运行 `pnpm exec vitest run apps/desktop/tests/harness-supervisor.spec.ts apps/desktop/tests/main-lifecycle.spec.ts apps/desktop/tests/startup-state.spec.ts apps/desktop/tests/window.spec.ts`。

### 任务 3：通过组装应用证明持久 Task 恢复

**文件：**
- 修改：`apps/desktop/tests/desktop.e2e.ts`
- 修改：组装证据所需的最小现有无密钥 Session 或 Task 恢复示例

- [x] **步骤 1：增加真实 Electron 崩溃场景**

创建一个 turn 正在执行的临时 Task，在不请求桌面端关闭的情况下终止所属 Harness utility process，并验证授权任务窗口被恢复窗口替换。

- [x] **步骤 2：验证手动恢复语义**

确认 Retry 前不会重启 Host。Retry 后，要求新的鉴权 Renderer 显示同一个 Task 及其中断状态，已提交事件保持不变，并且不会重复工具副作用。

- [x] **步骤 3：验证 Renderer 与后台行为**

在任务窗口已关闭、Harness 由托盘持有时重复崩溃。要求只出现一个恢复窗口，并且不再显示从失效 Host 派生的通知或托盘状态。

- [x] **步骤 4：运行组装证据**

运行聚焦桌面 E2E 标题、受影响的无密钥快照和持久化恢复测试。

### 任务 4：记录并验证恢复生命周期

**文件：**
- 修改：`apps/desktop/README.md`
- 修改：`apps/desktop/README.zh.md`
- 修改：`.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.md`
- 修改：`.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.zh.md`
- 修改本计划及其中文对照文件

- [x] **步骤 1：记录当前恢复行为**

记录手动重试决策、权限替换、Task 重建和剩余限制，不重复 Session 持久化内部细节。

- [x] **步骤 2：重新记录双语配对**

单遍更新各对照文件，然后针对每个已修改配对运行 `pnpm run verify-translation-pairing --write`。

- [x] **步骤 3：运行与发布风险相称的检查**

运行聚焦测试、受影响快照、桌面真实 Electron E2E、`pnpm run typecheck`、`pnpm run lint`、`pnpm run doc-sync`、`pnpm run build`、`git diff --check` 和仓库 pre-push 工作流。

- [ ] **步骤 4：提交并推送完整恢复切片**

必须等待主 CI 与 Windows 安装器矩阵通过，才能把异常 Host 恢复视为已交付。
