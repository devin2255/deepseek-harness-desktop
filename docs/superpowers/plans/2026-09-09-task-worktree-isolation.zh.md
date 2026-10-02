# Task Worktree 隔离实施计划

[English](2026-09-09-task-worktree-isolation.md) | 中文

> **面向 Agent 执行者：** 必须使用子技能：通过 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐项实施本计划。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 让绑定 Workspace 的写入型 Task 在应用所有的 Git Worktree 中运行，同时在根 Session 日志中保留源 Workspace 标识和可恢复的 Git 事实。

**架构：** `@deepseek-ai/dsh-task-worktree` 定义 Task 专用 Worktree 服务，`@deepseek-ai/dsh-task-worktree-local` 使用受管 subprocess 服务和 `DSH_HOME` 下的目录实现它，Host API Proxy 从 `session.create` 消费该服务。新的全值 `task/worktree-assigned` Session 事件记录原 Workspace、基础提交、分支、隔离路径和源检出状态摘要；Task 投影优先采用这个持久 Workspace 标识，而不是普通 cwd 成员关系。Electron Main 与 Renderer 均不获得文件系统或 Git 权限。

**技术栈：** TypeScript、Cordis 服务与 effect、受管 subprocess、Git porcelain 输出、Session 事件、Zod 线协议校验、Vitest、React 客户端插件、无密钥 Web 快照、Electron Playwright 验收。

---

### Task 1：定义 Task Worktree 能力

**文件：**
- 新建：`packages/task/task-worktree/package.json`
- 新建：`packages/task/task-worktree/tsconfig.json`
- 新建：`packages/task/task-worktree/src/index.ts`
- 新建：`packages/task/task-worktree/src/invariant.ts`
- 新建：`packages/task/task-worktree/tests/service.spec.ts`
- 新建：`packages/task/task-worktree/tests/invariant.spec.ts`
- 修改：`packages/task/README.md`
- 修改：`packages/task/README.zh.md`

- [x] **步骤 1：编写失败的 Service Definition 测试**

在包存在之前，先在测试中定义期望的公开 API：

```ts ignore-check
const request = {
  taskId: SessionId('task-1'),
  workspaceId: WorkspaceId('workspace-1'),
  workspacePath: repository,
}
const created = await ctx.taskWorktrees.create(request)
expect(created).toMatchObject({
  taskId: request.taskId,
  workspaceId: request.workspaceId,
  sourcePath: repository,
  kind: 'git-worktree',
  sourceDirty: false,
})
```

同时断言稳定错误码 `WORKTREE_NOT_GIT`、`WORKTREE_NESTED_REPOSITORY`、`WORKTREE_UNBORN_HEAD`、`WORKTREE_INSUFFICIENT_SPACE`、`WORKTREE_TARGET_OCCUPIED`、`WORKTREE_BRANCH_OCCUPIED`、`WORKTREE_GIT_FAILED` 和 `WORKTREE_UNAVAILABLE`。

- [x] **步骤 2：运行测试并确认 RED**

运行：`pnpm exec vitest run packages/task/task-worktree/tests`

预期：失败，因为 `@deepseek-ai/dsh-task-worktree` 尚不存在。

- [x] **步骤 3：实现 Service Definition**

导出以下准确公开值：

```ts
import { Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

export interface TaskWorktreeAssignment {
  readonly kind: 'git-worktree'
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly sourcePath: string
  readonly path: string
  readonly branch: string
  readonly baseCommit: string
  readonly sourceHead: string
  readonly sourceDirty: boolean
  readonly sourceStatusDigest: string
  readonly createdAt: number
}

export interface CreateTaskWorktreeRequest {
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly workspacePath: string
}

export abstract class TaskWorktreeService extends Service {
  abstract create(request: CreateTaskWorktreeRequest, signal?: AbortSignal): Promise<TaskWorktreeAssignment>
  abstract inspect(assignment: TaskWorktreeAssignment, signal?: AbortSignal): Promise<'available' | 'missing' | 'diverged'>
}
```

