# 桌面任务托盘实现计划

[English](2026-09-14-desktop-task-tray.md) | 中文

> **面向 Agent 工作者：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项执行本计划。各步骤使用复选框（`- [ ]`）跟踪。

**目标：** 关闭最后一个窗口后继续运行活跃的本地 Task，在原生托盘中展示权威状态，并发送可直接处理的完成与注意事项通知。

**架构：** Electron Main 通过只读轮询观察器消费已有、经过认证的 `task.list` 与 `session.list` 投影；它不接收 Renderer 上报的 Task 状态，也不创建第二份持久 Task 存储。原生后台状态控制器拥有 Tray、退出确认框和 Notification 实例。一个具名、单向的 Main 到 preload 事件只携带经过校验的 Session id，由已有 Task 导航控制器打开准确的根或子 Agent。

**技术栈：** Electron、TypeScript、Host API Proxy schema、React 客户端插件、Vitest 与 Playwright Electron。

---

### 任务 1：只读权威 Task 观察器

**文件：**
- 新建：`apps/desktop/src/task-observer.ts`
- 测试：`apps/desktop/tests/task-observer.spec.ts`
- 修改：`apps/desktop/package.json`

- [x] **步骤 1：先写失败的观察器测试**

覆盖带认证的 `task.list` 与 `session.list` 请求、Task 树运行计数、可处理注意事项身份、首份基线不通知、状态转换通知、轮询不重叠、瞬时失败恢复、请求期间释放以及畸形响应拒绝。可观察值是分离的展示数据：

```typescript
interface DesktopTaskState {
  readonly activeTaskCount: number
  readonly activeAgentCount: number
  readonly attentionCount: number
  readonly notifications: readonly DesktopTaskNotification[]
  readonly freshness: 'live' | 'unavailable'
}

interface DesktopTaskNotification {
  readonly key: string
  readonly kind: 'attention' | 'complete' | 'failed'
  readonly taskId: string
  readonly ownerSessionId: string
  readonly title: string
  readonly body: string
}
```

- [x] **步骤 2：实现观察器前确认行为断言失败**

运行 `pnpm exec vitest run apps/desktop/tests/task-observer.spec.ts`；建立最小导出 API 后，要求认证、运行计数或状态转换断言在实现对应行为前失败。

- [x] **步骤 3：实现带认证的观察器**

仅继承已有 API Proxy 客户端，把 `/api/*` 请求映射到已就绪 Harness endpoint，并加入 `Authorization: Bearer <capability>`。轮询间隔与请求超时是两个独立、必填的正数选项。每轮串行轮询读取两份经过校验的列表，通过每个 Task 的根与后代映射运行中的 Session id，并发出冻结的派生状态。第一次成功基线不产生通知；后续新增的可处理注意事项 id、失败转换，以及从运行树进入待审查或已结算状态时只生成一个通知键。只从实时 Task 行派生通知，不可用行保留最后的实时观察记录。请求失败或存在非实时行时，聚合新鲜度标记为不可用；请求失败保留最后的计数。瞬时请求失败期间保留转换键，并按经过校验的正数间隔重试。

- [x] **步骤 4：验证观察器行为**

运行 `pnpm exec vitest run apps/desktop/tests/task-observer.spec.ts`；预期全部用例通过，且没有遗留计时器或请求。

- [x] **步骤 5：提交观察器**

以 `feat(desktop): observe authoritative task activity` 提交观察器、定向测试与显式包依赖。

### 任务 2：原生后台状态控制器

**文件：**
- 新建：`apps/desktop/src/background-presence.ts`
- 测试：`apps/desktop/tests/background-presence.spec.ts`
- 修改：已有图标生成器与复制的构建资源，提供 Windows ICO、macOS 模板 PNG 及其 Retina 对侧文件

- [x] **步骤 1：先写失败的控制器测试**

固定只有一个 Tray 实例、本地化运行/注意事项摘要、打开与退出动作、双击恢复、首份实时基线前不通知、通知点击路由、不可用状态文案、幂等释放，以及原生回调失败隔离。

