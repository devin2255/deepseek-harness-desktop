# @deepseek-ai/dsh-client-ui-task-review

English | [中文](README.zh.md)

Reference for the separate Task Review workspace. The plugin occupies `shell.review` and consumes the Client runtime's current review projection. It renders changed files, a bounded unified diff, branch and base facts, acceptance criteria, verification evidence references, unresolved risks, and durable delivery receipts. Review data remains in the React-free Task runtime; the component receives runtime observables and narrow callbacks through its injected props.

The source selector separates root results from direct child results discovered through the durable subagent catalog, including cold children absent from the ordinary Session list. Opening Review observes that catalog; leaving releases the observation, and Refresh reloads both sources and review data. Loading and catalog failures remain visible. Running rows are disabled, and the Host additionally refuses resident or non-isolated children. Child inspection disables every root delivery action and hides root success receipts; it neither commits nor integrates the child. Acceptance criteria and risks remain those of the owning root Task.

The file list retains the selected path across refreshes while that path remains present. Binary and truncated responses are labeled explicitly. Patch text is rendered as text after terminal control sequences and non-layout control characters are removed; the component does not interpret HTML or create filesystem links. Disconnect retains the last review as stale, reconnect refreshes it, and structured Host errors remain retryable. Apply conflicts state that the source checkout stayed unchanged.

Integration history remains visible even when the selected review has no changed files. Each attempt exposes its outcome, selected children, and verified publication or conflict facts. Child inspection uses the same root-addressed selector. Unconfirmed results require Git inspection before retry; a preflight conflict does not imply conflict markers in the root. Unresolved integration conflicts disable root Commit and Apply while allowing Request Changes. A later covering integration labels the historical conflict without hiding it. Root integration never means delivery to the source project.

Request Changes, Create Commit, Apply to Project, and Discard Worktree are separate actions. Every action has a confirmation step. Commit explains that it changes only the task worktree. Apply explains the clean-source, unchanged-HEAD, and three-way preflight requirements. Discard distinguishes unrecoverable uncommitted content from commits retained on the task branch. Successful actions display the Task's durable receipt rather than inferring completion from local UI state.

## Model Experience

None, as this browser-side Task review and delivery surface registers no model input or interaction responses.

#### KV Cache effect

None; this package neither assembles nor sends model requests.

## Known Limitations and Deferred Work

- File and hunk staging is not available; Commit covers the exact complete review revision.
- Verification evidence displays durable Session and sequence references; direct navigation to the referenced transcript is not available.
- Diff search and side-by-side presentation are not available.
- Child commit, batch integration, and conflict resolution actions are not available in this workspace.