`TaskWorktreeError` 携带上述列表中的一个稳定错误码。Invariant 断言配置此包时已经挂载 `ctx.taskWorktrees`。

- [x] **步骤 4：运行测试并确认 GREEN**

运行：`pnpm exec vitest run packages/task/task-worktree/tests`

预期：通过。

- [x] **步骤 5：提交能力定义**

```powershell
git add packages/task/task-worktree packages/task/README.md packages/task/README.zh.md
git commit -m "feat(task): define task worktree capability"
```

### Task 2：实现本地 Git Worktree Provider

**文件：**
- 新建：`packages/task/task-worktree-local/package.json`
- 新建：`packages/task/task-worktree-local/tsconfig.json`
- 新建：`packages/task/task-worktree-local/src/config.ts`
- 新建：`packages/task/task-worktree-local/src/git.ts`
- 新建：`packages/task/task-worktree-local/src/index.ts`
- 新建：`packages/task/task-worktree-local/src/invariant.ts`
- 新建：`packages/task/task-worktree-local/tests/local.spec.ts`
- 新建：`packages/task/task-worktree-local/tests/invariant.spec.ts`
- 新建：`packages/task/task-worktree-local/README.md`
- 新建：`packages/task/task-worktree-local/README.zh.md`
- 新建：`packages/task/task-worktree-local/README.i18n.yaml`
- 修改：`packages/task/README.md`
- 修改：`packages/task/README.zh.md`

- [x] **步骤 1：编写真正使用 Git 的失败测试**

创建一次性仓库并断言：

```ts ignore-check
const assignment = await ctx.taskWorktrees.create({ taskId, workspaceId, workspacePath: repository })
expect(await readFile(join(assignment.path, 'tracked.txt'), 'utf8')).toBe('base\n')
expect(git(repository, ['status', '--porcelain=v1'])).toBe('')
expect(await ctx.taskWorktrees.inspect(assignment)).toBe('available')
```

独立测试证明：两个 Task id 会产生不同分支与路径；源目录的未提交变更既不会被复制也不会被修改；嵌套仓库和 unborn HEAD 会明确失败；确定性目标被占用时原内容会保留；配置的可用空间不足会在 Git 变更前失败；Git add 失败时会保留诊断信息和任何部分目录。

- [x] **步骤 2：运行 Provider 测试并确认 RED**

运行：`pnpm exec vitest run packages/task/task-worktree-local/tests`

预期：失败，因为 Provider 尚不存在。

- [x] **步骤 3：实现失败即关闭的预检与创建**

在使用前解析配置：

```ts
export interface Config {
  dshHome?: string
  minFreeBytes: number
  gitCommand: string
  commandTimeoutMs: number
  terminateGraceMs: number
  maxOutputBytes: number
}
```

默认值依次是 `resolveDshHome()`、512 MiB、`git`、30 秒、2 秒和 1 MiB。使用 `ctx.subprocess.resolveExecutable` 与 `ctx.subprocess.spawn`，绝不调用 shell。在 `git worktree add` 之前，要求所选 Workspace 路径等于 `git rev-parse --show-toplevel`，拒绝非空的 `--show-superproject-working-tree`，要求四十位十六进制 `HEAD`，以 SHA-256 哈希 `git status --porcelain=v1 -z`，并检查 `statfs.availableBlocks * blockSize`。根据规范仓库路径和 Task id 的 SHA-256 哈希推导分支和路径：

```ts
import { join } from 'node:path'

declare const home: string
declare const sourcePath: string
declare const taskId: string
declare function digest(value: string): string

const branch = `dsh/task-${digest(taskId).slice(0, 24)}`
const path = join(home, 'worktrees', 'v1', digest(sourcePath).slice(0, 24), digest(taskId).slice(0, 24))
```