- [x] **步骤 2：实现控制器前确认行为断言失败**

运行 `pnpm exec vitest run apps/desktop/tests/background-presence.spec.ts`；建立最小导出 API 后，要求原生所有权或通知断言在实现对应行为前失败。

- [x] **步骤 3：实现 Tray 与 Notification 所有权**

控制器只接收以下应用动作与观察器工厂：

```typescript
interface BackgroundPresenceActions {
  readonly openSession: (sessionId?: string) => Promise<void>
  readonly requestQuit: () => void
  readonly reportFailure: (error: unknown) => void
}
```

Electron 就绪后创建 Tray；每份派生观察值重建菜单，并且只为状态转换记录创建原生 Notification。点击通知调用 `openSession(ownerSessionId)`；不带目标的托盘点击恢复或重建主窗口。释放时停止观察器、移除原生监听、只销毁一次 Tray，并阻止延迟请求结算创建通知。

- [x] **步骤 4：验证控制器行为**

运行 `pnpm exec vitest run apps/desktop/tests/background-presence.spec.ts`；预期所有所有权与失败隔离用例通过。

- [x] **步骤 5：提交控制器**

以 `feat(desktop): add task-aware background presence` 提交控制器、测试及必要的生成托盘资源。

### 任务 3：窗口生命周期与显式退出保护

**文件：**
- 修改：`apps/desktop/src/main-lifecycle.ts`
- 修改：`apps/desktop/src/main.ts`
- 修改：`apps/desktop/src/window.ts`
- 新建：`apps/desktop/src/desktop-ipc.ts`
- 修改：`apps/desktop/tests/main-lifecycle.spec.ts`
- 修改：`apps/desktop/tests/main-entry.spec.ts`
- 修改：`apps/desktop/tests/window.spec.ts`

- [x] **步骤 1：增加先失败的生命周期测试**

要求 Windows 与 macOS 在最后一个窗口关闭后保留 Harness 与后台状态；打开操作只重建一个经过认证的窗口。状态实时且没有运行 Task 时，显式退出立即清理。有运行 Task 或状态不可用时，继续后台会隐藏窗口并保留 Harness，停止并退出会执行已有有界停止，取消则不改变任何状态。状态不可用的确认框说明当前活动无法确认，不把保留计数当作实时计数。并发退出请求共享一次确认。安装器关闭和启动恢复页退出绕过确认，同时继续保证有界清理。

- [x] **步骤 2：确认当前关闭即退出行为使测试失败**

运行 `pnpm exec vitest run apps/desktop/tests/main-lifecycle.spec.ts apps/desktop/tests/window.spec.ts`；预期 Windows 关闭与活跃 Task 退出用例失败。

- [x] **步骤 3：集成后台状态**

只在 Harness 认证就绪后创建后台状态，并在停止 Harness 前释放它。把 Windows/Linux 的最后窗口关闭即退出改成保留后台。为 `DesktopWindow` 增加 `show()`、`hide()` 和具名的 `openSession(sessionId)` 操作；恢复时显示隐藏窗口，窗口已关闭时排队目标，直到替代授权窗口加载后再发送。在 `desktop-ipc.ts` 定义单向通道。强制清理与用户请求的退出确认保持分离，使安装器和失败恢复不会被对话框阻塞。

- [x] **步骤 4：验证生命周期与入口行为**

运行 `pnpm exec vitest run apps/desktop/tests/main-lifecycle.spec.ts apps/desktop/tests/main-entry.spec.ts apps/desktop/tests/window.spec.ts`；预期全部通过，并保留既有启动/关闭保证。

- [x] **步骤 5：提交生命周期集成**

以 `feat(desktop): keep active tasks running in tray` 提交生命周期组合。

### 任务 4：准确的通知导航

