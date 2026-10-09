# Agent Note: Portable CI runners for forks

Status: implemented

English | [中文](2026-10-01-fork-ci-runners.zh.md)

## Problem

The [CI workflow](../../../../.github/workflows/ci.yml) selected the upstream project's named enterprise Linux and Windows runners for the main pull-request jobs. This public fork has neither those larger-runner labels nor the upstream self-hosted pools, so its static, coverage, snapshot, and native Windows jobs stayed queued. The upstream [failover runbook](2026-07-26-ci-failover-runbook.md) addresses an outage of existing pools, not a fork without access to either pool.

## Decision

Only `deepseek-harness/deepseek-harness` keeps the enterprise runner defaults and its existing independent Linux and Windows failover switches. Other repositories select standard `ubuntu-24.04` for the three primary Linux jobs and verdict, and `windows-2025` for the native Windows job. Fork jobs use two concurrent gate workers, coverage workers, snapshot processes, lint threads, and publint operations where those values previously assumed a larger Linux runner; native Windows publint is likewise bounded at two. Upstream settings retain their existing values. The master-push self-hosted standby drills run only in the upstream repository, because forks cannot execute them.

The fork selector precedes the upstream failover selector. A fork's repository variables therefore cannot accidentally route its pull requests to the upstream VM labels. The existing dedicated runner benchmark jobs remain manual upstream diagnostics and are not part of the pull-request verdict.

## Alternatives considered

Provision matching enterprise and self-hosted runner pools in the fork. Rejected because the fork does not own those machines, and requiring private infrastructure for public pull-request checks would keep contributors blocked. Remove the complete native Windows job. Rejected because the Wine job covers only the blocking build subset, not the full native-kernel inventory.

## Consequences

Required fork jobs can start without provisioning private runner pools, at the cost of longer completion times on smaller machines. The `all checks passed` verdict still requires the same Linux, compatibility, Python, and Wine jobs; the native Windows result remains an independent, visible signal. The CI workflow test pins the portable labels, fork worker bounds, upstream failover references, and upstream-only standby conditions. A green run on the fork remains necessary to establish that the reduced concurrency is sufficient for the complete suites.
