# Agent Note: Deterministic script startup after production deploy

Status: implemented

English | [中文](2026-09-14-deterministic-script-startup-after-production-deploy.zh.md)

## Problem

The desktop packaging flow uses `pnpm deploy --prod --legacy` to stage a production-only runtime. pnpm 11 records that dependency mode in workspace state. With the default `verifyDepsBeforeRun: install`, a later `pnpm run` or `pnpm exec` can respond by running an implicit production install in the repository root. That rewrite removes development dependencies before installer validation or end-to-end tests start, and the root postinstall then fails because its development-only tools are unavailable.

This behavior makes command startup depend on whichever deploy operation ran previously. It also lets a read-only validation command mutate the shared developer or CI dependency tree.

## Decision

The workspace sets `verifyDepsBeforeRun: false`. Repository scripts never trigger an implicit dependency installation or rewrite; dependency installation is an explicit operation owned by the developer or CI setup step. CI continues to use an immutable install before building.

Desktop package validation and installer end-to-end workflow steps invoke their checked-in Node entry points directly after packaging. This keeps release verification independent of pnpm's recorded deploy mode even if a future pnpm setting changes.

## Verification

The desktop installer workflow test asserts the workspace setting and the direct Node commands used after packaging. Running `pnpm run desktop:stage` followed by `pnpm run desktop:validate-package` proves that production staging no longer removes development dependencies before validation. The hosted Windows installer workflow then builds, validates, installs, starts, and uninstalls the release artifact in an isolated user destination.

## Alternatives considered

**Restore development dependencies after every production deploy.** This adds a second workspace mutation, increases release time, and can hide an undeclared dependency on repository state.

**Use direct Node commands only in CI.** This protects the workflow but leaves documented developer commands vulnerable to the same implicit rewrite.

**Suppress the postinstall failure.** This permits the dependency deletion and only hides its first visible symptom.

## Consequences

- Script startup is deterministic and does not modify installed dependencies.
- A missing or stale dependency fails at the command that needs it; the operator must run an explicit `pnpm install`.
- Production staging can be followed by validation or tests in the same checkout without restoring development dependencies.
- Release workflow commands remain usable even when pnpm's deploy-state interpretation changes.
