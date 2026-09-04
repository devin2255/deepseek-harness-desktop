# Parallel Task Overview Design

English | [中文](2026-09-04-parallel-task-overview-design.zh.md)

Status: scope and written specification approved in conversation. This document defines acceptance requirements, not shipped behavior.

## Scope

Deliver the first independently usable slice of the [desktop product design](2026-08-14-deepseek-harness-desktop-design.md): a cross-workspace overview of existing root sessions, their activity, and pending user interactions. Existing conversations remain the execution and interaction interface. The [Mission Control proposal](../../../.agents/notes/proposed/feature/2026-08-14-desktop-agent-mission-control.md) owns the larger product direction.

The overview does not create a task database, change agent execution, start agents automatically, or claim safe concurrent writes. Application-owned worktrees, outcome verification, change review, scheduling, native notifications, and Studio remain separate stages.

## User flow

The desktop starts on the overview. A persistent Tasks entry returns to it from any conversation without cancelling work. The sidebar and workspace navigation remain available; opening a session replaces the center overview with the existing conversation. Returning to the overview preserves the current session selection and draft rather than manufacturing a blank session.

New Task uses the existing workspace-aware new-session action. With no workspace, the existing add-workspace and model-setup flow remains available. Selecting a workspace explicitly takes precedence over the existing current/recent-workspace fallback. This stage neither sends a prompt nor changes permissions on the user's behalf.

The overview groups root sessions into Needs You, Running, and Other Tasks, in that order. Each row displays its workspace, title, primary state, and known running-subagent count. Within a group, rows sort by descending existing update time and then session id; no invented waiting duration or completion time appears. Empty groups show a concise empty state. Workspace membership comes from the workspace registry, not path-string equality; unassigned sessions have an explicit label.

## State rules

| Condition | Group | Meaning |
|---|---|---|
| A root or known descendant awaits approval, plan review, or an answer | Needs You | One or more user interactions are pending; other descendants may still run |
| No pending interaction and the root or a known descendant is running | Running | Execution remains active somewhere in this session tree |
| Neither condition applies | Other Tasks | No activity or pending interaction is currently reported; this is not a success claim |
| Connection is lost or list refresh fails | Preserve last rows with a stale-data warning | Activity cannot be treated as current until synchronization succeeds |

Subagent-origin rows are nested activity, not independent root tasks. Ordinary forks remain independent rows and terminate descendant aggregation. Archived roots and unused blank sessions are excluded. A new-session draft remains accessible through the existing conversation flow, not as a running task.

The existing `completed` field is a local unread reminder and must not determine successful completion, review readiness, or group placement. Unknown outcomes stay unknown. Counts describe known descendants only; a missing or failed child catalog never implies that no children exist.

## Interaction routing

A task row opens its root conversation through the existing session service. Each pending interaction offers a separate entry identifying its owning root or descendant and interaction kind. Multiple pending descendants must remain discoverable; the task badge may show an aggregate count but cannot hide all but one target.

Root interactions use ordinary session navigation. Child interactions require the existing authoritative direct-parent address and subagent navigation path. Missing catalog metadata triggers resolution through the catalog service; an unavailable target produces a visible error and leaves the overview usable. Titles and inferred parent links are never continuation authority.

After navigation, the existing approval, plan-review, or question component presents the actual pending request. If it settled meanwhile, the destination shows current state rather than recreating the request. The overview submits no approval itself and offers no batch approval, global stop, or restart action.

## Architecture

Implement presentation as a client plugin composed into the desktop profile, using layout-owned navigation and an additive center-page slot. Keep the conversation slot and its child registrations intact. Electron Main and preload receive no task state or new generic APIs. The ordinary Web composition remains unchanged unless it explicitly installs the overview plugin.

Derive rows through a pure selector from the runtime session-list mirror, workspace registry, archive membership, and known descendant summaries. Keep selected page and view preferences as presentation state only. Do not enumerate session logs, create every session scope, or poll every conversation to render the list.

Use the connection service for transport health and expose the session manager's existing list-refresh error state through the runtime's typed read interface where needed. The monotonic `pending`/`ready` arrival phase alone is insufficient to establish freshness. Reconnection clears the stale warning only after a fresh list baseline succeeds; failed refreshes preserve the warning and offer a retry through existing refresh ownership.

All subscriptions and registrations follow Cordis lifecycle ownership. Session switching, closing the overview, and removing the plugin release presentation subscriptions without interrupting running agents. This stage adds no model-visible content or durable session-event format.

## Presentation and safety

Reuse the existing theme tokens, language settings, and keyboard focus conventions. State always has text, not color alone. At the supported minimum desktop width, task titles may truncate with an accessible full label; primary actions and status remain reachable without horizontal page scrolling. The overview is a working list, not a graph editor or draggable dashboard.

Show a visible notice that tasks execute in their selected directories and automatic worktree isolation is not available. New Task preserves the existing workspace and permission behavior; the overview neither enables concurrent file writes by default nor claims to prevent collisions already possible in ordinary sessions. Acceptance exercises parallel tasks in separate disposable directories.

## Acceptance

1. Two root sessions in separate workspaces run concurrently and appear together; switching to either conversation and back does not interrupt either run.
2. A stopped root with a running descendant remains in Running. A waiting descendant moves its root to Needs You while preserving the active-descendant count.
3. Approval, plan-review, and question entries open the correct existing interaction interface, including descendant-owned requests and requests settled during navigation.
4. Ordinary forks are counted separately; archived roots, unused blank sessions, and subagent-only rows are not duplicated as tasks.
5. A stopped session and an unread completion reminder never produce a success or review-ready claim.
6. Initial loading, an empty synchronized list, initial failure, disconnection, failed refresh, and successful resynchronization have distinct truthful presentation. Stale rows are not presented as live.
7. Pure-selector and component tests cover grouping and interaction targets. A keyless assembled application scenario records the visible flow and snapshot; real Electron acceptance covers overview navigation, concurrent execution, pending interaction routing, and reconnect behavior. Mock-only tests do not satisfy delivery acceptance.
8. Desktop packaging includes the plugin and its assets. Existing workspace picking, model setup, session creation, and normal Web composition retain their regression coverage.

## Delivery sequence

Implementation proceeds through runtime status exposure and selectors, overview navigation and UI, pending-interaction routing, then assembled snapshots and Electron acceptance. Each step includes its focused tests before integration. A preview without live state or assembled acceptance is an intermediate result, not completion of this specification.
