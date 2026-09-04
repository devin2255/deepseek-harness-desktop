# 任务总览列表请求状态实现计划

[English](2026-09-04-task-overview-list-state.md) | 中文

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 向总览使用的框架数据源暴露已有列表请求活动和错误。

**架构：** 保留 SessionManager 对请求的管理，将其现有 state 和 error 投影到 SessionListState。不增加请求循环、持久化状态、连接状态机或渲染界面。

**技术栈：** TypeScript、Cordis、Vitest、现有客户端运行时。

## 范围与后续

这是已批准[总览规格](../specs/2026-09-04-parallel-task-overview-design.md)的第一个前置步骤，不是整个总览实现。后续实现计划覆盖后代分组与待处理目标、布局导航与桌面插件，最后完成无需密钥的组装快照和 Electron 验收。不能从列表请求状态推断传输断线；将任务行显示为实时状态前，必须另行接入连接代次信息。

## 任务 1：投影列表请求状态，不改变请求行为

文件：修改 `packages/client/runtime/src/client/sessions/service.ts`、`packages/client/runtime/tests/sessions-service.client.spec.ts`，以及 `packages/client/**/tests/` 和 `packages/test-support/client-runtime/src/sessions.ts` 中已有的类型化 SessionListState 测试数据。如果类型检查发现其他字面量，只更新其必需字段，不改变行为。

- [x] 在现有列表投影 describe 块中添加以下回归测试，使用现有 bench、feedList、err 和 deferred 辅助函数。运行前根据当前 RpcError 联合类型确认错误代码。

```typescript
it('keeps the ready list when a later refresh fails', async () => {
  const b = bench()
  await feedList(b, [{ id: 's1', running: true }])
  const failure = { code: 'internal' as const, message: 'list unavailable', details: {} }
  b.api.onList = () => Promise.resolve(err(failure))
  await b.svc.refresh()
  await Promise.resolve()
  expect(b.svc.list.getSnapshot()).toMatchObject({
    phase: 'ready', state: 'error', error: failure, ids: ['s1'],
  })
  await feedList(b, [{ id: 's1', running: false }])
  expect(b.svc.list.getSnapshot()).toMatchObject({
    phase: 'ready', state: 'idle', error: null,
  })
})
```

- [x] 添加断言，覆盖初始 `pending/idle/null` 状态、延迟响应的进行中请求（`loading/null`）、首次请求失败（`pending/error`）、真实空列表成功（`ready/idle/null`），以及保留已有行的加载状态。订阅公开列表存储，断言新请求状态可被观察且不改变当前会话选择。

- [x] 运行 `pnpm exec vitest run packages/client/runtime/tests/sessions-service.client.spec.ts`。预期：新断言因缺少 state/error 失败；已有断言保持通过。

- [x] 从 service.ts 已经引用的同一个 manager 模块导入现有 SessionListSnapshot 类型，并向 SessionListState 添加这些必需字段。

```typescript
/** List request activity; independent of initial baseline arrival. */
state: SessionListSnapshot['state']
/** Latest failed list request; null after a new request starts or succeeds. */
error: SessionListSnapshot['error']
```

- [x] 使用以下值扩展运行时初始列表对象。

```typescript
ids: [], byId: {}, current: undefined, phase: 'pending', state: 'idle', error: null,
```

- [x] 在 projectList 中投影管理器的原始字段，保留全部现有行派生和选择逻辑。

```typescript
const {
  items, current, phase, state, error, subagentsByParent, jobsBySession, currentAddress,
} = this.manager.getListSnapshot()
```

```typescript
this.list.set({ ids, byId, current, phase, state, error, subagentsByParent, jobsBySession, currentAddress })
```

- [x] 向空闲状态的类型化测试数据添加 `state: 'idle', error: null`。有意表示错误或进行中请求的测试数据，分别使用 `state: 'error'` 及其 RpcError，或 `state: 'loading', error: null`。不得将字段改为可选、用类型转换掩盖错误，或在消费方制造默认值。

- [x] 运行针对性运行时测试和 `pnpm run typecheck`；只解决本次必需字段变更导致的测试数据缺失字段。运行受影响测试数据所属的组件测试。快照只提供只读信息，不引入用户可见文案；实现界面时仍必须添加组装总览快照。

## 任务 2：记录读取语义并验证

文件：更新 `packages/client/runtime/README.md` 双语文件对，以及 `.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.md` 中已有的 Mission Control 双语提案。仅当子系统参考已经描述该类型时才更新，不手动编辑生成区域。维护这些文件及本计划的配对记录。

- [x] 在运行时 README 中记录准确区别：`phase` 表示首次基线是否曾经到达；`state` 表示最近的列表请求；`error` 携带该请求的失败信息。已就绪列表可以刷新失败并保留行；空闲状态不能证明传输连接有效。
- [x] Mission Control 提案保持 proposed，只声明请求状态投影已可用；任务总览、传输新鲜度、worktree 和审查仍是独立交付要求。
- [x] 运行具名翻译配对检查、`pnpm run doc-sync`、`pnpm run lint` 和 `git diff --check`。如实记录失败，不宣称总览已完成。
- [x] 先审查规格符合性，再审查代码质量。审查后仅提交范围内文件；不为只涉及数据的前置步骤推送代码或打包 EXE。

## 复核清单

只有当全部规定的请求状态均通过同一列表数据源可见、刷新失败保留行和选择、全部类型化测试数据可编译，且请求、持久化、模型与渲染行为未改变时，本实现才通过验收。整体总览验收仍以链接的规格为准。
