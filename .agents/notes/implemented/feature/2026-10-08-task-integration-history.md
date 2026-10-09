# Agent Note: Task integration history and conflict attention

Status: implemented

English | [中文](2026-10-08-task-integration-history.zh.md)

## Problem

[Batch writer integration](2026-10-07-batch-writer-integration.md) retains exact results in ordinary tool logs, but an operator inspecting a Task needs to distinguish publication, preflight conflict, tool failure, and an unconfirmed attempt. Root inactivity cannot prove publication. A successful unrelated batch must not conceal unresolved contributors, and cold inspection must not activate Agents or repeat a Git mutation.

## Decision

The Session-backed Task Provider reconstructs optional ordered integration nodes from root `integrate_agents` calls. Native calls pair by call id, turn, and step; Code Mode sub-dispatches pair by subcall, parent, root, and serialized arguments. Node ids derive from the root and call-event sequence. No additional Session event or Task database duplicates an existing tool result.

Only complete JSON receipts matching the recorded root assignment, requested revision, ordered writer commits and revisions, and direct-child ownership confirm an integrated or conflicting outcome. Malformed, spilled, mismatched, or duplicate results remain unconfirmed. Tool errors retain their diagnostic. A pending attempt is running only while the root has current live activity and its recorded execution interval remains open; loss of ownership or interval closure never implies success.

A verified preflight conflict produces root-owned merge attention. Its historical outcome remains unchanged. Later successful batches cover the selected writer identities, allowing revised commits and separate batches; only complete coverage clears the attention and records the last covering node as `resolvedBy`. Partial or unrelated successes do not resolve it. This records later integration, not the current contents of Git or proof of an automatic conflict repair.

The TypeScript SDK validates coverage with a reverse scan retaining each writer's nearest later publication; the latest selected publication completes the conflict. Repeated publication cannot replace the first complete covering result. Conflict attention uses the paired tool result's logged completion time, which every confirmed outcome carries.

Task wire validation and both SDKs preserve all five outcomes, root ownership, ordered call identities, contributor selection, and complete later coverage. The Provider's executed invariant checks those relationships on published snapshots. Review displays history independently of file-list emptiness, provides read-only contributor selection, and distinguishes root integration from source delivery. Unresolved conflicts disable Commit and Apply while permitting Request Changes. Conflict attention opens root Review; opening it does not clear the conflict.

## Alternatives considered

**Add a separate integration journal or presentation event.** Rejected because the existing native and Code Mode logs already own the attempt and result. A second persistent record can diverge after failure or cold replay.

**Treat idle state, a missing error, or truncated text as success.** Rejected because publication can be ambiguous after process loss. Unconfirmed results require current Git inspection before retry.

**Clear every conflict after the next success.** Rejected because that success can involve unrelated writers or only part of the failed batch. Writer-identity coverage permits corrected commits without concealing unfinished participants.

## Consequences

Integration outcomes and conflict attention survive a complete Host restart without Agent activation or Git mutation. The preparation, continuation, [read-only child review](2026-10-07-isolated-writer-result-review.md), batch-publication, and [root-delivery](2026-09-13-task-review-delivery.md) notes remain active because they retain independent ownership and failure rationale. The broader [desktop proposal](../../proposed/feature/2026-08-14-desktop-agent-mission-control.md) remains incomplete: default writers, human child commit and integration controls, conflict-resolution actions, execution leases, orphan recovery, and full desktop writer acceptance are not supplied by history projection.

## Verification

Projection tests pin native and Code Mode correlation, malformed and ambiguous results, lifecycle closure, partial coverage, unrelated success, and revised commits. Shared wire fixtures exercise Host validation and both SDKs against the same valid outcomes and invalid relationships. Component and assembled Web checks cover visible history and root delivery; the real Loader scenario drives four Git writers through conflict and successful batches, then disposes the complete Host and verifies identical cold nodes and retained conflict attention without Agent activation. Its bounded process deadline includes two Host boots. These checks do not establish live-model execution, human integration controls, or signed release acceptance.

Electron acceptance commits a stopped writer and integrates its result through the ordinary model-facing tools. The real Review workspace displays the integration receipt, refreshes the root diff, and opens read-only contributor inspection. Git assertions verify the root contains the result while the source checkout remains unchanged, and the desktop lifecycle reaches process quiescence. This is tool-driven integration acceptance, not acceptance of human commit or integration controls.
