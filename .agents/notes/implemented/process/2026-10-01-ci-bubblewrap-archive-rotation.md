# Agent Note: Install CI Bubblewrap from the distribution repository

Status: implemented

English | [中文](2026-10-01-ci-bubblewrap-archive-rotation.zh.md)

## Problem

The Linux CI setup script downloaded one pinned Ubuntu 24.04 Bubblewrap `.deb` directly from the archive pool. On 2026-10-01 the pinned `0.9.0-1ubuntu0.1` URL returned HTTP 404 after Ubuntu published later package revisions. Both coverage and artifact-consumer jobs failed during sandbox preparation before running their gates. The Ubuntu [archive index](https://archive.ubuntu.com/ubuntu/pool/main/b/bubblewrap/) confirms that the old file is absent and newer revisions are present.

## Decision

On Linux x64, use an existing `bwrap` when available; otherwise update the distribution package indexes and install `bubblewrap` through apt with no recommended packages. Keep the AppArmor configuration attempt and the actual confinement probe. The package transaction remains concurrent with the immutable pnpm install in the CI workflow. Package version and authenticity now follow the runner's configured Ubuntu repositories rather than an archive-pool filename and manually pinned hash.

## Alternatives considered

Pin the newest `.deb` and SHA-256. Rejected because a later security revision could remove that file and recreate the same CI outage. Vendor the executable. Rejected because the runner already has a maintained Ubuntu package source, and vendoring would require owning updates and platform linkage.

## Consequences

First-use setup may take longer than extracting a small `.deb`, but no CI job depends on a particular archive-pool revision remaining available. The static workflow test pins the apt path and functional probe; the Linux CI jobs provide the actual execution check. If apt or the probe fails, setup still fails before tests rather than silently disabling sandboxing.
