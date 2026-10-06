/** Copy for the task-scoped, read-only runtime inspector. */
export const zh = {
  title: 'Harness Studio', back: '返回任务', noTask: '先从任务总览选择一个任务。',
  recorded: '任务日志中的事实', preset: 'Agent 预设', noPreset: '此会话未记录预设',
  recordedPlugins: '此任务的预设插件', recordedPluginsHint: '来自会话日志中实际挂载的预设代际；不包含插件配置与凭据。',
  compositionLoading: '正在读取任务插件记录…', compositionError: '无法读取任务插件记录。',
  noComposition: '此会话没有已记录的预设插件快照', noRecordedPlugins: '此预设未挂载插件条目',
  model: '模型路由', noRequest: '尚无已记录的模型请求', requestStatus: '最近请求状态',
  tools: '发送给模型的工具', noTools: '最近请求未发送工具', system: '系统提示词',
  noSystem: '最近请求没有系统提示词', events: '近期事件', noEvents: '当前加载窗口中没有事件',
  currentHost: '当前 Host 插件', currentHostHint: '这是当前 Loader 清单，不是任务创建时的插件快照。',
  pluginsLoading: '正在读取插件清单…', pluginsError: '无法读取当前插件清单。', retry: '重试',
  noPlugins: '当前没有插件条目', enabled: '启用', disabled: '禁用',
  pending: '等待中', loading: '加载中', active: '活动', failed: '失败', unloading: '卸载中', unobserved: '未观察到运行状态',
  incomplete: '尚未记录的运行时信息', incompleteHint: '权限与工作流目前没有不可变的逐任务会话快照；此处不会用当前全局配置冒充历史事实。',
  partial: '事件仅包含当前已加载的会话窗口；可在轨迹视图继续加载更早记录。',
} satisfies Record<string, string>

/** Localized Studio key set. */
export type StudioKey = keyof typeof zh

/** English counterpart for the same UI states. */
export const en = {
  title: 'Harness Studio', back: 'Back to task', noTask: 'Select a task from the overview first.',
  recorded: 'Facts recorded in this task', preset: 'Agent preset', noPreset: 'No preset recorded for this session',
  recordedPlugins: 'Preset plugins for this task', recordedPluginsHint: 'Captured from the preset generation this session actually joined; plugin config and credentials are excluded.',
  compositionLoading: 'Reading task plugin record…', compositionError: 'Could not read the task plugin record.',
  noComposition: 'No preset plugin snapshot was recorded for this session', noRecordedPlugins: 'This preset mounted no plugin entries',
  model: 'Model route', noRequest: 'No model request recorded yet', requestStatus: 'Latest request status',
  tools: 'Tools sent to the model', noTools: 'No tools sent in the latest request', system: 'System prompt',
  noSystem: 'No system prompt in the latest request', events: 'Recent events', noEvents: 'No events in the loaded window',
  currentHost: 'Current Host plugins', currentHostHint: 'This is the current Loader inventory, not the task-creation plugin snapshot.',
  pluginsLoading: 'Reading plugin inventory…', pluginsError: 'Could not read the current plugin inventory.', retry: 'Retry',
  noPlugins: 'No plugin entries', enabled: 'Enabled', disabled: 'Disabled',
  pending: 'Pending', loading: 'Loading', active: 'Active', failed: 'Failed', unloading: 'Unloading', unobserved: 'No observed runtime state',
  incomplete: 'Runtime facts not yet recorded', incompleteHint: 'Permissions and workflows do not yet have immutable per-task session snapshots; current global configuration is not presented as history.',
  partial: 'Events cover only the currently loaded session window; load older records in Trajectory.',
} satisfies Record<StudioKey, string>