按规范仓库串行执行 create 调用。只通过 `git worktree add -b <branch> <path> <baseCommit>` 创建。失败后不删除部分路径或分支。`inspect` 解析 `git worktree list --porcelain -z`，只有路径、分支和 HEAD 全部匹配持久分配时才返回 `available`。

- [x] **步骤 4：运行聚焦测试并确认 GREEN**

运行：`pnpm exec vitest run packages/task/task-worktree-local/tests`

预期：在 Windows 和 POSIX 上通过；平台专用权限探针只能通过明确的操作系统条件跳过。

- [x] **步骤 5：提交 Provider**

```powershell
git add packages/task/task-worktree-local packages/task/README.md packages/task/README.zh.md
git commit -m "feat(task): create local task worktrees"
```

### Task 3：记录并投影执行 Workspace

**文件：**
- 修改：`packages/task/task/src/types.ts`
- 修改：`packages/task/task/src/fold.ts`
- 修改：`packages/task/task/src/index.ts`
- 修改：`packages/task/task/src/service.ts`
- 修改：`packages/task/task/tests/fold.spec.ts`
- 修改：`packages/task/task/tests/types.spec.ts`
- 修改：`packages/task/task-session/src/aggregate.ts`
- 修改：`packages/task/task-session/src/index.ts`
- 修改：`packages/task/task-session/tests/aggregate.spec.ts`
- 修改：`packages/task/task-session/tests/runtime.spec.ts`
- 修改：`docs/subsystems/task.md`
- 修改：`docs/subsystems/task.zh.md`

- [x] **步骤 1：编写失败的持久回放测试**

追加一个完整分配事件，并证明严格回放与 Workspace 分组：

```ts ignore-check
session.append({ type: 'task/worktree-assigned', data: { assignment } })
expect(applyTaskEvent(emptyTaskFoldState(), session.events.at(-1)!)).toMatchObject({ assignment })
expect(provider.snapshot().tasks[0]).toMatchObject({ workspaceId, executionWorkspace: assignment })
```

畸形提交 id、摘要、分支 ref、时间戳、额外字段、重复分配，以及执行后的重新分配都必须失败并指出准确事件序号。未知的可合并扩展事件保持不变。

- [x] **步骤 2：运行 Task 测试并确认 RED**

运行：`pnpm exec vitest run packages/task/task/tests packages/task/task-session/tests`

预期：失败，因为事件和投影字段尚不存在。

- [x] **步骤 3：添加持久事件与变更方法**

向 `TaskSnapshot` 添加 `executionWorkspace?: TaskWorktreeAssignment`，向 `TaskFoldState` 添加 `assignment?: TaskWorktreeAssignment`。通过 `SessionEventMap` 声明事件：

```ts
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'

interface SessionEventMap {
  'task/worktree-assigned': {
    assignment: TaskWorktreeAssignment
  }
}
```

添加 `TaskService.assignWorktree(sessionId, { assignment, expectedSeq })`。Session Provider 在只追加一个事件前校验：目标是根、分配的 Task id 与其匹配、引用的 Workspace 存在、这是首次分配，并且 `expectedSeq` 匹配。聚合使用分配的 `workspaceId`；基于 cwd 的 Workspace 成员关系仍作为直接 Task 的回退。

- [x] **步骤 4：运行聚焦测试并确认 GREEN**

运行：`pnpm exec vitest run packages/task/task/tests packages/task/task-session/tests`

预期：通过。

- [x] **步骤 5：提交持久分配投影**

```powershell
git add packages/task/task packages/task/task-session docs/subsystems/task.md docs/subsystems/task.zh.md
git commit -m "feat(task): record isolated execution workspaces"
```

### Task 4：让 Host Session 创建显式请求隔离