**文件：**
- 修改：`apps/desktop/src/desktop-ipc.ts`
- 修改：`apps/desktop/src/preload.ts`
- 修改：`apps/desktop/src/global.d.ts`
- 修改：`apps/desktop/tests/preload.spec.ts`
- 新建：`packages/client/ui-task-overview/src/client/desktop-navigation.ts`
- 修改：`packages/client/ui-task-overview/src/client/index.ts`
- 修改：`packages/client/ui-task-overview/src/client/TaskOverview.tsx`
- 测试：`packages/client/ui-task-overview/tests/desktop-navigation.client.spec.ts`
- 修改：`packages/client/ui-task-overview/README.md`
- 修改：`packages/client/ui-task-overview/README.zh.md`

- [x] **步骤 1：增加先失败的 preload 与客户端测试**

要求冻结的 preload bridge 只暴露 `platform` 与 `onOpenSession(listener)`；在调用监听器前校验非空且有长度上限的 Session id；订阅前只保留最新目标；返回幂等释放器。要求总览插件在权威目录就绪前排队最新目标，通过 `createTaskNavigation` 路由每个收到的 id，包括权威子 Agent 解析，并通过 Cordis effect 释放订阅。测试提前投递、重载、目标替换和目录加载期间释放。

- [x] **步骤 2：确认具名通道缺失时测试失败**

运行 `pnpm exec vitest run apps/desktop/tests/preload.spec.ts packages/client/ui-task-overview/tests/desktop-navigation.client.spec.ts`；预期 bridge 与导航断言失败。

- [x] **步骤 3：实现单向 bridge**

不暴露 `send`、`invoke` 或原始 `ipcRenderer`。Main 只发送来自 Host 投影且经过校验的 id。普通 Web 没有 bridge 是正常行为；客户端把收到的 id 交给总览点击所用的同一导航控制器。插件拥有的展示数据源记录通知导航失败，通过 slot hook 在总览警告区展示并显示 Home，不改变选中的 Session，也不创建业务状态存储。成功或替换目标的尝试清除展示错误。

- [x] **步骤 4：验证 bridge 行为与包类型**

运行定向测试，以及 `pnpm exec tsc -b packages/client/ui-task-overview/tsconfig.json` 和 `pnpm --filter @deepseek-ai/dsh-desktop typecheck`；预期全部通过。

- [x] **步骤 5：提交通知导航**

以 `feat(desktop): open notification task targets` 提交具名 IPC 与客户端消费方。

### 任务 5：组装验收、文档与发布证据

**文件：**
- 修改：`apps/desktop/tests/desktop.e2e.ts`
- 修改：`apps/desktop/README.md`
- 修改：`apps/desktop/README.zh.md`
- 修改：`.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.md`
- 修改：`.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.zh.md`
- 修改本计划及其中文对应文件

- [x] **步骤 1：增加先失败的真实 Electron 验收**

使用已有的一次性 Task 总览 fixture 运行两个根 Task，关闭唯一窗口，证明两者继续活跃，通过 Tray 重开，触发一个子 Agent 待回答问题，点击其原生通知，并验证打开准确的子会话。通过真实对话框路径覆盖继续后台、取消、停止并退出。绝不读写用户的 checkout。

- [x] **步骤 2：确认新验收在组装集成前失败**

通过 `pnpm --filter @deepseek-ai/dsh-desktop test:e2e` 运行定向 desktop E2E 标题；预期在后台保留或通知导航处失败。

- [x] **步骤 3：完成当前状态文档**

在 desktop README 对中记录原生后台行为、轮询新鲜度、通知转换、准确导航、安装器强制清理和限制。更新 Mission Control Note，但不宣称 Harness Studio、更新、签名、macOS 打包或子写入 Agent 集成已完成。只有存在所列证据后才勾选对应计划步骤。

- [x] **步骤 4：运行与范围匹配的验证**

运行定向单元/组件测试、真实 Electron E2E、受影响 snapshot、`pnpm run typecheck`、`pnpm run lint`、`pnpm run doc-sync`、`pnpm run build`、`git diff --check` 和仓库 pre-push checks。显式重新记录每个已编辑的双语文档对。

- [ ] **步骤 5：提交并推送完整切片**

以 `test(desktop): verify task-aware tray lifecycle` 提交文档与验收，推送堆叠分支，并要求 Windows 安装器与主 CI 的证据都成功后才把本切片视为完成。
