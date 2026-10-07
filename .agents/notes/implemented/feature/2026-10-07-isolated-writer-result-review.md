# Agent Note: Isolated writer result review

Status: implemented

English | [中文](2026-10-07-isolated-writer-result-review.zh.md)

## Problem

[Isolated writers](2026-10-06-isolated-subagent-writer-preparation.md) keep changes outside the root checkout. A root-only Review workspace cannot inspect those results, while treating a child summary as the root would authorize delivery against the wrong identity. Cold children also need discovery independently of the ordinary Session list.

## Decision

The existing Host review reads accept an optional child Session id beside the required root id. The Host resolves the child's own execution record after its fork seed and validates origin, direct parent, assignment owner, Workspace, source worktree, and execution cwd. It rejects a discarded root, absent assignment, and any resident child before reading Git and rechecks residency after asynchronous reads. Persistence inspection never activates either Agent. The local review Provider retains exact Git identity, revision, path, and output-bound validation.

The Client review owner stores root and child identities separately. Summary and diff calls remain root-addressed, and changing either selection invalidates earlier reads. Child inspection rejects root delivery commands. A current delivery prevents selection changes; disconnect invalidates its response generation, so a late receipt cannot replace a different visible review. An acknowledged receipt remains accepted when refreshing the Task projection fails; that refresh error is displayed separately.

The Review selector observes the existing durable direct-child catalog while mounted and releases observation on departure. Refresh reloads both catalog and review. Healthy catalog rows remain discoverable without list membership; running rows are disabled, diagnostic rows are omitted, and catalog failures remain visible. Host ownership validation is authoritative, including for inactive but resident children and shared-directory children. The child view labels itself read-only, disables root actions, and hides root delivery successes. Criteria and risks continue to describe the root goal.

## Alternatives considered

**Read a client-supplied directory.** Rejected because a path does not establish root ownership. The child log and live Git registration determine execution identity.

**Reuse the child's summary id as the root request id.** Rejected because root lifecycle and delivery receipts belong to the parent Task. The selector is an additional read target, not a Task reassignment.

**Discover children only from the Session list.** Rejected because cold durable children can be absent from that list. The existing parent-addressed catalog owns discovery.

## Consequences

Human inspection shares the Provider used by [writer integration tools](2026-10-07-batch-writer-integration.md), without adding model input, Session events, filesystem authority to the Renderer, or a second result database. The preparation, continuation, batch-publication, and [root-delivery](2026-09-13-task-review-delivery.md) notes remain active because each owns a distinct decision. Desktop writers remain opt-in. Child commit and integration controls, conflict attention and resolution, execution leases, orphan recovery, and full desktop writer acceptance remain incomplete.

## Verification

Host tests reject foreign, inherited-seed-only, shared-directory, active, resumed, and discarded-root reads before Provider execution and cover live and cold inspection. Client tests cover parent-addressed reads, read and mutation generation fencing, disabled delivery, catalog discovery and lifecycle, and explicit errors. The real Loader writer scenario drives actual Git and filesystem tools, rejects an active child review, then reads a released child's summary and diff through the fetch carrier without activation.

Electron acceptance boots an opt-in isolated writer alongside the ordinary desktop composition, executes the actual filesystem tool, and selects the stopped child through the accessible Review source control. It verifies the rendered diff, retained selection after refresh, disabled root delivery actions, restored root controls after switching back, and unchanged source and root checkouts. The complete desktop lifecycle still reaches process quiescence. These checks do not establish live-model execution or child commit and integration UI acceptance.
