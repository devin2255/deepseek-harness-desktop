# Agent Note: Normalize Cordis config paths before ownership checks

Status: implemented

English | [中文](2026-10-01-cordis-config-platform-paths.zh.md)

## Problem

The static CI gate found two configured plugins missing from `examples/package.json`: `dsh-task-session` and `dsh-client-ui-task-overview`. The same verifier had passed locally on Windows because `globSync` returned backslash-separated paths there, while its ownership filters looked for `examples/` with forward slashes. As a result, the Windows run skipped example dependency validation and could not catch the missing declarations.

## Decision

`cordisConfigFiles` returns repository-relative paths with `/` separators on every host. The app-overlay glob uses the same normalizer, so Windows does not misclassify MCP-memory overlays as example-owned configs. Tests assert the representation independently of the host's path separator. Declare both configured workspace packages in the examples manifest and regenerate the lockfile. The verifier uses normalized paths for ownership classification and diagnostics.

## Alternatives considered

Add Windows-specific checks in each verifier filter. Rejected because every consumer of the shared discovery helper would still receive platform-dependent paths. Ignore the missing dependencies because local resolution succeeds in a populated workspace. Rejected because clean installations and published artifacts resolve through the declared manifest, not incidental links in a developer checkout.

## Consequences

Windows and Linux now apply the same example-manifest checks. The focused discovery test, `verify-cordis-config` on Windows, and the Linux static CI gate cover the changed paths. Existing diagnostics use forward-slash repository paths on both systems.
