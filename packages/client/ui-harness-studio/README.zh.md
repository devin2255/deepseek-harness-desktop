# @deepseek-ai/dsh-client-ui-harness-studio

[English](README.md) | 中文

Desktop 组合包安装此只读 `shell.studio` 工作区。任务行的“查看运行时”会选中对应根 Session 并打开 Studio；“返回任务”会返回该会话，不改变 Session 或正在运行的 agent。页面在隐藏期间保持挂载，但仅在页面活动且选中了任务时读取已记录的组成与当前 Host 插件清单。任一读取失败后都可重试，不会遮蔽其他任务日志事实。

已记录信息区读取 Session 摘要中的预设 id，以及从已加载 Session 日志组装的 Trajectory 目标。页面显示最近一次具有已记录请求头的普通请求，包括提供方与模型、状态、完整的工具名称和说明，以及渲染后的系统提示词。`agentPreset.composition` 从在线或冷 Session 的完整日志读取最近一次持久化的插件身份，不恢复 agent；没有事件时明确显示未记录，绝不从当前预设文件推测历史。近期事件列表仅包含已加载窗口中最后十二条投影记录，不是完整事件审计。`ctx.trajectory.inspect()` 是读取同一目标快照的只读 service，因此 Studio 不复制运行时状态，也不导入 Trajectory 组件。独立的“当前 Host 插件”区调用 `pluginInventory.list()`，明确将 Loader 清单标为当前部署状态，而不是所选任务已记录的插件条目。

## Model Experience

无，因为 Studio 读取已记录的模型输入，但不添加或修改输入，也不发送请求。

#### KV Cache effect

无；该包既不组装也不发送提供方请求。

## Known Limitations and Deferred Work

- 权限与工作流决策尚无完整的逐任务运行时快照。已记录插件列表只包含模块身份和实际启用状态，不包含配置值、依赖边或运行阶段。
- 请求和事件检查只覆盖当前已加载的 Session 窗口。更早的记录可在 Trajectory 中翻页查看，Studio 本身不翻页。
