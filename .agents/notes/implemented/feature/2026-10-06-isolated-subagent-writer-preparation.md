# Agent Note: Isolated subagent writer preparation

Status: implemented

English | [中文](2026-10-06-isolated-subagent-writer-preparation.zh.md)

## Problem

The desktop's ordinary [read-only children](2026-10-06-desktop-read-only-delegation.md) cannot implement concurrent changes. Granting them shared-checkout write access would defeat [root-task isolation](2026-09-09-application-owned-task-worktrees.md). Writer execution needs its own directory, fixed authority, and durable identity before an Agent becomes visible.

## Decision

The spawn Provider accepts the explicit `workspaceMode: isolated-worktree` choice. Only a writable root Task whose cwd matches its recorded managed integration worktree can use it. The Provider captures root authority before awaiting preparation, requires a clean committed integration baseline, and creates a distinct worktree under the reserved child Session id. The worktree service rejects a changed captured HEAD or dirty source before creating a branch or directory. Root creation retains its independent dirty-source policy.

The shared one-shot driver captures metadata and model route before awaiting the Provider's private preparation capability. Preparation supplies cwd, `workspace-write`, approval `never`, and unpublished setup; full-access root authority is never copied. The factory owns child publication and rollback. Failure or cancellation preserves any created worktree as recovery data, not a live Agent.

The immutable, model-hidden `subagent/worktree-assigned` event records the root owner and complete child assignment. The Session header persists the child execution directory. Root and child logs share strict assignment decoding, and the Provider's invariant checks the event against the actual Session id, direct parent, origin, and cwd. This event is required on read; unsupported builds refuse it rather than interpreting the child as shared-workspace execution.

## Alternatives considered

**Make ordinary shared children writable.** Rejected because permission changes do not separate working trees. Shared delegation remains deployment-selected and the desktop keeps its read-only default.

**Let each child choose a directory through tool arguments.** Rejected because a suggested path neither changes its execution cwd nor records trustworthy ownership. The Provider creates and records the worktree before publication.

**Reuse the continuation manager without recorded execution support.** Rejected because ordinary cold continuation reconstructs children independently of the establishing Provider. [Owned-execution continuation](2026-10-07-isolated-writer-continuation.md) supplies the required recorded identity and live validation without transferring child lifecycle ownership.

## Consequences

[Batch writer integration](2026-10-07-batch-writer-integration.md) owns stopped-result review and publication. Writer preparation accepts committed root changes and prior integrations; required-clean creation checks uncommitted state rather than differences from the original Task base.

Explicitly configured one-shot writers execute in separate branches and directories without copying root changes or modifying the source checkout. The root and children retain separate logs and authority. Generic workspace-write still includes the platform's documented writable temporary areas; worktree separation is not a new kernel sandbox.

The desktop tool roster does not enable this option. [Continuable writing](2026-10-07-isolated-writer-continuation.md) shares this preparation, and [human result inspection](2026-10-07-isolated-writer-result-review.md) is read-only. Explicit Integration nodes, conflict attention, worktree cleanup, and child commit and integration UI remain unfinished parts of the [mission-control proposal](../../proposed/feature/2026-08-14-desktop-agent-mission-control.md). This execution slice is not completion of parallel collaboration or the desktop MVP.

## Verification

Real Git and Agent-loop tests hold two writers active concurrently, write different contents at the same relative filename, verify distinct execution paths and equal bases, and inspect persisted assignments after handle disposal. Source and root checkout contents remain unchanged. Direct provider tests reject a read-only root, non-root delegation, missing review capabilities, and uncommitted integration state, and verify full root authority is clamped. Driver tests verify preparation rejection, cancellation before factory entry, and route capture before preparation. Invariant tests reject contradictory or repeated assignments before append and restored publication and verify companion disposal.

A real Loader transcript replaces only model responses, exercises both writers and actual filesystem tools, and retains cold-inspection evidence. TypeScript and Python SDK subprocess tests preserve the same child-assignment fixture in tree notifications without adding it to the root event stream.
