# @deepseek-ai/dsh-client-ui-task-overview

English | [中文](README.zh.md)

Desktop task overview plugin. It occupies the layout's optional `shell.home` slot and adds a persistent Tasks action to `sidebar.footer.action`, including the collapsed sidebar. The Desktop bundle installs it; the ordinary Web bundle does not. There is no package configuration.

In the Desktop profile, the overview consumes the runtime's authoritative Task projection. Each row shows the user-defined goal (falling back to the root Session title for legacy roots), registered Workspace, one of the six derived Task states, active descendant count, satisfied-or-waived criterion progress, unresolved risk count, and live, disconnected, or unavailable freshness. Needs-attention and failed rows appear in Needs You, active rows in Running, and reviewing, ready, and settled rows in Other; Host order is retained within each group. When the Task hook is absent in another composition, the explicit `Session activity only` fallback uses the legacy pure Session selector and never claims criteria, risks, review readiness, or Task freshness.

Each attention item has a navigation action for its exact owner Session. Root Sessions use ordinary navigation; subagents use retained catalog addresses, refreshing only the known direct parent's catalog once when necessary. The optional isolated desktop bridge retains the latest native-notification target until the authoritative Session catalog is ready, then routes it through the same navigation controller; a current failure opens Tasks and remains readable in its alert until a successful or superseding attempt clears it. Ordinary Web composition has no bridge and no desktop-navigation subscription. Isolated Tasks in reviewing, ready, or settled state also expose **Review changes**, which loads the runtime review object before opening the separate Review workspace. Missing or rejected addresses and reviews remain readable errors in the overview. A superseding navigation or plugin disposal prevents a pending lookup from opening a conversation or Review. Navigation never answers a question, grants approval, marks a review ready, or clears an attention item.

New Task accepts an explicit registered Workspace or uses the runtime's current/recent Workspace before entering the existing directory-setup flow. A resolved Workspace requests an application-owned Git worktree by default and opens the new Session only after Host acceptance. An isolation failure remains on the overview with the Host's user-safe diagnostic and the explicit choices **Retry isolation** and **Use project directly**; the client never silently retries in direct mode. Focus enters the recovery panel and returns to New Task after a successful retry. Task rows retain the registered Workspace title and label an assigned execution path as **Worktree**, with the exact path available as hover text. Refresh requests the Task, Session, and Workspace mirrors. Initial loading, synchronized emptiness, refresh failures, stale retained rows, and transport disconnection have distinct messages; disconnected or loading data disables Refresh and New Task. Structured Task command errors remain readable.

## Model Experience

None, as this plugin only projects client metadata and invokes existing navigation actions; it contributes no model input.

#### KV Cache effect

None; this package neither assembles nor sends model requests.

## Known Limitations and Deferred Work

- Active-descendant display uses already known Session summaries; the Task Provider owns descendant membership and attention aggregation.
- Archived tasks have no overview or unarchive control; merge, removal, and repair controls for completed worktrees remain deferred.
