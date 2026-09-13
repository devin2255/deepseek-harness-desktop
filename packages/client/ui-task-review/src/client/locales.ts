/** Task Review workspace dictionary. */
export const zh = {
  review: '变更审查', back: '返回任务', refresh: '刷新', loading: '正在加载审查内容…', stale: '连接已断开；当前审查内容可能已过时。',
  retry: '重试', empty: '这个任务没有可审查的文件变更。', files: '变更文件', diff: '统一 Diff', inspector: '验收与风险',
  branch: '分支', base: '基准提交', head: '任务提交', sourceHead: '源工作区 HEAD', sourceDirty: '任务开始时源工作区有未提交变更',
  additions: '+{n}', deletions: '−{n}', binary: '二进制文件没有可显示的文本 Diff。', truncated: '内容超过安全显示上限，已截断。',
  noDiff: '选择文件后查看 Diff。', diffLoading: '正在加载文件 Diff…', criteria: '验收条件', risks: '未解决风险', evidence: '验证证据',
  noCriteria: '未定义验收条件。', noRisks: '没有未解决风险。', noEvidence: '暂无验证证据。',
  'criterion.pending': '待验证', 'criterion.satisfied': '已满足', 'criterion.failed': '未通过', 'criterion.waived': '已豁免',
  'risk.low': '低', 'risk.medium': '中', 'risk.high': '高', 'risk.critical': '严重',
  requestChanges: '要求修改', commit: '创建提交', apply: '应用到项目', discard: '丢弃工作树', close: '取消', confirm: '确认',
  commitMessage: '提交说明', commitPlaceholder: '说明这次任务完成了什么', busy: '正在处理…',
  confirmChanges: '确认要求 Agent 继续修改？当前审查结论会被记录，任务重新进入执行流程。',
  confirmCommit: '将在任务的隔离工作树中创建 Git 提交，不会修改你的项目目录。',
  confirmApply: '应用前会重新检查源工作区必须干净且 HEAD 未移动，并先执行三方冲突预检；预检失败不会修改项目目录。',
  confirmDiscardClean: '将移除任务工作树。已有提交仍保留在任务分支上，可以恢复。',
  confirmDiscardDirty: '工作树还有未提交变更。丢弃后这些内容无法恢复；已有提交仍保留在任务分支上。',
  conflict: '应用发生冲突；源工作区保持原样。请处理源分支变化后重试。',
  successCommit: '任务变更已提交。', successApply: '任务提交已安全应用到项目。', successDiscard: '任务工作树已移除。', successChanges: '已要求 Agent 修改。',
  preservedBranch: '保留分支', recoverableCommit: '可恢复提交', removed: '工作树已移除', discardedDirty: '已丢弃未提交变更',
  error: '无法完成操作', fileStatus: '{status} · {change}',
  'file.added': '新增', 'file.modified': '修改', 'file.deleted': '删除', 'file.renamed': '重命名', 'file.copied': '复制',
  'file.type-changed': '类型变化', 'file.untracked': '未跟踪', 'file.conflicted': '冲突', unknownChanges: '二进制',
} satisfies Record<string, string>

/** Dictionary key set owned by the plugin. */
export type TaskReviewKey = keyof typeof zh

/** English Task Review copy. */
export const en = {
  review: 'Change Review', back: 'Back to Tasks', refresh: 'Refresh', loading: 'Loading review…', stale: 'Disconnected; this review may be out of date.',
  retry: 'Retry', empty: 'This task has no file changes to review.', files: 'Changed files', diff: 'Unified diff', inspector: 'Acceptance & risk',
  branch: 'Branch', base: 'Base commit', head: 'Task HEAD', sourceHead: 'Source HEAD', sourceDirty: 'Source workspace had uncommitted changes when the task started',
  additions: '+{n}', deletions: '−{n}', binary: 'Binary files have no text diff to display.', truncated: 'Content exceeded the safe display limit and was truncated.',
  noDiff: 'Select a file to inspect its diff.', diffLoading: 'Loading file diff…', criteria: 'Acceptance criteria', risks: 'Unresolved risks', evidence: 'Verification evidence',
  noCriteria: 'No acceptance criteria were defined.', noRisks: 'No unresolved risks.', noEvidence: 'No verification evidence yet.',
  'criterion.pending': 'Pending', 'criterion.satisfied': 'Satisfied', 'criterion.failed': 'Failed', 'criterion.waived': 'Waived',
  'risk.low': 'Low', 'risk.medium': 'Medium', 'risk.high': 'High', 'risk.critical': 'Critical',
  requestChanges: 'Request Changes', commit: 'Create Commit', apply: 'Apply to Project', discard: 'Discard Worktree', close: 'Cancel', confirm: 'Confirm',
  commitMessage: 'Commit message', commitPlaceholder: 'Describe what this task completed', busy: 'Working…',
  confirmChanges: 'Ask the Agent to revise this result? The review decision is recorded and the task returns to execution.',
  confirmCommit: 'This creates a Git commit inside the isolated task worktree and does not modify your project directory.',
  confirmApply: 'Before applying, the source workspace must be clean with an unchanged HEAD and a three-way conflict preflight must pass. A failed preflight leaves the project untouched.',
  confirmDiscardClean: 'This removes the task worktree. Existing commits remain recoverable on the task branch.',
  confirmDiscardDirty: 'The worktree has uncommitted changes. Discarding makes those changes unrecoverable; existing commits remain on the task branch.',
  conflict: 'Apply conflicted; the source workspace was left unchanged. Resolve source branch movement and retry.',
  successCommit: 'Task changes were committed.', successApply: 'The task commit was safely applied to the project.', successDiscard: 'The task worktree was removed.', successChanges: 'Changes were requested from the Agent.',
  preservedBranch: 'Preserved branch', recoverableCommit: 'Recoverable commit', removed: 'Worktree removed', discardedDirty: 'Uncommitted changes discarded',
  error: 'Could not complete the operation', fileStatus: '{status} · {change}',
  'file.added': 'Added', 'file.modified': 'Modified', 'file.deleted': 'Deleted', 'file.renamed': 'Renamed', 'file.copied': 'Copied',
  'file.type-changed': 'Type changed', 'file.untracked': 'Untracked', 'file.conflicted': 'Conflicted', unknownChanges: 'Binary',
} satisfies Record<TaskReviewKey, string>
