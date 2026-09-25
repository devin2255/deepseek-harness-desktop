# Agent Note: Qualify Apple Silicon desktop test archives on a native runner

Status: implemented

English | [中文](2026-09-23-macos-arm64-desktop-package-qualification.zh.md)

## Problem

A source-built Electron acceptance test proves the desktop entry can run on macOS arm64, but it does not prove that the packaged application contains the runtime files or that its archives are readable. A Windows-built artifact cannot establish the Apple Silicon result.

## Decision

The [macOS arm64 workflow](../../../../.github/workflows/desktop-macos.yml) runs the real Electron acceptance test and then builds an unsigned arm64 application, DMG, and ZIP on an Apple Silicon runner. The packaging command invokes installed `pnpm` from `PATH` on macOS rather than assuming Corepack is beside Node; Windows uses Corepack without a command shell. It rejects signing credentials, checks the app's executable architecture and required Main/preload files, and verifies both archives. CI then mounts the DMG read-only, copies the application to a disposable installation directory, launches that copy, checks authenticated Host readiness and rejection of a direct unauthenticated request, and retains the archives for 30 days only after these checks pass. The repository-generated 1024-pixel PNG supplies the application icon; Windows keeps its separate ICO and NSIS targets.

The archives are qualification artifacts, not releases. The temporary install does not check Gatekeeper, Developer ID signing, notarization, or update delivery. Production distribution requires separate credentials, trusted installed-app acceptance, and publication checks.

## Alternatives considered

**Cross-build the Mac package on Windows.** A cross-build would not exercise the Apple Silicon Electron runtime, native modules, or macOS archive tools, so it cannot provide the required platform evidence.

**Sign packages in pull-request CI.** Pull-request code must not receive Developer ID or notarization credentials. Signing and publication belong to a protected release environment after unsigned qualification is stable.

## Consequences

The native CI lane can detect missing bundled files, malformed archives, and an application that fails after copying out of the DMG, while keeping untrusted pull-request builds away from signing authority. The retained DMG and ZIP need explicit test-only handling; this unsigned install does not establish production trust.