**文件：**
- 修改：`packages/host/apiproxy/src/api/sessions.ts`
- 修改：`packages/host/apiproxy/src/api/sessions.schema.ts`
- 修改：`packages/host/apiproxy/src/api/rpc.ts`
- 修改：`packages/host/apiproxy/src/api/rpc.schema.ts`
- 修改：`packages/host/apiproxy/src/api/tasks.schema.ts`
- 修改：`packages/host/apiproxy/src/api-proxy.ts`
- 修改：`packages/host/apiproxy/tests/api-proxy-workspace.spec.ts`
- 修改：`packages/host/apiproxy/tests/tasks-api.spec.ts`
- 修改：`packages/host/apiproxy/tests/rpc-schemas.spec.ts`

- [x] **步骤 1：编写失败的 Host 行为测试**

断言 `session.create({ workspaceId, isolation: 'worktree' })` 会在创建 Session 前调用 Worktree 服务，以隔离 cwd 创建 Session，记录分配并返回它，同时保持源 Workspace 不变。断言 `isolation: 'direct'` 保留当前附加行为。Worktree 服务缺失或预检失败时返回 `workspace-isolation-unavailable`，且绝不创建 Session；Host 绝不静默改变请求模式。

- [x] **步骤 2：运行 Host 测试并确认 RED**

运行：`pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-workspace.spec.ts packages/host/apiproxy/tests/tasks-api.spec.ts packages/host/apiproxy/tests/rpc-schemas.spec.ts`

预期：失败，因为严格请求 schema 会拒绝 `isolation`。

- [x] **步骤 3：实现 Host 消费方**

扩展请求与响应：

```ts
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'

interface SessionApi {
  create(request: RpcRequest<{
    workspaceId?: WorkspaceId
    cwd?: string
    sessionId?: SessionId
    agentPreset?: string
    isolation?: 'direct' | 'worktree'
  }>): Promise<RpcResponse<{
    sessionId: SessionId
    agentPreset?: string
    executionWorkspace?: TaskWorktreeAssignment
  }>>
}
```

`worktree` 要求 `workspaceId` 和 `ctx.taskWorktrees`；它先分配 Session id，再创建 Git Worktree，以 `assignment.path` 启动 Session，随后调用 `ctx.tasks.assignWorktree`。直接创建保留现有 Workspace 附加行为。Git 创建后的任何失败都在脱敏的结构化详情中报告保留路径，且绝不自动删除。

- [x] **步骤 4：运行 Host 测试并确认 GREEN**

运行步骤 2 的命令。

预期：通过。

- [x] **步骤 5：提交 Host 集成**

```powershell
git add packages/host/apiproxy
git commit -m "feat(host): create sessions in task worktrees"
```

### Task 5：通过两个 SDK 和客户端运行时公开隔离

**文件：**
- 修改：`packages/sdk/client/package.json`
- 修改：`packages/sdk/client/src/client.ts`
- 修改：`packages/sdk/client/src/index.ts`
- 修改：`packages/sdk/client/src/types.ts`
- 修改：`packages/sdk/client/tests/fake-runtime.ts`
- 修改：`packages/sdk/client/tests/sdk-client.spec.ts`
- 修改：`packages/sdk/client/tsconfig.json`
- 修改：`pnpm-lock.yaml`
- 修改：`python/sdk/src/deepseek_harness/models.py`
- 修改：`python/sdk/src/deepseek_harness/__init__.py`
- 修改：`python/sdk/tests/test_client.py`
- 修改：`packages/client/runtime/src/client/contract/workspaces.ts`
- 修改：`packages/client/runtime/src/client/contract/sessions-port.ts`
- 修改：`packages/client/runtime/src/client/sessions/manager.ts`
- 修改：`packages/client/runtime/src/client/sessions/service.ts`
- 修改：`packages/client/runtime/src/client/workspaces/service.ts`
- 修改：`packages/client/runtime/tests/workspaces-service.client.spec.ts`
- 修改：`packages/client/runtime/tests/client-apply.client.spec.ts`
- 修改：`packages/client/ui-conversation/src/client/apply.ts`

