# task/ - durable task projection capability family

English | [中文](README.zh.md)

The durable task event vocabulary and its cross-session projection implementations. The first package currently owns only the event and detached-value vocabulary.

| Package | Role | ctx key |
|---|---|---|
| `task/` | Branded task values and whole-value durable Session events | (none) |

Task facts are log-only and do not enter model requests or the model-visible Session surface.
