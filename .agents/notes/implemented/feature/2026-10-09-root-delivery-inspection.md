# Agent Note: Observing unconfirmed root delivery

Status: implemented

English | [中文](2026-10-09-root-delivery-inspection.zh.md)

## Problem

The delivery journal retains authorization after a lost Git result, but an absent receipt cannot distinguish an untouched operation from completed or partial mutation. HEAD alone cannot identify the authorized result. Ordinary status can hide physical edits through cached index data or flags. Recording a current timestamp as execution time would fabricate a historical fact.

## Decision

The Review service owns `TaskDeliveryIntent` and request-scoped delivery observations. Results distinguish `completed`, `not-completed`, and `ambiguous`, carrying the recorded intent, Task and Workspace identities, a content revision, and observation time. Completed effects contain current Git facts, not execution timestamps or receipts. Not-completed means the authorized effect is absent now, not proof that Git never changed. Observation time is excluded from the revision.

Commit matches the authorized parent and prepared tree against the current commit and requires clean index and files. Original HEAD and review contents indicate no completed Commit, including staging-only preparation. Apply requires the exact committed Task review and source HEAD, simulates the complete bounded patch in a private index, and compares the target with both actual source index and files. Unrelated or partial contents remain ambiguous. Discard requires the recorded path and registration to be absent, no relocated worktree using the retained branch, and the authorized branch HEAD with original-base ancestry. Loss and recovery information come from the persisted preflight, not an earlier Commit receipt.

Inspection copies the actual index into a private directory to obtain its staged tree, then creates and refreshes a fresh private index to check physical files without inherited stat data, assume-unchanged, or skip-worktree flags. Cleanup failures reject the observation. Optional Git locks are disabled for ordinary reads. Simulation can retain unreachable objects; user indexes, files, refs, and Session events are unchanged.

Inspection shares the Provider's canonical common-directory queue, discovered from the verified source root even after Task removal. Two differing classifications return ambiguity. This queue is not a cross-process lock or filesystem transaction.

The Host accepts only a root Session id and operation id. It resolves ownership and pending authorization from attached or cold durable logs, retains root execution ownership through inspection, and rechecks authorization before returning. A cold root stays cold. Missing authorization, including a live receipt awaiting persistence, rejects inspection and requires the existing checkpoint-save path. No observation clears attention or authorizes Git retry.

## Alternatives considered

**Construct a synthetic execution receipt.** Rejected because matching current Git state does not prove causality or execution time. Observation and later human confirmation are separate facts.

**Match HEAD or patch presence alone.** Rejected because unrelated commits and partially applied files can resemble the authorized result. Exact parent, tree, index, files, and ownership remain necessary.

**Trust ordinary Git status.** Rejected because cached metadata and index flags can conceal physical changes. Fresh private indexes preserve the user's index while checking files.

**Automatically retry or clear pending delivery.** Rejected because observation is not authorization, and absence now does not prove no earlier side effect occurred.

## Consequences

The Host can report current Git evidence without inventing a successful-delivery event. Durable manual settlement, SDK inspection methods, and Review confirmation controls remain incomplete. This capability does not unlock execution, grant new mutation permission, or establish signed release acceptance.

The [journal](../architecture/2026-10-08-root-delivery-journal.md), [root execution](../architecture/2026-10-08-root-delivery-execution-exclusion.md), [offline reservations](../architecture/2026-10-08-offline-session-reservations.md), [root review](2026-09-13-task-review-delivery.md), [worktree ownership](2026-09-09-application-owned-task-worktrees.md), [committed reuse](../bug-fix/2026-10-06-committed-task-worktree-reuse.md), [batch publication](2026-10-07-batch-writer-integration.md), and [integration history](2026-10-08-task-integration-history.md) notes remain active. Inspection supplements their independent authority, mutation, replay, and contributor rules rather than superseding them.

## Verification

Real Git tests distinguish complete, absent, partial, externally changed, hidden physical, and incompletely removed results while comparing user index bytes. Process and filesystem faults exercise bounded reads, invalid identities, simulation conflicts, concurrent changes, cancellation, and cleanup failures. Host carrier tests reject client-provided facts and inconsistent effects; execution tests retain ownership, cold state, and pending attention.

The real Loader transcript loses a completed Commit response, restarts the complete Host, then inspects the exact authorized parent and tree through the typed Host client. It verifies unchanged indexes and history, no execution timestamp, no cold Agent activation, and retained uncertainty; later physical edits produce ambiguity. These checks do not prove human settlement or desktop confirmation controls.
