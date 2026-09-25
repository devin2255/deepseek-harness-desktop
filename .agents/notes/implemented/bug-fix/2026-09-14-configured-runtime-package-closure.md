# Agent Note: Configured runtime package closure

Status: implemented

English | [中文](2026-09-14-configured-runtime-package-closure.zh.md)

## Problem

The Python SDK runtime manifest previously verified only statically declared npm dependencies and required peers. Cordis configuration files load plugins by package name at runtime, so a configured plugin could be absent from the deploy root even when the static dependency graph was closed. The release pipeline then spent time building a single executable before the first boot exposed the missing package.

## Decision

The runtime closure gate parses every checked-in Cordis configuration exercised by the Python runtime release smoke: the bundled default, complete JSON-RPC agent, and minimal JSON-RPC agent configurations. Every referenced workspace plugin must be a direct workspace dependency of `python/sdk-runtime/package.json`, in addition to the existing required-peer closure rule.

Custom manifest checks may supply configuration paths explicitly with repeated `--config` arguments. A custom manifest with no configuration arguments retains dependency-only closure validation.

## Verification

The gate fails before packaging when a release-smoke configuration references a workspace plugin absent from the runtime manifest. The checked-in runtime manifest includes `@deepseek-ai/dsh-task-session`, which is mounted by both JSON-RPC agent configurations. The native release workflow still boots the produced executable and runs the complete, minimal, snapshot, direct-binary, and zero-config scenarios.

## Alternatives considered

**Rely only on executable smoke tests.** This detects the defect but only after the expensive build and does not identify the manifest/configuration mismatch directly.

**Infer configured plugins from transitive npm dependencies.** Cordis resolves bare package names from the deployment root; a coincidental transitive dependency is not an owned or stable resolution path.

**Copy every workspace package into the executable.** This increases the artifact and expands its capability surface without a selected runtime use.

## Consequences

- Configuration and packaging drift fails in the repository gate before the native build.
- Adding a workspace plugin to a release-smoke configuration also requires one explicit runtime-manifest dependency.
- Runtime packages remain limited to the intentionally declared deployment set.
