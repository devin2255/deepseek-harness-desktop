# Agent Note: Application-owned task worktrees

Status: implemented

English | [中文](2026-09-09-application-owned-task-worktrees.zh.md)

## Problem

The desktop task overview could supervise several root Sessions, but creating those Sessions in the selected project directory gave concurrent Agents the same writable checkout. Task identity also retained only the source Workspace. It could not prove which branch and directory an Agent used after a Renderer reload or cold Host replay.

## Decision

This implements the root-task isolation slice of the broader [desktop mission-control proposal](../../proposed/feature/2026-08-14-desktop-agent-mission-control.md). Root tasks created from the desktop overview request `session.create` with `isolation: worktree`. The selected Workspace remains the source project identity. The Host asks the `taskWorktrees` capability for an application-owned execution directory before it creates the Session, starts the Session at that directory, and appends the complete assignment through `ctx.tasks`. A worktree Session is not attached to the source Workspace's cwd-based Session account.

`dsh-task-worktree` is the Service Definition. Its assignment records the Task and Workspace ids, canonical source and execution paths, deterministic branch, base commit, source `HEAD`, source-dirty flag and digest, and creation time. `dsh-task-worktree-local` is the shipped local Git Provider. `dsh-host-apiproxy` is the Consumer, while the Task Session Provider owns durable `task/worktree-assigned` replay and projection. The TypeScript SDK, Python SDK, client runtime, Task overview, Workspace picker, conversation header, and fixture transport project the same fields without rewriting paths.

The local Provider canonicalizes the selected directory and accepts only a Git repository root with a committed `HEAD`. It rejects repositories nested inside another checkout, submodule workspaces, insufficient free space, occupied managed paths, and occupied managed branches before starting an Agent. Creation is serialized per source repository. The managed repository key and task key are SHA-256 prefixes, producing `$DSH_HOME/worktrees/v1/<repository-key>/<task-key>` and `dsh/task-<task-key>` without embedding user paths or Session text.

The source status is read with untracked files included before creation. The new worktree starts from the committed source `HEAD`; uncommitted and untracked source changes are not copied, changed, or deleted. The assignment records whether such changes existed and their digest. Git creation failures preserve any partial directory or branch and return its recovery context. There is no automatic cleanup after a partial failure.

An idempotent Host retry first reads the durable Task row, verifies matching Task and Workspace ownership, then asks the Provider to inspect the recorded assignment. Reuse succeeds only when Git's live worktree registry still names the exact canonical path, branch, and base commit. A missing or diverged worktree fails closed. A later Session or assignment-recording failure retains the created worktree and reports its path.

The desktop never silently falls back to direct writes. An isolation failure keeps the user on the Task screen and offers Retry isolation or Use project directly. The direct choice carries an explicit warning that the Agent may modify the selected project directory. Non-Git directories remain usable only through that explicit choice.

## Alternatives considered

**Reuse the source checkout with advisory path ownership.** Rejected because two processes still observe and mutate one working tree; UI labels cannot provide filesystem isolation.

**Copy the project directory.** Rejected because copies lose Git worktree registration, duplicate ignored and untracked data, consume more space, and make later integration ambiguous.

**Include uncommitted source changes in every task worktree.** Rejected because it would copy potentially private or inconsistent state and make the recorded base irreproducible. The committed `HEAD` is the execution base; source dirtiness remains explicit metadata.

**Fall back to direct mode when Git fails.** Rejected because a task presented as isolated could write the user's checkout. Direct mode requires a separate user action after the failure is visible.

**Delete partial worktrees automatically.** Rejected because a failure after Git creates a branch or directory can leave useful recovery state, and destructive cleanup needs its own verified ownership lifecycle.

## Consequences

Two root tasks created from one repository receive distinct branches and paths from the same committed base. Their assignments survive Renderer reload and cold Session replay. The source checkout remains unchanged by creation, including when it was already dirty. Git availability, repository layout, free space, and Harness-home write access are now explicit prerequisites for the default desktop creation path.

This slice creates and verifies root-task worktrees only. It does not create separate child-writer worktrees, merge concurrent writers, apply changes to the source checkout, commit results, archive worktrees, discard them, or clean up preserved partial failures. Those operations belong to the review and integration capability and must retain the same fail-closed ownership rules.

## Verification

Provider tests use disposable real Git repositories to cover clean and dirty sources, parallel creation, unsupported layouts, insufficient space, occupied targets, inspection divergence, and failure preservation. Host tests cover explicit isolation, idempotent reuse, missing capabilities, preflight failures, Session failures, and durable assignment recording. Task, client, TypeScript SDK, and Python SDK tests cover strict replay and field projection. The assembled browser test creates an isolated fixture Task through the production plugin roster. The real Electron acceptance creates two isolated Sessions from one disposable Git repository, checks distinct paths and branches, verifies the unchanged clean source, then reloads the Renderer and compares both durable assignments.
