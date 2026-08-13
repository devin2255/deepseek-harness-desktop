# Agent Note: 桌面端多 Agent 指挥中心

Status: proposed

[English](2026-08-14-desktop-agent-mission-control.md) | 中文

## 问题

DeepSeek Harness 已提供持久 Session、Workspace、子 Agent、工作流、终端、审批、设置和插件组合的 Web 客户端，但浏览器应用一次只呈现一个当前 Session。开发者同时运行多个 Agent 时，必须切换对话并检查日志，才能知道哪些工作正在运行、被阻塞、等待审查或可以安全整合。只把现有页面包装成桌面应用会保留这个监督问题，也无法建立安全的并行文件系统所有权。

## 提案

增加一个以跨项目任务指挥中心为主界面的桌面产品。第一版中，一个用户任务对应一个根 Session，子 Session 继续表示子 Agent 运行。Task 投影从根日志、后代日志和现有注册表派生状态、注意事项、成功条件、工件、审查就绪状态与运行时事实，不创建第二套任务历史存储。待复核的产品规格和交互细节位于[桌面产品设计](../../../../docs/superpowers/specs/2026-08-14-deepseek-harness-desktop-design.md)，视觉 token 位于 [DESIGN.md](../../../../DESIGN.md)。

会写文件的任务默认使用应用拥有的 Git worktree。新的 worktree 能力负责创建、检查、应用、归档和可恢复清理。它对不支持的仓库或不安全转换返回可执行的错误，不静默降级为写入用户主 checkout。

每个根任务拥有一个集成 worktree。只读子 Agent 可以共享它的快照，一个写 Agent 可以直接修改它。工作流需要多个写 Agent 并行时，每个写 Agent 使用从同一基准创建的子 worktree，并由显式 Integration 节点在审查前把结果合入任务 worktree。声明的路径范围只用于提前发现可能的重叠，不能替代 Git 合并与验证。

桌面壳使用 Electron，因为已发布的 Host、PTY、插件运行时和客户端构建已经依赖 Node 与兼容 Chromium 的 Web API。Electron Main 监管一个运行 desktop profile 的 Node `utilityProcess`，沙箱 Renderer 运行现有插件组合的 React 客户端。Preload bridge 只暴露经过验证的桌面引导和窗口操作，Renderer 不启用 Node 集成。

Harness 进程监听随机 loopback 端口，并在 Origin 检查之外要求每次 HTTP 和 WebSocket 连接携带本次启动生成的 capability。该 capability 通过狭窄的桌面引导 API 提供，不进入 URL、日志、设置或 Session 事件。Electron 业务行为继续由 Cordis 插件承担；Main 只拥有窗口生命周期、进程监管、通知、深链接和更新。

存在活动工作时，关闭最后一个窗口会让 Main 与 Harness 进程继续驻留系统托盘或 macOS 菜单栏。显式退出会报告活动任务数量，并要求用户选择继续运行、停止后退出或取消。异常退出后，恢复流程根据已经记录的事实报告 interrupted、failed 或 settled 状态，不重放未经确认的工具调用。

## 产品结构

默认任务总览按需要人工介入、正在执行和最近完成分组，而不是按对话时间排序。任务工作区呈现 Agent 依赖图、计划、终端、文件、预览、对话、工件和右侧检查器。审查是独立模式，组合成功条件、Diff、验证证据、未解决风险和 worktree 操作。Harness Studio 渐进展示选中任务的 Preset、插件图、模型路由、工具、权限、工作流和事件流。

第一版支持 Windows x64 和 macOS arm64 本地执行。云端执行、手机接力、SSH 主机、计算机控制、市场分发、团队共享和自动创建 Pull Request 不属于第一版。

## 曾考虑的替代方案

**Fork Code OSS 并构建 AI IDE。** 这会提供编辑器和扩展生态，但会让并行监督从属于编辑器导航、继承庞大的无关平台并隐藏 Harness 运行时。产品改为在用户现有编辑器中打开任务 worktree。

**发布薄浏览器包装。** 这可以复用当前 UI，但不会增加持久任务投影、worktree 所有权、进程恢复、原生通知或安全的桌面生命周期，因此没有解决产品问题。

**使用 Tauri 并捆绑 Node sidecar。** Harness 的插件、PTY 和运行时仍需要 Node，因此 Tauri 会增加 Rust 壳和第二套 IPC 架构，却不能移除 Node 进程。Electron utility process 可以复用现有运行时和构建语言。

**向 Renderer 直接暴露 Electron 和 Node API。** 这会加快功能开发，却会消除模型渲染内容与本机权限之间的安全边界。沙箱 Renderer 与狭窄的类型化 bridge 可以让文件系统、进程和更新权限远离展示代码。

**创建独立任务数据库。** 第二份持久记录会与已经负责回放、恢复、fork 和模型可见历史的 Session 事件日志发生漂移。任务模型保持为投影，只为确实新增的持久事实增加 Session 事件。

## 验收标准

- 一个窗口展示多个 Workspace 的任务，并在不打开每段对话的情况下识别运行中、等待、失败、待审查和已完成工作。
- 用户可以在同一仓库启动至少两个隔离的写任务，两个任务和用户主 checkout 都不会看到彼此未提交的改动。
- 每个完成视图都包含成功条件状态、变更文件、验证证据、未解决风险，以及明确的应用、提交、归档或丢弃操作。
- 重启 Renderer 或桌面窗口不会终止 Harness 工作；Host 失败后的重启报告准确的恢复或中断状态，并且不会重复已经提交的工具动作。
- Renderer 代码不启用 Node 集成或通用 Electron IPC；未经授权的 loopback HTTP 和 WebSocket 客户端无法使用 desktop Host。
- 组装后的任务创建、审批、子 Agent 完成、审查、worktree 应用和失败恢复路径具有无密钥 snapshot 与桌面端到端覆盖。

## 风险

- 如果回放与实时折叠不完全一致，或新的持久事实未写入 Session 事件，Task 投影可能成为隐式的第二事实来源。
- Electron 会增加二进制体积，并使 Chromium 安全更新、签名和应用更新成为发布要求。
- 默认并发会增加模型成本和本地资源使用；必须展示并执行全局与项目并发预算。
- 如果运行时结构在具体任务需要之前出现，Harness Studio 会压倒普通用户。
- Git worktree 无法覆盖非 Git 目录、特殊 submodule 布局、磁盘空间不足或所有脏 checkout 转换；直接工作区模式需要明确的风险与恢复行为。
