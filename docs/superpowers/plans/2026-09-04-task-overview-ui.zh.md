# 任务总览界面实施计划

[English](2026-09-04-task-overview-ui.md) | 中文

> **面向 Agent 执行者：** 使用 superpowers:subagent-driven-development 或 superpowers:executing-plans，按测试优先、规格审查先于质量审查的顺序实施任务。

**目标：** 按[已批准规格](../specs/2026-09-04-parallel-task-overview-design.md)实现桌面任务总览及其与现有会话的导航。

**架构：** 布局负责临时的首页/会话选择和独立首页插槽。仅桌面端加载的 UI 插件从会话与工作区快照派生任务行，通过现有会话服务进入交互。运行时在断连时使进行中的旧列表响应失效；Electron 不增加任务 API。

**技术栈：** Cordis 插件、TypeScript、React、CSS Modules、Vitest 和 Playwright Electron。

## 任务 1：布局导航与任务展示

文件：修改 `packages/client/ui-layout/src/client/{index.ts,service.ts,stores.ts,AppFrame.tsx,AppFrame.module.css}` 及所属测试；更新 `packages/client/ui-sidebar/src/client/index.ts` 和 `packages/client/ui-workspace/src/client/index.ts` 的显式导航回调。新增 `packages/client/ui-task-overview/`，包含标准包清单、客户端聚合引用、构建配置、空 Node apply、说明理由的 invariant、CSS 声明和双语 README。客户端文件为 `index.ts`（装配）、`select-tasks.ts`（纯派生）、`navigation.ts`（交互解析）、`TaskOverview.tsx`、`TasksAction.tsx`、`locales.ts` 和 `TaskOverview.module.css`。仅在 `packages/bundle/desktop-app/cordis.patch.yml` 和其依赖清单中注册；普通 Web 不添加新插件条目。

- [x] 先添加失败的布局测试：初始首页占用、普通 Web 回退、会话 id 不变时的显式导航、保留已挂载草稿、首页隐藏详情和插槽卸载。运行 `pnpm exec vitest run packages/client/ui-layout/tests`，确认新行为失败。
- [x] 在布局 store 添加以下展示状态和动作，通过 `ILayout` 与 `LayoutController` 转发两个动作。

```typescript
type CenterPage = 'home' | 'conversation'
// Initial centerPage is 'home'; an unoccupied home slot renders conversation.
showHome: (draft: LayoutState) => { draft.centerPage = 'home' },
showConversation: (draft: LayoutState) => { draft.centerPage = 'conversation' },
```

- [x] 由 root 注册声明 single、root 作用域的 `shell.home` 插槽，通过 inject 绑定的框架 hook 提供占用状态。AppFrame 在固定位置渲染两个界面，用 hidden 包装隐藏非活动界面；首页条件为 `panels.centerPage === 'home' && homeAvailable`。首页将详情渲染宽度设为零，不修改保存的宽度偏好。侧边栏和工作区用户导航显式调用 `showConversation`；不通过监听列表选择覆盖启动首页。
- [x] 先添加纯选择器失败测试，覆盖待处理优先、运行中的后代、普通 fork、循环、缺失父级、归档与空白根会话、注册表归属而非 cwd 匹配、更新时间降序/id 排序，以及未读结束提醒仍归入其他任务。使用以下行派生类型及现有 branded id 和工作区类型。

```typescript
type TaskGroup = 'needs-you' | 'running' | 'other'
interface TaskRow {
  root: SessionSummary
  workspace: WorkspaceView | undefined
  group: TaskGroup
  descendants: readonly SessionSummary[]
  pending: readonly SessionSummary[]
  runningDescendants: number
}
```

- [x] 将 `selectTasks` 实现为 SessionListState 与 WorkspaceListState 的纯函数。根会话仅取自列出的 ids，排除 subagent 来源、空白行和归档 id。后代仅沿连续 subagent 来源父链追溯，并防止循环；普通 fork 终止父链。根或后代的待处理状态优先于运行状态。通过注册表 sessionIds 匹配工作区，不使用 cwd。计数和文案明确表示已知后代，不宣称完整清单或成功结果。
- [x] 先添加组件测试再编写渲染代码：三个有序分区及空提示、标题/工作区/状态、每个已知待处理所有者、新任务显式工作区选择、过期/错误/加载/空状态差异、可见导航失败，以及不自动批准或发送提示。使用框架派生 props 和现有主题/语言模式。
- [x] 通过 `slots.inject` 将 TasksAction 注册到 `sidebar.footer.action`，将 TaskOverview 注册到 `shell.home`；语言注册与订阅由 Cordis effect 管理。组件使用 `useSessions`、`useWorkspaces` 和 inject 绑定的 Host 描述 hook。始终显示目录隔离提醒。请求失败/加载中或 Host 描述缺失的列表不能显示为已同步；初始等待与同步后的空列表使用不同文案。
- [x] 测试根导航、权威子会话导航、缺失地址时解析目录、不可用目标、已结束的交互，以及解析期间卸载。子会话路线先读取 `sessions.subagentAddress(id)`，缺失时仅刷新直接父级目录，再读取权威地址；绝不根据标题或父 id 合成地址。成功选中目标后才调用 `layout.showConversation`。失败在总览显示；真正的回答仍由现有会话 UI 处理。
- [x] 运行插件、布局、侧边栏和工作区的定向测试，再执行类型检查和相关包构建。更新必需服务替身与清单，不削弱类型。检查新包导出和资源包含情况。

