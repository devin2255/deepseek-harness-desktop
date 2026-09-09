# @deepseek-ai/dsh-task-worktree-local

English | [中文](README.zh.md)

Local Git Provider for `ctx.taskWorktrees`. It creates one root Task's integration worktree below `DSH_HOME/worktrees/v1` from the source Workspace's committed `HEAD`, using deterministic hashed directories and `dsh/task-*` branches. Uncommitted source changes are recorded as a status digest but never copied into or removed by the isolated checkout.

Preflight requires a repository-root Workspace, a committed HEAD, no superproject relationship, an unused managed path and branch, and the configured free-space reserve. Every Git invocation uses the managed subprocess service without a shell and has explicit output, deadline, and termination limits. Creation failures preserve partial directories and branches for inspection instead of force-deleting them.

`inspect` returns `available` only when Git's registered path, branch, and HEAD still match the recorded assignment. Missing or changed state is reported without repair.

## Configuration

- `dshHome` — Harness data root; omitted follows `DSH_HOME`, then `~/.dsh`.
- `minFreeBytes` — required free space before creation; defaults to 512 MiB.
- `gitCommand` — bare or absolute Git executable; defaults to `git`.
- `commandTimeoutMs` — deadline for each Git command; defaults to 30 seconds.
- `terminateGraceMs` — managed process-tree termination grace; defaults to 2 seconds.
- `maxOutputBytes` — complete per-stream output bound; defaults to 1 MiB.

## Model Experience

None. The Provider runs Host-owned Git operations and adds no model-visible text.

## Known Limitations and Deferred Work

- Git submodules and Workspaces below a repository root are rejected.
- Apply, Commit, Discard, child-writer worktrees, and orphan recovery UI belong to later review and integration capabilities.
