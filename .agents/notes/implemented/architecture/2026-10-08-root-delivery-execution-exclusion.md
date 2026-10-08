# Agent Note: Root delivery execution exclusion

Status: implemented

English | [中文](2026-10-08-root-delivery-execution-exclusion.zh.md)

## Problem

[Root delivery](../feature/2026-09-13-task-review-delivery.md) checks Task readiness before asynchronous Git operations. That observation cannot prevent a root Agent from starting afterward. The Provider's repository queue orders Git mutations, not filesystem tools or Agent execution, so a ready snapshot alone cannot authorize concurrent delivery safely.

## Decision

The Host and SDK claim root execution before invoking Commit, Apply, or Discard and retain ownership until the Provider and receipt recorder settle. An attached Agent uses the existing synchronous idle claim in `Agent.runMaintenance`; an Agent-free root uses an [offline Session reservation](2026-10-08-offline-session-reservations.md). Host contention at this claim returns `task-active` before Git begins; lifecycle or sequence validation can reject earlier. Different roots retain independent execution ownership.

Resident operations combine the request and Agent cancellation signals. Cancellation reaches the Provider but never races its promise to release execution early. Successful Provider results still reach the receipt recorder; fulfillment, Provider failure, and recording failure all release ownership afterward. No additional Agent status or Session event represents this process-local claim.

## Alternatives considered

**Check status again after Git.** Rejected because competing execution can already have changed files before detection.

**Resume every cold root into maintenance.** Rejected because delivery does not need model execution or Agent composition. Offline reservation prevents publication without activating the Session.

**Keep only the repository mutation queue.** Rejected because ordinary Agent filesystem and shell writes do not use it.

## Consequences

Supported root execution cannot overlap these delivery operations. Maintenance still accepts queued input. The [delivery journal](2026-10-08-root-delivery-journal.md) independently checkpoints exact authorization, blocks Task metadata during delivery, and correlates completion across unrelated Session appends. Interrupted delivery retains uncertainty instead of replaying Git. Execution exclusion and journaling do not establish atomic Git and Session persistence, manual crash reconciliation, child integration controls, cross-process locking, or full release readiness.

The root-delivery, offline-reservation, [manual-maintenance](../feature/2026-07-30-queued-manual-compaction.md), [batch-integration](../feature/2026-10-07-batch-writer-integration.md), and [integration-history](../feature/2026-10-08-task-integration-history.md) notes remain active: this decision strengthens root execution ownership without replacing their independent authority, publication, replay, or input-ordering rationale.

## Verification

Host regressions hold Provider and receipt results independently, reject competing activation or maintenance, propagate both cancellation owners, and verify release after every outcome. The Loader snapshot starts with a genuinely cold Session, exercises all three real Git mutations, repeats them with a resident Agent, and verifies applied source bytes, preserved source HEAD, retained commit branches, recorded receipts, and subsequent activation.
