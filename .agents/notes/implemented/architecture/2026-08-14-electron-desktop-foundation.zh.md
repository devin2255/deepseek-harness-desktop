# Agent Note: Electron 桌面端安全与生命周期基础

Status: implemented

[English](2026-08-14-electron-desktop-foundation.md) | 中文

## 问题

桌面应用需要本机进程与窗口权限，但不能让由模型渲染的 Renderer 内容获得 Node、Electron IPC 或 Harness 回环能力凭证。Electron 生命周期回调可能在启动仍未完成时到达，异步窗口重建也可能在事件回调返回后抛出异常。若退出操作无限等待 `app.whenReady()`，Electron 就无法结束自己拥有的启动过程。

## 决策

[`apps/desktop`](../../../../apps/desktop/README.md) 拥有 Electron Main 基础：它在就绪前启用 Chromium 沙箱，获取单实例锁，只在就绪后启动一个桌面 profile Harness 工具进程，并从已就绪的回环端点创建一个已授权的 BrowserWindow。Main 只拥有进程、窗口与应用生命周期；Harness 插件继续拥有产品和 Session 状态。

Renderer 保持沙箱化，启用上下文隔离，禁用 Node 集成，并使用仅含平台信息的冻结 preload 桥接。隔离的 Electron 会话只为所拥 Renderer 的精确 HTTP 与 WebSocket 回环源添加每次启动生成的 Bearer 能力凭证。导航、重定向、新窗口和权限请求都会拒绝该源之外的权限。

生命周期把启动取消视为已拥有的状态，而不是在退出时等待 Electron 就绪。`before-quit` 中止启动信号，释放启动的就绪等待，等待已拥有的启动过程结算，停止一次已就绪 Harness，并在锁存状态下再次调用 `app.quit()`。每个 Electron 回调都会报告并隔离故障；macOS 重建窗口的 Promise 会捕获窗口创建以及创建后聚焦的故障。

已构建的 Electron 验收测试在仓库构建后运行于原生 Windows 完整 CI 清单。普通单元测试继续使用 mock Electron 边界，不会启动 Electron。

更广泛的[桌面端多 Agent 指挥中心提案](../../proposed/feature/2026-08-14-desktop-agent-mission-control.md)仍处于 proposed 状态；它拥有 Task 投影、worktree 策略与后续产品行为，而不是这个已发布的 shell 基础。

## 曾考虑的替代方案

**向 Renderer 公开通用 Electron 或 Node API。** 这种展示层妥协会把本机权限和启动能力凭证暴露给模型渲染的内容。隔离会话与窄 preload 桥接保留权限划分。

**退出时让启动始终阻塞于 `app.whenReady()`。** 在每一种生命周期排序中，Electron 都不一定能在退出前让就绪状态结算，因此关闭可能死锁。启动取消会释放应用拥有的等待，同时允许后续 Electron 就绪 promise 无害地结算。

**在普通单元测试套件中运行 Electron。** Electron 需要原生可执行文件与测试专用用户数据隔离，不适合 source-only 单元测试 lane。真实应用作为已构建验收测试运行在原生 Windows CI 清单中。

## 后果

这个基础为操作系统权限提供一个明确的归属方，并且通过真实 Electron 进程证明其安全态势，包括回环授权和 Renderer 隔离。它的生命周期会等待已拥有的工作完全停稳，并报告回调故障，而不会产生未处理的 Promise 拒绝。

Electron 仍是原生 CI 依赖，因此验收测试运行在非阻塞的原生 Windows 清单，而不是基于 Wine 的必需 Windows 构建通道。托盘驻留、感知任务的退出选择、更新和恢复策略仍在这个基础之外。
