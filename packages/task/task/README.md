# @deepseek-ai/dsh-task

English | [中文](README.zh.md)

The durable vocabulary and Service Definition for root tasks, acceptance criteria, evidence, risks, review decisions, and unified attention rows. Task facts use whole-value Session events with strict replay validation, so recovery never depends on process-local state. Evidence identifies an exact event sequence in the root task tree.

## Model Experience

None, as task events are log-only facts and do not enter model requests or the model-visible Session surface.

#### KV Cache effect

None. Recording or replaying task facts does not change provider requests.

## Known Limitations and Deferred Work

- The cross-session Provider and Host API are not included yet.
- Evidence references are structurally validated here; the Provider validates that each referenced event belongs to the same root task tree.
