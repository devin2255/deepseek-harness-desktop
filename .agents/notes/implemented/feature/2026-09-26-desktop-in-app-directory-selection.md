# Agent Note: In-app desktop directory selection

Status: implemented

English | [中文](2026-09-26-desktop-in-app-directory-selection.zh.md)

## Problem

A desktop user cannot add a Workspace when the native Windows folder-dialog worker exits before returning a path. Retrying the same worker gives no way to enter a known project directory, even though Workspace creation accepts an existing Host path.

## Decision

The desktop profile disables the Web bundle's adaptive directory-picker row and composes the browse backend with its matching client flow. Its in-app dialog lists Host directories and accepts a full path through the editable breadcrumb. The Workspace owner continues to adopt the selected path through `workspace.create`; the Host validates and canonicalizes it. The Web profile retains the adaptive native-or-browse decision, and deployments may explicitly compose the native pair.

## Alternatives considered

**Retain native as the desktop default with a retry dialog.** A worker that fails before showing the operating-system chooser leaves the user unable to enter a known path; repeating it does not recover that task.

**Add a separate path field to the Workspace error dialog.** This creates another owner for directory selection beside the composed picker flow and duplicates its path-editing behavior.

## Consequences

Desktop selection works without a native dialog worker and supports pasted Windows drive paths. It gives up the operating-system folder chooser as the default. The in-app browser retains its existing Host-filesystem reach and Windows drive-root enumeration limitation. The desktop bundle composition test pins the selected pair, and the real Electron acceptance test enters a path through the rendered dialog and observes the registered Workspace.
