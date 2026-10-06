# @deepseek-ai/dsh-client-ui-harness-studio

English | [中文](README.zh.md)

The Desktop bundle installs this read-only `shell.studio` workspace. **Inspect runtime** on a Task row selects that root Session and opens Studio; **Back to task** returns to its conversation without changing the Session or its running agent. The page stays mounted while hidden, but reads recorded composition and current Host inventory only when it becomes active with a selected task. Either read can be retried without hiding other task-log facts.

The recorded section reads the Session summary's preset id and the Trajectory target assembled from the loaded Session log. It shows the latest ordinary request with a recorded header, including provider/model, status, complete tool names and descriptions, and rendered system prompt. `agentPreset.composition` reads the latest durable plugin identities from the complete attached or cold Session log without resuming an Agent; a missing event is shown as unrecorded, never reconstructed from the current preset file. The recent event list contains the last twelve projected records in the loaded window; it is not a complete event audit. `ctx.trajectory.inspect()` is a read-only service over the same target snapshot, so Studio neither copies runtime state nor imports a Trajectory component. The separate **Current Host plugins** section calls `pluginInventory.list()` and explicitly labels that Loader inventory as current deployment state, not the selected task's recorded plugin rows.

## Model Experience

None, as Studio reads recorded model inputs but does not add or alter an input or send a request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Permission and workflow decisions lack a complete per-task runtime snapshot. The recorded plugin list captures module identities and effective enabled state, not configuration values, dependency edges, or runtime phase.
- Request and event inspection cover only the currently loaded Session window. Earlier records remain available through Trajectory paging, not Studio paging.
