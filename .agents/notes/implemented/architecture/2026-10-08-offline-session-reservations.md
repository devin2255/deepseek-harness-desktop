# Agent Note: Offline Session reservations

Status: implemented

English | [中文](2026-10-08-offline-session-reservations.zh.md)

## Problem

[Writer review](../feature/2026-10-07-isolated-writer-result-review.md) and [batch integration](../feature/2026-10-07-batch-writer-integration.md) require stopped writers. Checking registry residency before and after an await cannot prevent an Agent from resuming during Git inspection or mutation. A repository queue orders Provider mutations but does not own Agent publication.

## Decision

`AgentRegistry.withOfflineSessions` synchronously acquires an entire deduplicated set of Agent-free Session ids and retains it until its asynchronous operation settles. A live Agent or overlapping reservation rejects the complete acquisition; unrelated identities remain available. The caller supplies cancellation to its operation. Fulfillment and failure release every captured id, independently of later changes to the caller's array.

The registry rejects reserved ids at `create` and `resume` entry and, authoritatively, at `enter`. Preparation that started earlier therefore cannot publish an Agent while offline work owns the id. The factory's existing unpublished transaction rolls back the losing scope and unannounced Session. Custom factories must also publish through `enter`; the reservation is not a substitute for their driver-ordering obligations.

The operation preserves the inherited initiating Agent and participates in the registry's existing returned-Promise drain. No second cancellation controller, readiness state, Agent status, model message, or Session event is introduced. A reserved cold Session remains cold.

The Host reserves a selected writer across ownership inspection and the complete summary or diff read, mapping contention to `REVIEW_STALE`. The opt-in writer tools reserve every selected writer before inspecting ownership and retain the batch through review, commit, or integration settlement. Exact root authority, sandbox write permission, durable direct-child identity, and current Git review validation remain independent requirements.

## Alternatives considered

**Check residency after Git returns.** Rejected because a new Agent can already have written files before the check detects it. An error afterward cannot undo an ambiguous mutation.

**Veto only from an `agent/created` listener.** Rejected because notification order is not the publication authority. `enter` prevents any creation announcement or supported driver start while reserved.

**Queue only Git operations.** Rejected because resumed Agents can write through filesystem or shell tools outside the review Provider. Repository serialization and offline Session reservation protect different owners.

**Pause every live Agent with a new lifecycle state.** Rejected for offline writers because they must have no resident handle. Idle resident maintenance already has `Agent.runMaintenance`; it does not keep a cold id from being activated.

## Consequences

An offline operation cannot be overlapped by a supported in-process Agent activation on its selected writers. It does not lock external processes, Git hooks, files, or shared-directory agents. It ends with the operation and supplies no authority for a later call. Root human delivery still requires its own maintenance, command sequencing, and durable operation recording; this decision does not complete human writer controls or cross-process execution leases.

The existing writer review and integration notes remain active because they own attribution, revision authorization, batch publication, and UI semantics. The new reservation partially strengthens their stopped-writer guarantee without superseding those decisions. [Initiator scope](2026-07-15-agent-initiator-scope.md) and [Session preparation](2026-08-05-session-preparation.md) likewise retain their independent lifecycle rationale.

## Verification

Registry tests cover atomic acquisition, duplicate and mutated selections, independent operations, live and overlapping ownership, failures, cancellation, initiator attribution, and teardown drain. Real factory tests hold a resume in unpublished setup, acquire offline ownership, and verify publication rejection, rollback, and successful retry. Real Git tool tests hold commit and merge preflight results while competing activation and review arrive. The Loader replay exercises contention through Host reads, the actual resume factory, and a model-visible tool rejection, then resumes successfully after release while retaining the integration transcript and cold projection.
