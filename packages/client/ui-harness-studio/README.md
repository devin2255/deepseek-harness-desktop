# @deepseek-ai/dsh-client-ui-harness-studio

English | [中文](README.zh.md)

The Desktop bundle installs this read-only `shell.studio` workspace. **Inspect runtime** on a Task row selects that root Session and opens Studio; **Back to task** returns to its conversation without changing the Session or its running agent. The page stays mounted while hidden, but reads the current Host plugin inventory only when it becomes active with a selected task. A failed inventory read can be retried without hiding task-log facts.

The recorded section reads the Session summary's preset id and the Trajectory target assembled from the loaded Session log. It shows the latest ordinary request with a recorded header, including provider/model, status, complete tool names and descriptions, and rendered system prompt. The recent event list contains the last twelve projected records in the loaded window; it is not a complete event audit. `ctx.trajectory.inspect()` is a read-only service over the same target snapshot, so Studio neither copies runtime state nor imports a Trajectory component. The separate **Current Host plugins** section calls `pluginInventory.list()` and explicitly labels that Loader inventory as current deployment state, not the selected task's historical plugin graph.

## Model Experience

None, as Studio reads recorded model inputs but does not add or alter an input or send a request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Permissions, workflows, and a per-task plugin graph have no immutable Session snapshot yet; Studio states their absence rather than presenting current global configuration as history.
- Request and event inspection cover only the currently loaded Session window. Earlier records remain available through Trajectory paging, not Studio paging.
