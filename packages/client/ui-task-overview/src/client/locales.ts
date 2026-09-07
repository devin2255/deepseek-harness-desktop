/** Task overview dictionary; runtime failure details retain their original text. */
export const zh = {
  tasks: '任务', newTask: '新建任务', workspace: '新任务的工作区', defaultWorkspace: '当前工作区或选择目录',
  'group.needs-you': '需要你处理', 'group.running': '进行中', 'group.other': '其他',
  'empty.needs-you': '暂无需要处理的任务。', 'empty.running': '暂无进行中的任务。', 'empty.other': '暂无其他任务。',
  empty: '暂无任务。', unassigned: '未分配工作区', idle: '空闲', running: '运行中', unread: '有未读动态',
  approval: '审批', 'plan-review': '计划审阅', question: '问题', subagents: '{n} 个已知子 Agent 运行中',
  refresh: '刷新', loading: '正在加载任务和工作区…', refreshing: '正在刷新；已显示的信息可能已过时。',
  disconnected: '连接已断开；已显示的信息可能已过时。', failed: '刷新失败；已显示的信息可能已过时。',
  notice: '任务直接在所选目录中运行，不会自动创建隔离的 Git 工作树。',
} satisfies Record<string, string>

/** Dictionary key set owned by this plugin. */
export type TaskOverviewKey = keyof typeof zh

/** English task overview copy. */
export const en = {
  tasks: 'Tasks', newTask: 'New Task', workspace: 'Workspace for new task', defaultWorkspace: 'Current workspace or choose a directory',
  'group.needs-you': 'Needs You', 'group.running': 'Running', 'group.other': 'Other',
  'empty.needs-you': 'No tasks need your attention.', 'empty.running': 'No tasks are running.', 'empty.other': 'No other tasks.',
  empty: 'No tasks yet.', unassigned: 'Unassigned', idle: 'Idle', running: 'Running', unread: 'Unread activity',
  approval: 'Approval', 'plan-review': 'Plan review', question: 'Question', subagents: '{n} known running subagent(s)',
  refresh: 'Refresh', loading: 'Loading tasks and workspaces…', refreshing: 'Refreshing; displayed information may be out of date.',
  disconnected: 'Disconnected; displayed information may be out of date.', failed: 'Refresh failed; displayed information may be out of date.',
  notice: 'Tasks run directly in their selected directories; there is no automatic worktree isolation.',
} satisfies Record<TaskOverviewKey, string>
