# Agent Note: Consented Windows desktop updates

Status: implemented

English | [中文](2026-09-24-desktop-consented-update-installation.zh.md)

## Problem

A signed installer and a correct release feed do not update an installed application. Starting an update installer while Harness or the application mutex remains active can interrupt Tasks or cause replacement to race the running executable.

## Decision

Only a packaged Windows build with the reviewed GitHub provider and a signing publisher enables `electron-updater`. Main checks after startup and periodically, allows a tray check, and downloads full NSIS installers with code-signature verification. It disables web installers, downgrade, and installation on ordinary application quit. A downloaded release appears in the tray and a native notification. Installing requires a separate confirmation that defaults to Later and reports live Task activity or unavailable freshness. The lifecycle disposes background presence, stops Harness, and releases the mutex before calling `quitAndInstall`; an incomplete cleanup never starts the installer. Update errors are logged and remain retryable without changing Task state.

## Alternatives considered

**Install automatically when the user quits.** A normal quit may follow a decision to leave Tasks running or a transient window close, so it cannot authorize replacement.

**Launch the installer before lifecycle cleanup.** Electron-updater normally spawns the installer before it requests quit; that ordering can leave the application files and mutex occupied.

## Consequences

Download does not interrupt concurrent Agents, and installation has an explicit interruption decision. An unsigned test package has no update action. Unit and Main-entry tests cover configuration, download states, consent, cleanup ordering, and retry; a separately built signed old-to-new release remains necessary to verify the production network and installer path.
