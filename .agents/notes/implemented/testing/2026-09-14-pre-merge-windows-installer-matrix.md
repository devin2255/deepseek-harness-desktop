# Agent Note: Pre-merge Windows installer matrix

Status: implemented

English | [中文](2026-09-14-pre-merge-windows-installer-matrix.zh.md)

## Problem

Pull requests previously exercised only one silent default-destination installation with every optional integration disabled. The complete lifecycle matrix ran after a push to `master` or a release tag, so custom destinations, enabled shortcuts, login startup, repair, upgrade, both uninstall data choices, and unsafe-redirection rejection could fail only after merge. A developer machine with an existing production installation also cannot safely substitute for a clean runner.

## Decision

The dedicated hosted Windows workflow runs the complete installer end-to-end suite on pull requests as well as `master` and `dsh-v*` pushes. The suite remains separate from the general CI verdict because it mutates per-user Windows installation state and retains a validated release artifact even when a later lifecycle assertion fails.

## Verification

The workflow contract test requires one unconditional matrix step after workspace build, installer packaging, and final-package validation. Native PowerShell argument coverage proves the matrix command reaches Vitest unchanged. The hosted suite owns clean installation, custom installation, all integration options, launch, repair, running-process upgrade, preserve/delete uninstall behavior, redirect safety, and fixture cleanup.

## Alternatives considered

**Keep a single pull-request smoke and rely on post-merge validation.** This makes merging the event that first discovers failures in most public installer requirements.

**Run the full matrix on a developer workstation.** Existing product state can collide with the fixed application identity, and deleting that state to make room for a test is unsafe.

**Add a second full-matrix job while retaining the smoke job.** The first matrix case already performs the same clean-install smoke, so a second build and installation duplicate time without adding evidence.

## Consequences

- Every pull request pays the complete Windows lifecycle-test cost before merge.
- Installer requirements are validated on a disposable clean user profile without touching a developer's installed application.
- Package-validated artifacts remain downloadable for diagnosis even if the lifecycle matrix fails.
