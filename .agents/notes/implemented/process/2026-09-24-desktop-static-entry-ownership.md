# Agent Note: Desktop static entry ownership

Status: implemented

English | [中文](2026-09-24-desktop-static-entry-ownership.zh.md)

## Problem

Static import discovery does not see the desktop's Electron acceptance entries, Cordis profile packages, or build-only tools invoked through package scripts and dynamic resolution. Treating these as dead files or dependencies makes the repository's static check fail even though the installed application needs them.

## Decision

The desktop workspace in [Knip configuration](../../../../knip.json) names its Electron acceptance files and script declarations as entries, and lists only its known runtime-only and build-only dependencies as exceptions. The desktop profile bundle lists its three configuration-loaded dependencies separately. System command names used by Windows and macOS acceptance tests are declared globally. Internal desktop types and functions are not exported solely to satisfy static analysis, and the two unused Client test dependencies are removed from their manifests.

## Alternatives considered

**Ignore the entire desktop workspace.** That would hide unused application files, direct dependencies, and exports that static analysis can identify accurately.

**Ignore every `@deepseek-ai` desktop dependency.** A broad pattern would silently admit unrelated package declarations; the explicit list makes each dynamic dependency reviewable.

## Consequences

Knip checks the desktop's reachable code while accounting for the entry paths and dependencies its static import graph cannot infer. Adding a configuration-loaded package requires updating both its manifest and the explicit exception list; truly unused declarations remain visible.
