# @deepseek-ai/dsh-tool-subagent-control

English | [中文](README.zh.md)

The optional, globally named `send_message`, `interrupt_agent`, and `list_agents` tools are thin adapters over `ctx.subagents`. Provider-bound `@deepseek-ai/dsh-tool-subagent` instances register distinct delegation tools per transport; this separately loaded package registers shared control tools once, so multiple delegation tools never register duplicate global controls. The root plugin registers `send_message` and `interrupt_agent` and requires only `subagents`; the separately loadable `./list-agents` plugin registers `list_agents` and declares `subagents` plus `agents` as load-time dependencies. Its catalog reads additionally require the session store and projection registry at call time, but no query service. A deployment can keep the root tools while omitting the list tool. No tool's presence determines whether a delegation tool starts continuable work. These tools own only the parent-to-child direction; the independently installed [`@deepseek-ai/dsh-tool-subagent-report`](../tool-subagent-report/README.md) owns the child-to-parent direction.

The tool performs no lifecycle routing — residency and cold resume belong to the subagent service. It passes `exec.agent` as the exact live parent that authorizes delivery and records every message source as `{ kind: 'coordinator', senderSessionId: parent.id }`, which the service retains but never treats as authority. Every message becomes the subagent's next FIFO turn through `Agent.followup()`: if the child is still working, the message waits until its current turn finishes, so it cannot redirect work already underway. The tool forwards its execution signal, which owns admission only until inbox acceptance; once the child accepts the message the accepted turn cannot be cancelled through this tool. This call returns no child reply — its transcript by that id is the source of what it did — and a child with `report` sends content on its own initiative as a separate parent message. A delivery failure becomes an errored tool result stating the message was not delivered.

`interrupt_agent(agent_id)` passes `exec.agent` as the exact live ancestor authority for `ctx.subagents.interrupt()`: the target may be a direct child or a deeper descendant, and the service — never this tool — verifies the caller against the target Activation's recorded lineage. Only the target's current turn stops (`keepInbox`): queued messages stay parked until a later `send_message`, published descendants keep running, and the child stays available for follow-ups. The call returns as soon as the stop request is accepted, without waiting for target quiescence; an absent or already-settled target is an accepted no-op, while self, sibling, stale, and non-ancestor callers become errored results.

`list_agents` takes one optional `scope` argument, derives the root id from the calling agent, and projects the service catalog to continuable children without a cursor. The default `children` scope reads `ctx.subagents.listChildren()`; `descendants` reads `ctx.subagents.listDescendants()`, whose one-corpus walk crosses ordinary sessions and one-shot children and renders surviving rows in stable pre-order with `parent=<id> depth=<n>`. The `parent` annotation is the durable direct-parent session id and may name an ordinary session omitted from the output. For the calling agent, only depth-1 child entries are `send_message` candidates; deeper child entries are `interrupt_agent` candidates only. Status comes from the live Agent registry: `running` (active driver), `idle` (resident between turns, possibly waiting on agents it started), or `ready` (storage only and resumable rather than terminal). The service result also contains one-shot session-backed subagents for consumers such as a UI, but those entries are omitted from this model tool because they cannot accept `send_message`. Diagnostics remain visible, with positions in the descendants scope. Durable identity and mode come from each child's descriptor, while delivery-time authority and Activation ownership checks remain the service's.

<a id="isolated-writer-results"></a>

## Isolated writer results

The opt-in `./integrate` plugin registers `review_agent_changes`, `commit_agent_changes`, and `integrate_agents`. It requires `tools`, `agents`, `sessions`, `sessionPersistence`, `tasks`, `taskReview`, and `sandboxPolicy`. Only the exact registered root Agent in its available managed Task worktree can use them. Each child must have its own recorded isolated assignment matching its immutable direct-parent metadata, Workspace, source worktree, and execution cwd. Active or resident children are rejected; cold inspection does not activate them. Mutations additionally enforce root write authority in the executor.

Review returns bounded files, an optional member diff, the child's revision and current commit, and the independently inspected root revision. Commit requires the child revision and returns its committed revision and commit. Integration selects those exact child revisions and commits plus the root revision. The [Provider](../../task/task-review-local/README.md) preflights the complete batch; conflicts return structured results, never partial publication or automatic resolution. All three tools use generic cards and schema-validated JSON text. Ordinary durable tool results retain the receipts without claiming human approval or root delivery. The [assembled example](../../../examples/headless-agent/writer-integration.cordis.snapshot.yml) keeps this opt-in separate from desktop defaults.

