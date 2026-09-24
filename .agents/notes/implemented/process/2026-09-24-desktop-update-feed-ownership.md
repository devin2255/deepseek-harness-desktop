# Agent Note: Desktop update feed ownership

Status: implemented

English | [中文](2026-09-24-desktop-update-feed-ownership.zh.md)

## Problem

The desktop package's repository metadata names the upstream project, while this fork publishes its own installers. An inferred update provider could therefore point an installed application at a release repository that this product does not control. The two-stage Windows build also omits the installed `app-update.yml` and discards `latest.yml` unless packaging owns both files explicitly.

## Decision

The [builder configuration](../../../../apps/desktop/electron-builder.yml) pins GitHub updates to `devin2255/deepseek-harness-desktop`. Windows packaging writes the exact reviewed provider and updater cache directory into `resources/app-update.yml` after the directory build and rejects a different builder-produced value. For a signed application, it records the trusted Authenticode certificate common name as `publisherName`; otherwise `electron-updater` would omit installer signature verification. It retains `latest.yml` and checks its version, installer name, and SHA-512 against the final EXE. Validation and the protected release workflow repeat these checks before publication; the workflow also requires the installer and application to share the signing publisher and publishes the manifest beside the signed installer. Desktop releases use semver-readable `v<version>` tags, distinct from npm's `dsh-v<version>` tags, so the updater can identify prereleases. The application does not yet check or apply updates.

## Alternatives considered

**Infer the provider from repository metadata.** That metadata identifies the upstream project and cannot prove ownership of this fork's release assets.

**Write a separate update manifest by hand.** A hand-authored digest could drift from the signed installer; the builder-produced manifest is verified against the final bytes instead.

## Consequences

An installed Windows package contains an unambiguous update source, and a release manifest cannot silently name different installer bytes. Release creation now requires `latest.yml` alongside the EXE. Automatic update behavior and signed macOS publication remain separate work; these files alone do not make an application self-updating.
