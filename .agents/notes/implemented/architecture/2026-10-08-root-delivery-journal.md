# Agent Note: Durable root delivery authorization

Status: implemented

English | [中文](2026-10-08-root-delivery-journal.zh.md)

## Problem

[Root execution exclusion](2026-10-08-root-delivery-execution-exclusion.md) prevents supported root execution during human Git delivery, but queued input can still append Session events. Comparing the completion against the original Session sequence can reject a valid receipt after Git succeeds. A process loss between mutation and receipt also needs durable evidence that delivery may have changed Git.

## Decision

The Host and SDK retain root maintenance or offline ownership through authorization, Git, and receipt settlement. The local Review Provider awaits a caller-owned authorization inside its repository queue, after preflight and before changing a user index, worktree, or branch. The caller records and checkpoints `task/delivery-started` with one operation id, exact review revision, operation kind, and mutation-specific inputs. Failed preflight does not create an intent; failed authorization prevents those user-repository changes.

Commit authorization includes the reviewed HEAD and exact target Git tree prepared through a private temporary index. That index and its lock are removed on success and failure; preparation can retain unreachable objects but does not change the real index or publish a commit. The Provider rechecks the review before and after authorization, compares real staging with the authorized tree, and checks the resulting commit's parent and tree before returning a receipt. A hook or filter mismatch remains unconfirmed rather than claiming that a different tree was authorized. This inspection does not establish a cross-process lock.

The Task service compares `expectedSeq` at authorization, not completion. A complete Provider receipt must match the outstanding operation id, kind, and revision; Apply also matches the authorized commit and source HEAD. Discard authorization includes the Provider's current worktree HEAD and actual uncommitted-change flag, and requires explicit confirmation when that flag is true. Its receipt reports the same loss flag and a recovery commit equal to that HEAD, absent only when HEAD equals the assignment base. The original Commit receipt remains an independent historical fact. Unrelated Session events may intervene. Task metadata changes and overlapping authorization remain blocked. A receipt without a preceding intent, or an incomplete pre-release intent, is rejected.

Discard rechecks the current review and uncommitted-change flag after authorization settles. Changed contents, HEAD, or loss facts reject before directory removal while retaining the intent as unconfirmed. This recheck narrows the checkpoint interval without claiming a cross-process filesystem lock.

An outstanding intent produces stable root-owned `delivery-unconfirmed` attention. Provider or checkpoint failure after authorization does not imply that Git stayed unchanged. Cold replay retains the intent without repeating Git or activating an Agent. A global `agent/pre-step` listener rejects root execution while this attention remains; ordinary Tasks delegate through `next()`. Review displays the operation id and disables execution-related Task actions while permitting read-only refresh and inspection.

A live receipt append publishes synchronously before persistence finishes. The Provider therefore retains the delivery's checkpoint owner independently until `sessions.flush` succeeds. The projection remains unconfirmed during that interval and after checkpoint rejection, including live-generation replacement. A fresh process derives its state from the persisted log. This process-local checkpoint fact records durability uncertainty, not a second persistent Task history.

The checkpoint becomes retryable only after the exact receipt append returns and while the original Session instance remains attached. `retryableDeliveryCheckpoint` advertises that operation id; the serialized retry only flushes the same Session, appending no event and executing no Git. Ownership is checked again after the flush. Replacement or detachment removes retry eligibility without clearing uncertainty, and a failed save remains retryable while ownership survives. Review and both SDKs expose this operation without requiring a readable worktree, so Discard's removed directory does not prevent saving its receipt.

## Alternatives considered

**Keep completion compare-and-set against the initial sequence.** Rejected because a non-waking injection legitimately advances the log without changing the authorized Git operation. Operation correlation preserves authorization without treating the whole interval as an exclusive event container.

**Match Discard to the original Commit receipt.** Rejected because a valid committed Task may have later edits or descendant commits. Comparing after directory removal can reject a successful authorized cleanup, and the removed files cannot reconstruct its loss facts. Pre-mutation HEAD and loss facts preserve strict correlation against the current human review.

**Record only the successful receipt.** Rejected because a crash after Git mutation leaves no evidence distinguishing an untouched operation from a lost result.

**Recover Commit from the review digest alone.** Rejected because that digest describes working-tree paths, modes, and bytes, not the resulting Git tree identity. Committed renames and Git filters can change that representation. Persisting the exact parent and prepared Git tree permits direct comparison with a candidate commit without reconstructing deleted files or inventing an execution timestamp.