## 任务 2：新基线归属与重试

文件：修改 `packages/client/runtime/src/client/sessions/manager.ts`、`workspaces/manager.ts`、`workspaces/service.ts`、`index.ts`、`contract/sessions.ts`、`contract/workspaces.ts`、所属定向测试及必需的测试服务替身。更新运行时 README 双语对。两个元数据列表均需代际失效，因为工作区归属和归档基线同样决定可见任务。

- [x] 添加延迟响应回归：断连前启动的列表请求不能在重连后完成同步、覆盖新行、清除新错误或释放新请求的单飞归属。运行定向 manager 测试并观察失败。
- [x] 每次列表请求捕获代际。断连时使旧代际失效，清除旧单飞/变更归属，保留行并发布 loading，待处理交互仍由现有代码清理。成功、失败和 finally 写入都拒绝过时代际。重连启动新请求，仅其成功响应将请求状态恢复 idle。

```typescript
const generation = this.listGeneration
// Immediately after awaiting the list response, and before catch/finally writes:
if (generation !== this.listGeneration) return
```

- [x] 在两个列表服务公开接口及测试替身上暴露已实现的 `refresh(): Promise<void>`。总览重试调用两个所有者；加载时禁用重复重试，Host 描述缺失时禁用离线重试。UI 组件不拥有 HTTP 列表请求或重试定时器。
- [x] 验证初始失败、保留旧行的失败、断连、过期成功/失败、代际重叠及成功恢复。运行定向运行时测试与类型检查；不增加持久字段或模型可见内容。

## 任务 3：装配验收与交付证据

文件：新增 `apps/web/tests/task-overview.snapshot.ts`，使用现有构建应用测试装置和桌面插件清单显式选项；仅为该选项更新 `apps/web/tests/assembled-boot.ts`。在 `apps/desktop/tests/` 添加桌面验收，在所属应用快照目录添加快照。更新现有 Mission Control 提案，不将更大产品标为已实现。

- [x] 构建并启动真实插件图，固定无密钥可见流程：总览、根会话导航、返回任务、保留草稿、已知子会话待处理与运行分组，以及普通 Web 没有总览。断言用户可见语义输出，不依赖内部类名。
- [x] 使用隔离临时用户数据和可丢弃工作区运行真实 Electron 桌面配置，验证导航、并行执行、待处理目标路线和断连/重连。仅替换不确定的模型接口；写文件验收不使用用户工作目录。
- [x] 运行 `pnpm run test:gui`、`DSH_SNAPSHOT=replay pnpm run test:web`、定向装配快照、桌面验收、`pnpm run typecheck`、`pnpm run lint`、`pnpm run doc-sync` 和 `git diff --check`。记录真实失败，区分源码实现与装配/安装器验证。
- [x] 先审查规格符合性，再审查代码质量；修复发现并重跑相关检查。更新所属 README、本计划和提案后记录双语配对。验证后仅提交本次范围变更，不将推送、安装或生成发布 EXE 作为未经请求的副作用。

## 验收状态

任务 1 和 2 已有源码、定向测试及类型检查证据。已构建无密钥装配快照覆盖根会话导航、返回任务、草稿保留、已知子会话活动与问题导航，以及普通 Web 回退。真实 Electron 验收覆盖全新用户引导、总览、新建任务导航、独立一次性工作区中的并发根任务、两个根任务保持运行时的导航、真实传输断连及重连期间保留任务行、进入拥有待回答问题的权威子会话、安全传输和进程退出。完整 Web replay 在 Windows 上仍有既存失败，包括原始反斜杠夹具替换、Bash 与终端检查不可用、`spawn pnpm ENOENT` 和共享设置状态；任务总览快照独立通过。本计划不宣称完整桌面产品、工作树隔离、安装器验证或发布就绪。
