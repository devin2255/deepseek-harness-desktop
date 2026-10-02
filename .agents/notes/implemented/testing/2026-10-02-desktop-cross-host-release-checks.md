# Agent Note: Desktop Cross-Host Release Checks

Status: implemented

English | [中文](2026-10-02-desktop-cross-host-release-checks.zh.md)

## Problem

The desktop release tests cover Windows installer behavior, while repository-wide coverage runs on Linux and Windows. Host-dependent path parsing, gzip headers, and subprocess availability can make the same source pass on one host and fail on another. A passing narrow host check does not qualify a distributable installer.

## Decision

The generated installer PowerShell include normalizes the gzip OS header byte, so its checked-in content is reproducible across build hosts. Desktop asset guards remove a directory URL's trailing separator lexically before `lstat`, preserving the symlink check on POSIX hosts. Authenticode module and executable paths use Windows path composition regardless of the test host. Windows PowerShell subprocess tests run only on Windows; the portable configuration and generated-content assertions remain in the Linux coverage run. Windows trust inspection and installer probes have bounded timeouts that include cold hosted-runner startup.

Windows uninstall cleanup validates an extended-length drive root through its equivalent ordinary root before walking the namespaced descendants; it still checks the supplied package root and every component without following a linked directory. Task-worktree fixtures compare canonical paths because Windows temporary directories may be returned under a short-name spelling. Distinct package invariants, UI fallback hooks, packaging entry points, and security-sensitive traversals remain separate even where their small scaffolding is identical; local duplication exclusions do not change the repository-wide detector threshold.

## Alternatives considered

**Skip the entire installer spec on Linux.** This would discard portable assertions for installer configuration and generated commands, so only subprocess-dependent cases are Windows-only.

**Resolve asset roots or fallback roots through `realpath` before metadata checks.** That would follow a linked directory before the guard can reject it. Lexical normalization and component checks retain the no-follow rule.

**Raise global test or duplication thresholds.** This would hide unrelated regressions. The implementation changes only affected timeouts and marks deliberate identical scaffolding locally.

## Consequences

Linux and Windows validate the same portable desktop release configuration, while hosted Windows remains responsible for actual PowerShell and installer lifecycle behavior. Generated PowerShell definitions no longer depend on the compressor's host OS byte. A green repository check remains necessary but insufficient for release: assisted installation, repair, upgrade, uninstall, signing, and consumer-machine acceptance still require their own evidence.

## Verification

The desktop built-asset, generated-installer, checksum, uninstall-cleanup, and Task-worktree tests cover the host-specific cases. The `pwsh-tool-turn` and translation-prompt keyless snapshots pin model-visible text affected by this branch. `pnpm run duplication`, `pnpm run doc-sync`, and the Windows installer workflow retain their separate checks.