**Clear the intent on every error or retry automatically.** Rejected because cancellation and lost output do not prove that Git did not change. Repeating a commit, Apply, or destructive Discard is not a safe recovery default.

**Hold the Task Provider queue throughout Git.** Rejected because repository mutation and root execution have their own owners. The Task queue serializes only validation, append, and checkpoint work; a slow Git operation does not reserve unrelated Task metadata.

## Consequences

Human delivery has durable authorization and correlated completion, but Git and Session persistence are not one atomic transaction. Unconfirmed operations without an exact live receipt require [inspection of current Task and source Git state](../feature/2026-10-09-root-delivery-inspection.md). Manual adoption and explicit no-mutation settlement are not supplied here; read-only Refresh cannot clear uncertainty. External processes and child execution are not locked by this journal. It does not complete human writer controls, conflict resolution, or signed release acceptance.

The execution-exclusion, [offline-reservation](2026-10-08-offline-session-reservations.md), [root-review](../feature/2026-09-13-task-review-delivery.md), [queued-maintenance](../feature/2026-07-30-queued-manual-compaction.md), [committed-worktree reuse](../bug-fix/2026-10-06-committed-task-worktree-reuse.md), and [integration-history](../feature/2026-10-08-task-integration-history.md) notes remain active. This decision partially strengthens delivery sequencing and recovery; it does not replace their independent execution, input-ordering, Git identity, or tool-result rationale.

## Verification

Strict fold tests reject malformed intents, skipped authorization, overlapping mutations, mismatched identities, wrong source HEAD, and unconfirmed data loss. Provider tests hold and reject authorization around real Git mutations. Runtime tests retain attention during held or failed live checkpoints, reject root steps, delegate ordinary steps, and restore cold uncertainty. Host and SDK tests distinguish preflight rejection from post-authorization result or checkpoint failures. The real Loader transcript exercises Commit, Apply, and Discard with cold and resident roots, intervening injection, and durable intent inspection; a lost real commit result remains unconfirmed after a complete Host restart without a repeated commit or model request.

Both SDK expected-output scenarios connect real clients to the Loader-composed Task services and real SDK transport. They verify intent notifications, receipt correlation, source bytes and HEAD, retained branches, and worktree removal, then lose a real Git commit response and verify cold attention, absent receipt, and rejected repetition. The required Python runtime job runs its built-Node companion explicitly; this is not single-executable or live-model acceptance.

Commit regressions compare the authorized parent and tree with real Git commits, including renamed and binary files, while asserting that authorization has not changed the real index. Changes during private preparation or authorization reject before real staging; staged-tree, hook-result, and malformed-tree cases reject without a success receipt and remove the private index. Loader replay retains the exact target after a lost commit result and full Host restart; both SDK transcripts pin the notified target against completed and lost Git commits.

Both SDK scenarios also fail a real commit receipt checkpoint, save the exact live receipt, and restore it after a complete runtime restart without changing the Session sequence or Git commit. Missing-receipt retries reject both live and cold. Provider tests cover Commit, Apply, and Discard checkpoint retries, repeated persistence failure, mismatched ids, and Session ownership loss; UI tests retain the save action when the review directory is unreadable and disable it when disconnected.

The Loader and both SDK scenarios make further worktree edits after Commit and Apply, authorize the fresh review, and verify Discard's loss facts and retained current branch HEAD before and after cold replay. The resident Loader and SDK cases also advance the worktree HEAD independently of the original Commit receipt. Provider tests preserve the directory when file contents or staging-only loss facts change during authorization; strict fold tests reject malformed preflight facts, unconfirmed loss, and mismatched recovery receipts.

The HTTP carrier tests pass an exact checkpoint operation id through the Client and strict route parser, preserve the pending projection and saved receipt, and retain the unchanged event sequence. Missing or malformed operation ids, blank Session ids, and unknown request fields are rejected before the Task implementation runs.

The Chromium scenario boots the real Web bundles with the desktop Task overlay, performs real Commit and Discard operations, and fails each first receipt save. It retries through the Host wire without adding events or changing Git identities, reloads the renderer after directory removal, and reopens the root Review through its unconfirmed-delivery attention. Browser snapshots pin the pending and confirmed states; the source bytes and HEAD remain unchanged.
