/** Task overview dictionary; runtime failure details retain their original text. */
export const zh = {
  tasks: '任务', newTask: '新建任务', startingTask: '正在创建…', workspace: '新任务的工作区', defaultWorkspace: '当前工作区或选择目录',
  'group.needs-you': '需要你处理', 'group.running': '进行中', 'group.other': '其他',
  'empty.needs-you': '暂无需要处理的任务。', 'empty.running': '暂无进行中的任务。', 'empty.other': '暂无其他任务。',
  empty: '暂无任务。', unassigned: '未分配工作区', idle: '空闲', running: '运行中', unread: '有未读动态',
  approval: '审批', 'plan-review': '计划审阅', question: '问题', subagents: '{n} 个已知子 Agent 运行中',
  'status.needs-attention': '需要处理', 'status.failed': '失败', 'status.running': '运行中',
  'status.reviewing': '评审中', 'status.ready': '可以交付', 'status.settled': '已结束',
  criteria: '验收条件 {completed}/{total}', risks: '{n} 个未解决风险',
  'freshness.live': '实时', 'freshness.disconnected': '数据来自断连前', 'freshness.unavailable': '实时状态不可用',
  'attention.approval': '审批', 'attention.question': '问题', 'attention.plan-review': '计划审阅',
  'attention.run-failure': '运行失败', 'attention.merge-conflict': '合并冲突',
  'attention.validation-failure': '验证失败', 'attention.review-request': '请求评审',
  refresh: '刷新', loading: '正在加载任务和工作区…', refreshing: '正在刷新；已显示的信息可能已过时。',
  disconnected: '连接已断开；已显示的信息可能已过时。', failed: '刷新失败；已显示的信息可能已过时。',
  stale: '任务数据可能已过时。', sessionActivityOnly: '仅显示会话活动',
  notice: '新任务默认在独立的 Git 工作树中运行，不会改动当前项目目录。',
  worktree: '工作树', isolationFailed: '无法创建隔离的工作树', retryIsolation: '重试隔离', useDirect: '直接使用项目',
  useDirectWarning: '直接模式允许 Agent 修改所选项目目录中的文件，请仅在你接受该风险时使用。',
} satisfies Record<string, string>

/** Dictionary key set owned by this plugin. */
export type TaskOverviewKey = keyof typeof zh

/** English task overview copy. */
export const en = {
  tasks: 'Tasks', newTask: 'New Task', startingTask: 'Creating…', workspace: 'Workspace for new task', defaultWorkspace: 'Current workspace or choose a directory',
  'group.needs-you': 'Needs You', 'group.running': 'Running', 'group.other': 'Other',
  'empty.needs-you': 'No tasks need your attention.', 'empty.running': 'No tasks are running.', 'empty.other': 'No other tasks.',
  empty: 'No tasks yet.', unassigned: 'Unassigned', idle: 'Idle', running: 'Running', unread: 'Unread activity',
  approval: 'Approval', 'plan-review': 'Plan review', question: 'Question', subagents: '{n} known running subagent(s)',
  'status.needs-attention': 'Needs attention', 'status.failed': 'Failed', 'status.running': 'Running',
  'status.reviewing': 'Reviewing', 'status.ready': 'Ready', 'status.settled': 'Settled',
  criteria: 'Criteria {completed}/{total}', risks: '{n} unresolved risk(s)',
  'freshness.live': 'Live', 'freshness.disconnected': 'Last known before disconnect',
  'freshness.unavailable': 'Live status unavailable',
  'attention.approval': 'Approval', 'attention.question': 'Question', 'attention.plan-review': 'Plan review',
  'attention.run-failure': 'Run failure', 'attention.merge-conflict': 'Merge conflict',
  'attention.validation-failure': 'Validation failure', 'attention.review-request': 'Review request',
  refresh: 'Refresh', loading: 'Loading tasks and workspaces…', refreshing: 'Refreshing; displayed information may be out of date.',
  disconnected: 'Disconnected; displayed information may be out of date.', failed: 'Refresh failed; displayed information may be out of date.',
  stale: 'Task data may be out of date.', sessionActivityOnly: 'Session activity only',
  notice: 'New tasks run in isolated Git worktrees by default and leave the project directory unchanged.',
  worktree: 'Worktree', isolationFailed: 'Could not create an isolated worktree', retryIsolation: 'Retry isolation', useDirect: 'Use project directly',
  useDirectWarning: 'Direct mode lets the Agent modify files in the selected project directory. Use it only if you accept that risk.',
} satisfies Record<TaskOverviewKey, string>
