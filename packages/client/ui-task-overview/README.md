# @deepseek-ai/dsh-client-ui-task-overview

English | [中文](README.zh.md)

Desktop task overview plugin. It occupies the layout's optional `shell.home` slot and adds a persistent Tasks action to `sidebar.footer.action`, including the collapsed sidebar. The Desktop bundle installs it; the ordinary Web bundle does not. There is no package configuration.

The overview derives ordinary, nonblank, unarchived tasks from the runtime's listed session ids. Workspace labels use registry membership, never directory matching. Known descendants count only across uninterrupted subagent-origin parent chains; ordinary forks remain independent tasks. A pending approval, plan review, or question on the task or a known descendant places it in Needs You. Otherwise a running task or known descendant places it in Running; remaining tasks appear in Other. Each group orders by last update descending, then session id. Unread activity is a reminder, not a success or review-readiness claim.

Each pending owner has a navigation action. Ordinary tasks use session navigation; subagents use retained catalog addresses, refreshing only the known direct parent's catalog once when necessary. Missing or rejected addresses remain readable errors in the overview. A superseding navigation or plugin disposal prevents a pending lookup from opening a conversation. These actions never submit interaction responses.

New Task accepts an explicit registered workspace or uses the runtime's existing current/recent-workspace and directory-setup flow. Tasks run directly in the selected directories, without automatic worktree isolation. Refresh requests both metadata lists. Initial loading, synchronized emptiness, failures, and stale retained rows have distinct messages; disconnected or loading metadata disables Refresh and New Task. Runtime error details remain readable.

## Model Experience

None, as this plugin only projects client metadata and invokes existing navigation actions; it contributes no model input.

#### KV Cache effect

None; this package neither assembles nor sends model requests.

## Known Limitations and Deferred Work

- Only already known subagent summaries contribute pending states and running counts; the overview does not enumerate logs or poll undiscovered catalogs.
- Archived tasks have no overview or unarchive control, and this plugin does not manage isolated worktrees.
