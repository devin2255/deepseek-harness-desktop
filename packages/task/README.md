# task/ - durable task projection capability family

English | [中文](README.zh.md)

The durable task event vocabulary and its cross-session projection implementation. The Service Definition keeps wire-safe values separate from the Session-backed Host Provider.

| Package | Role | ctx key |
|---|---|---|
| `task/` | Service Definition, branded task values, and whole-value durable Session events | `tasks` |
| `task-session/` | Session-persistence Provider, subagent-tree aggregation, live generations, and attention projection | `tasks` |
| `task-worktree/` | Service Definition for Task-owned isolated Git worktrees | `taskWorktrees` |
| `task-worktree-local/` | Local Git Provider with fail-closed preflight and live assignment inspection | `taskWorktrees` |

Task facts are log-only and do not enter model requests or the model-visible Session surface. The Provider lists persisted Sessions at startup, overlays exact live Session logs, and groups only uninterrupted `origin: 'subagent'` ancestry under a root Task. Ordinary forks remain independent roots.

`TaskSessionProvider` publishes detached whole-row snapshots. Persistent definitions, criteria, risks, review decisions, pending approvals, and latest run failures replay from Session events. Generation-scoped activity and attention can be replaced atomically; invalidating a generation retains its last facts as `disconnected` until a newer baseline arrives. Commands compare `expectedSeq` with the root log, validate evidence against the same Task tree, and append exactly one event without resuming an Agent.

Task worktree Providers create and inspect execution directories; Task consumers remain responsible for recording returned assignment facts in the root Session log. Creation never silently falls back to the user's source checkout.