- [x] **步骤 1：编写失败的 SDK 与客户端测试**

证明两个 SDK 都会解析 Task 分配，并在不改写路径的情况下公开它。证明 `WorkspaceRuntime.connectWorkspace(id, 'worktree')` 会序列化显式模式且绝不复用直接模式的空白 Session，而 `connectWorkspace(id, 'direct')` 保留当前复用行为。子进程 SDK 协议不创建 Host Workspace，因此它投影已记录的分配，而不会虚构第二套 Session 创建 API。

- [x] **步骤 2：运行测试并确认 RED**

运行：`pnpm exec vitest run packages/sdk/client/tests packages/client/runtime/tests/workspaces-service.client.spec.ts`

运行：`uv run --project python/sdk pytest python/sdk/tests/test_client.py -q`

预期：失败，因为请求与响应类型尚未携带隔离模式。

- [x] **步骤 3：实现两个 SDK 与运行时投影**

使用与 Host 相同的判别标签和字段名。客户端不推断 Git 状态。只有桌面 Task 创建操作默认使用 `worktree`；可复用 API 要求显式模式，避免 Web/自动化调用方行为意外变化。

- [x] **步骤 4：运行两个测试套件并确认 GREEN**

运行步骤 2 的两条命令。

预期：通过。

- [x] **步骤 5：提交消费方**

```powershell
git add packages/sdk python packages/client/runtime
git commit -m "feat(client): request isolated task sessions"
```

### Task 6：添加桌面 Task 创建恢复流程

**文件：**
- 修改：`packages/client/ui-task-overview/README.md`
- 修改：`packages/client/ui-task-overview/README.zh.md`
- 修改：`packages/client/ui-task-overview/src/client/TaskOverview.tsx`
- 修改：`packages/client/ui-task-overview/src/client/TaskOverview.module.css`
- 修改：`packages/client/ui-task-overview/src/client/locales.ts`
- 修改：`packages/client/ui-task-overview/tests/overview.client.spec.tsx`
- 修改：`packages/client/ui-workspace/src/client/WorkspacePicker.tsx`
- 修改：`packages/client/ui-workspace/README.md`
- 修改：`packages/client/ui-workspace/README.zh.md`
- 修改：`packages/client/ui-workspace/src/client/locales.ts`
- 修改：`packages/client/ui-workspace/tests/workspace-picker.client.spec.tsx`
- 修改：`packages/client/connection/src/client/fixture.ts`
- 修改：`packages/client/connection/tests/fixture.client.spec.ts`
- 修改：`packages/client/ui-conversation/README.md`
- 修改：`packages/client/ui-conversation/README.zh.md`
- 修改：`packages/client/ui-conversation/src/client/locales.ts`
- 修改：`packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css`
- 修改：`packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx`
- 修改：`packages/client/ui-conversation/tests/skeleton.client.spec.tsx`

- [x] **步骤 1：编写失败的组件测试**

Tasks 空状态和 New Task 操作选择 Workspace 并请求 `worktree`。Host 返回 `workspace-isolation-unavailable` 时，显示准确安全选项“重试隔离”和“直接使用项目”；只有用户选择后者才以直接模式重试。Task 卡片和标题把分配路径标为 `Worktree`，并保留原 Workspace 标题。

- [x] **步骤 2：运行组件测试并确认 RED**

运行：`pnpm exec vitest run packages/client/ui-task-overview/tests packages/client/ui-workspace/tests/workspace-picker.client.spec.tsx`

预期：失败，因为隔离操作和恢复状态尚不存在。

- [x] **步骤 3：实现可见流程**

Git 诊断只使用 Host 提供的用户安全文本。UI 只发送 Workspace id 和显式模式；绝不获得通用路径或进程 API。键盘焦点移入错误面板，并在成功重试后回到触发操作。

