# Agent Note: Isolated writer continuation

Status: implemented

English | [中文](2026-10-07-isolated-writer-continuation.zh.md)

## Problem

[Isolated one-shot writers](2026-10-06-isolated-subagent-writer-preparation.md) can implement independent changes, but later instructions need the same checkout and recorded authority. Ordinary [continuable children](2026-07-28-continuable-subagent-conversations.md) reconstruct from their Session independently of the establishing provider. A directory string alone cannot prove that a resumed writer still owns its registered Git worktree.

## Decision

`ContinuableCreateSpec.execution` supplies detached cwd, captured policies, and non-surface initialization events. The continuation manager persists those inputs during unpublished setup and adds the required, model-hidden `subagent/execution-provider` record. On initial creation and cold resume, the recorded provider must still register `validateContinuableExecution()`. The manager verifies its identity against the child's own descriptor and passes the actual unpublished header and events, not an earlier persistence inspection. Validation, cancellation, and parent-drain checks precede publication and inbox acceptance. The manager alone owns creation, activation, delivery, and disposal; providers receive no child handle.

The isolated spawn validator requires the direct root Task's managed integration assignment, matching child id, parent, origin, cwd, and source directory, recorded workspace-write or narrower read-only authority, and approval `never`. The worktree service verifies the live canonical Git path, registered branch, and baseline ancestry. Dirty child files are allowed. Missing directories, detached or replaced branches, elevated permissions, and unavailable ownership reject recovery without accepting the follow-up. Cold resume never creates another worktree or captures the parent's newer permissions.

The factory's synchronous publication commit also requires the validated provider to remain registered under the same identity. Removal or replacement during asynchronous validation or subsequent setup rolls back the unpublished child; a completed callback cannot authorize publication after its provider disappears.

The event declaration belongs to the public types module so external consumers receive its Session augmentation. The NodeNext declaration check compiles package-owned `tests/node-next-types.mts` fixtures in separate projects: importing every workspace API together can conceal a missing declaration through unrelated augmentations. Standard canonical symlink resolution keeps peer imports on the same Session type instance; preserving workspace link paths can separate that instance from its augmentation. The isolated subagent fixture requires the execution event and rejects a missing provider field.

Ordinary shared children have no execution-provider record and retain provider-independent cold resume. Fork seeds do not supply execution authority: validation reads the child's own event suffix. Model-route resolution occurs before asynchronous preparation, alongside policy capture.

## Alternatives considered

**Trust the persisted cwd.** Rejected because a path can disappear or identify a detached or replaced checkout. Recorded ownership must agree with live Git identity.

**Let the provider resume or retain the child handle.** Rejected because it duplicates activation ownership, inbox ordering, and child-first teardown. Validation is read-only with respect to Agent lifecycle.

**Validate only the preliminary persistence inspection.** Rejected because the factory may resume a newer stored revision. The validation input must be the Session that is about to publish.

**Require every shared child to keep its initial provider.** Rejected because ordinary reconstruction needs no external execution resource. Only an explicit execution-provider record introduces that dependency.

## Consequences

Explicit isolated continuable writers keep their checkout, transcript, and creation authority across residency epochs. Unloading their validator makes later cold activation unavailable rather than silently recovering as shared execution. Existing shared-child continuation and one-shot ownership remain independent. A cancelled or failed creation preserves any prepared checkout as recovery data.

The preparation and generic continuation notes remain active: their clean-baseline and single-inbox ownership rationales still apply, while this note owns execution validation. [Desktop read-only delegation](2026-10-06-desktop-read-only-delegation.md) remains the shipped default. Explicit Integration nodes, conflict attention, child-result review, orphan recovery, and desktop writer-tool composition remain unfinished [mission-control requirements](../../proposed/feature/2026-08-14-desktop-agent-mission-control.md); this does not complete parallel collaboration or the desktop MVP.

## Verification

Real Git and Agent-loop tests write files before and after cold resume, retain one assignment and execution-owner record, and keep source and integration checkouts unchanged. Detached-branch recovery rejects without publishing a child. Durable-data tests reject contradictory metadata and elevated or absent policies while allowing reduced authority. Continuation tests pin missing validators, provider removal, cancellation during validation, and descriptor disagreement before publication. Decoder tests reject malformed and duplicate durable execution-owner records.

The keyless real-Loader writer transcript exercises one-shot concurrency, continuable writes, permission retention, and branch-identity refusal with actual filesystem tools. Both SDK subprocess tests preserve the same execution-owner fixture in child notifications without adding it to root events. Real-model execution remains unverified without an API key; cross-process mailbox and lease recovery are not provided.
