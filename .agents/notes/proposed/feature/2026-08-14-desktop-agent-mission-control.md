# Agent Note: Desktop agent mission control

Status: proposed

English | [中文](2026-08-14-desktop-agent-mission-control.zh.md)

## Problem

DeepSeek Harness exposes durable sessions, workspaces, subagents, workflows, terminals, approvals, settings, and a plugin-composed Web client, but its browser application presents one current session at a time. A developer running several agents must switch conversations and inspect their logs to discover which work is active, blocked, ready for review, or safe to integrate. A desktop wrapper around the current page would preserve that supervision problem and would not establish safe parallel filesystem ownership.

## Proposal

Add a desktop product whose primary interface is a cross-project task command center. One user task maps to one root Session in the first release; child Sessions remain subagent runs. A Task projection derives status, attention, success criteria, artifacts, review readiness, and runtime facts from the root log, descendant logs, and existing registries instead of creating a second task-history store. The product specification awaiting review and its interaction details live in the [desktop product design](../../../../docs/superpowers/specs/2026-08-14-deepseek-harness-desktop-design.md), and the visual tokens live in [DESIGN.md](../../../../DESIGN.md).

Writing tasks use application-owned Git worktrees by default. A new worktree capability owns creation, inspection, application, archival, and recoverable cleanup. It refuses unsupported repositories or unsafe transitions with an actionable result; it never silently falls back to writing the user's main checkout.

Each root task owns one integration worktree. Read-only child agents may share its snapshot, and one writer may edit it directly. A workflow that needs concurrent writers gives each writer a child worktree from the same base and uses an explicit integration node to merge the results into the task worktree before review. Declared path scopes detect likely overlap but never replace Git merge and verification.

The desktop shell uses Electron because the shipped Host, PTY stack, plugin runtime, and client build already run on Node and Chromium-compatible Web APIs. Electron Main supervises a Node `utilityProcess` running a desktop profile and a sandboxed Renderer running the existing plugin-composed React client. The preload bridge exposes only validated desktop bootstrap and window operations. The Renderer has no Node integration.

The Harness process listens on a random loopback port and requires a per-launch capability for every HTTP and WebSocket connection in addition to Origin checks. The capability is supplied through the narrow desktop bootstrap API and never enters URLs, logs, settings, or Session events. Electron business behavior remains in Cordis plugins; Main owns only window lifecycle, process supervision, notifications, deep links, and updates.

Closing the last window while work is active keeps Main and the Harness process in the system tray or macOS menu bar. Explicit quit reports the active task count and requires the user to keep running, stop and quit, or cancel. After an abnormal exit, recovery reports interrupted, failed, or settled state from recorded facts and does not replay an unconfirmed tool call.

## Product structure

The default task overview groups work by human attention, active execution, and recent completion rather than by conversation recency. A task workspace renders the agent dependency graph, plan, terminals, files, preview, conversation, artifacts, and a right-hand inspector. Review is a distinct mode that combines success criteria, Diff, verification evidence, unresolved risks, and worktree actions. Harness Studio progressively reveals the selected task's preset, plugin graph, model route, tools, permissions, workflows, and event stream.

The first release supports local Windows x64 and macOS arm64 execution. Cloud execution, mobile handoff, SSH hosts, computer use, marketplace distribution, team sharing, and automatic Pull Request creation remain outside the first release.

## Alternatives considered

**Fork Code OSS and build an AI IDE.** This would provide an editor and extension ecosystem but would make parallel supervision subordinate to editor navigation, inherit a large unrelated platform, and obscure the Harness runtime. The product instead opens a task's worktree in the user's existing editor.

**Ship a thin browser wrapper.** This reuses the current UI but adds no durable task projection, worktree ownership, process recovery, native notifications, or secure desktop lifecycle. It does not solve the product problem.

**Use Tauri with a bundled Node sidecar.** Harness still requires Node for its plugins, PTY, and runtime, so Tauri would add a Rust shell and a second IPC architecture without removing the Node process. Electron's utility process reuses the current runtime and build language.

**Expose Electron and Node APIs directly to the Renderer.** This would make feature development fast but would collapse the security boundary between model-rendered content and local machine authority. A sandboxed Renderer and a narrow typed bridge keep filesystem, process, and update authority out of presentation code.

**Create an independent task database.** A second durable record would diverge from the Session event log that already owns replay, resume, forks, and model-visible history. The task model remains a projection and adds Session events only for genuinely new persistent facts.

## Acceptance criteria

- One window displays tasks across workspaces and identifies running, waiting, failed, review-ready, and completed work without opening each conversation.
- A user can start at least two isolated write tasks in one repository without either task or the user's main checkout observing the other's uncommitted changes.
- Every completion view includes success-criteria status, changed files, verification evidence, unresolved risks, and an explicit apply, commit, archive, or discard action.
- Restarting the Renderer or desktop window preserves Harness work; restarting after a Host failure reports the exact recovered or interrupted state and does not repeat a committed tool action.
- Renderer code has no Node integration or generic Electron IPC; unauthorized loopback HTTP and WebSocket clients cannot use the desktop Host.
- The assembled task creation, approval, subagent completion, review, worktree application, and failure-recovery paths have keyless snapshots and desktop end-to-end coverage.

## Risks

- A task projection can become an implicit second source of truth unless replay and live folding are identical and new durable facts stay in Session events.
- Electron increases binary size and makes Chromium security updates, signing, and application updates release requirements.
- Default concurrency can increase model cost and local resource use; global and project concurrency budgets must be visible and enforced.
- Harness Studio can overwhelm users if runtime structure appears before a concrete task requires it.
- Git worktrees do not cover non-Git folders, unusual submodule layouts, insufficient disk space, or every dirty-checkout transition; direct-workspace mode needs explicit risk and recovery behavior.
