# Agent Note: Windows installer E2E path identity

Status: implemented

English | [中文](2026-09-14-windows-installer-e2e-path-identity.zh.md)

## Problem

Windows can expose the same ordinary directory through an 8.3 short-name path and a long-name path. Hosted Windows runners use this form for their temporary user directory. The installer E2E safety check previously required `realpath()` text to equal `path.resolve()` text, so path spelling normalization was misclassified as a junction. A successfully installed application could not enter readiness verification, and fixture cleanup was also refused.

The test must accept equivalent ordinary path spellings without weakening its protection against junction traversal before recursive cleanup.

## Decision

Installer fixture and runtime package roots are validated by walking every existing path component with `lstat()`. Each component must be an ordinary directory and must not be a symbolic link or junction. Text equality between `realpath()` and the supplied spelling is not used as an identity test.

Each registered runtime package root retains both its validated lexical spelling and its physical `realpath()` spelling. Windows extended namespace prefixes are normalized for containment checks. A generated fallback junction is accepted only when both its raw target and its existing physical target are contained by one of those registered representations; a missing target still requires lexical registration evidence.

The authenticated ownership marker, ownership environment value, child-path containment, recursive descendant inspection, and registered fallback-target checks remain required. A path reached through any junction ancestor is rejected before it can be registered or recursively removed.

## Verification

Installer support tests cover ordinary fixture roots, unregistered descendant junctions, registered generated fallback junctions, equivalent ordinary and extended-namespace target spellings, and a runtime package root reached through a junction ancestor. The hosted Windows installer smoke test supplies the 8.3 temporary-directory spelling and verifies clean install, packaged application readiness, offline startup, shutdown, and cleanup.

## Alternatives considered

**Compare normalized strings case-insensitively.** This still rejects valid short-name and long-name aliases because their components differ, not only their case.

**Remove the physical-path check without replacing it.** This would allow a junction ancestor to redirect recursive cleanup outside the authenticated fixture.

**Special-case the GitHub runner username.** Runner identities and temporary paths are deployment details and can change independently of the product.

## Consequences

- Ordinary Windows aliases no longer prevent installer verification or cleanup.
- Junction ancestors and junction descendants remain fail-closed.
- Safety depends on filesystem entry types and ownership evidence instead of path spelling.