All selected writers are atomically reserved offline before ownership inspection and remain reserved through the complete tool operation. Agent creation, resumption, and competing review or delivery reject until it settles; failures and cancellation release the batch. The reservation ends at the tool result, so it does not authorize a later mutation or prevent subsequent resumption. This plugin provides neither cross-process locking nor conflict-resolution UI; see the [reservation decision](../../../.agents/notes/implemented/architecture/2026-10-08-offline-session-reservations.md).

## Model Experience

### Tool schema

#### What the model sees

The generated [schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent-control): `send_message` takes `subagent_id` and `message`, describing that the message becomes the subagent's next turn, that this call returns no answer from the subagent, and that a failure means the message was not delivered; `interrupt_agent` takes `agent_id`, describing that only the current turn stops, queued messages park, descendants keep running, and acceptance precedes the actual stop; `list_agents` takes the optional `scope` enum.

#### Token effect

Fixed schema cost per parent request.

#### KV Cache effect

Prefix-stable; the schema does not change at runtime.

### Interrupt result

#### What the model sees

`interrupt requested for agent <agent_id>` on acceptance. An unauthorized caller — self, sibling, stale, or non-ancestor — is an errored result naming the rejection; an absent or settled target still renders the acceptance line.

#### Token effect

One short acknowledgement per call; the interrupted turn's abort is visible only in the child's own transcript.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

### Delivery result

#### What the model sees

`message queued as the next turn for subagent <subagent_id>` on acceptance; the canonical output carries the accepted `messageId`. A failure — an unauthorized or unknown child, a descriptor-less child that cannot be resumed, or admission rejected — is an errored result whose message states the message was not delivered.

#### Token effect

One short acknowledgement per call; the child's response never returns through this call. A separately granted `report` may append selected content to parent history.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Listing result

#### What the model sees

One line per continuable child in stable catalog order: `<id> [<status>] — <label>` (`running` = active driver, `idle` = resident between turns, `ready` = storage only; resumable rather than terminal, not a result waiting to be collected — a direct child in that state can be resumed by `send_message`), plus `<id> [diagnostic: <reason>]` for a candidate that could not be read (`corrupt`, `unsupported`, or `unavailable`). The `descendants` scope inserts ` parent=<id> depth=<n>` before the label dash on every line, in pre-order. One-shot children are intentionally absent; `(no subagents)` means no continuable child or diagnostic survived the projection. Diagnostics never expose descriptor contents.

#### Token effect

Grows linearly with the listed continuable children — the whole tree under the `descendants` scope; there is no cursor or cap, so long-lived parents with many persisted children pay the full list each call.

#### KV Cache effect

Append-only; each result follows the reusable request prefix.

### Writer result

#### What the model sees

Opt-in tool schemas describe review, exact-revision commit, and batch integration. JSON results contain bounded file summaries and optional diffs, exact commit receipts, or an integration receipt or conflict with contributor identities and paths. Authority denials, stale revisions, dirty trees, and Git failures return errored results.

#### Token effect

Fixed opt-in schema cost plus data-dependent bounded review output and contributor identities.

#### KV Cache effect

Append-only results; enabling the tools changes the reusable schema prefix.

## Known Limitations and Deferred Work

- **A queued message has no independent result** — acceptance returns only its inbox `messageId`; the child's work lands in the durable child Session and is never collected through this tool. A child granted `report` may send selected content back separately, but that message is not this call's result.
- **No steering of the current turn** — every message opens a later FIFO turn, so a message sent while the child is working runs only after its current turn finishes and cannot redirect it.
- **Listing is a snapshot, not a delivery promise** — it may race publication, disposal, or a later message, and another process may activate a child this process reports as `ready`; cross-process accuracy requires a shared lease. `interrupt_agent` performs the authoritative live-lineage check itself, so discovery staleness cannot grant authority.
- **No pagination or deletion** — the complete stably ordered set is returned, and persisted children remain listed for as long as their sessions remain in persistence; a service-level bound or delete operation is a later product decision.