- [x] **步骤 4：运行组件测试并确认 GREEN**

运行步骤 2 的命令，并加上持有 Worktree 徽标与确定性隔离失败的会话标题栏和 fixture 测试套件。

预期：通过。

- [x] **步骤 5：提交桌面流程**

```powershell
git add packages/client/ui-task-overview packages/client/ui-workspace packages/client/connection
git commit -m "feat(desktop): create isolated tasks by default"
```

### Task 7：装配、记录并验证公开闭环

**文件：**
- 修改：`packages/bundle/web-app/cordis.patch.yml`
- 修改：`packages/bundle/web-app/package.json`
- 修改：`packages/bundle/desktop-app/tests/desktop-app.spec.ts`
- 修改：`packages/client/connection/src/client/fixture.ts`
- 修改：`packages/client/connection/tests/fixture.client.spec.ts`
- 修改：`apps/web/tests/task-overview.snapshot.ts`
- 修改：`apps/web/tests/snapshots/task-overview/groups.expected.json`
- 修改：`apps/desktop/tests/desktop.e2e.ts`
- 修改：`apps/desktop/README.md`
- 修改：`apps/desktop/README.zh.md`
- 修改：`docs/architecture.md`
- 修改：`docs/architecture.zh.md`
- 新建：`.agents/notes/implemented/feature/2026-09-09-application-owned-task-worktrees.md`
- 新建：`.agents/notes/implemented/feature/2026-09-09-application-owned-task-worktrees.zh.md`

- [x] **步骤 1：编写失败的装配验收**

无密钥场景从一个一次性 Git Workspace 创建两个隔离 Task Session，并记录每个 Task 行的原 Workspace id、不同路径、分支、干净基础和未改变的源检出。Electron 验收重新加载 Renderer，确认两个行和 Worktree 标识仍然存在。

- [x] **步骤 2：运行装配测试并确认 RED**

运行：`pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/task-overview.snapshot.ts`

运行：`pnpm --filter @deepseek-ai/dsh-desktop test:e2e`

预期：失败，因为 bundle 尚未挂载本地 Provider，fixture 也无法创建隔离 Session。

- [x] **步骤 3：挂载并记录完整能力**

在 Host 平面中，将 `task-worktree-local` 挂载于 `subprocess-local` 之后、`host-apiproxy` 之前。更新架构和桌面限制：应用所有的根 Task Worktree 已可用，子写入者集成、Apply、Commit 和 Discard 仍由评审阶段负责。添加 implemented Agent Note，记录替代方案、失败保留策略、源检出保证和准确测试层级。

- [x] **步骤 4：重新生成归属产物**

运行：

```powershell
pnpm run gen-cordis-catalog
pnpm run gen-config-catalog
pnpm run gen-module-graph
pnpm run gen-scoped-events
pnpm run gen-persistence-catalog
```

预期：生成源包含两个 Worktree 包和 `task/worktree-assigned`。

- [x] **步骤 5：运行与发布风险相称的验证**

运行：

```powershell
pnpm exec vitest run packages/task/task-worktree/tests packages/task/task-worktree-local/tests packages/task/task/tests packages/task/task-session/tests packages/host/apiproxy/tests packages/client/runtime/tests packages/client/ui-task-overview/tests packages/client/ui-workspace/tests packages/sdk/client/tests
python -m pytest python/sdk/tests
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/task-overview.snapshot.ts
pnpm --filter @deepseek-ai/dsh-desktop test:e2e
pnpm run build
pnpm run typecheck
pnpm run doc-sync
git diff --check
```

预期：所有命令通过；任何仅限环境的内存失败均单独报告，不能作为通过声明的依据。

- [x] **步骤 6：提交已装配的公开闭环**

```powershell
git add packages/bundle apps docs .agents/notes packages/task packages/host packages/client packages/sdk python
git commit -m "feat(desktop): ship isolated task worktrees"
```
