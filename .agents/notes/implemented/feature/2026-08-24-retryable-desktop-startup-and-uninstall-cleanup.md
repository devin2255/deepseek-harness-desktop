# Agent Note: Retryable desktop startup and authenticated uninstall cleanup

Status: implemented

English | [中文](2026-08-24-retryable-desktop-startup-and-uninstall-cleanup.zh.md)

## Problem

The desktop process could start its Harness child only once and terminated when startup failed, leaving no local recovery path. A per-user uninstaller also needs an optional way to delete mutable product data without turning the application executable into a general filesystem-deletion command or following Windows links into data outside the product directory.

## Decision

Electron creates the local startup window after `app.whenReady()` and before starting Harness. Main owns a monotonically increasing attempt record containing one `AbortController`, one eventual Harness handle, and one settlement promise. The supervisor reports runtime-file validation, canonical endpoint discovery, and authenticated probe success at their actual commit points; Main projects only those callbacks into startup state and ignores callbacks from stale attempts. Retry is accepted only from failed state, marks that attempt stale, aborts it, awaits its child cleanup, and then starts exactly one replacement. The startup window remains the live single-instance focus target until `handoffTo` settles and Main installs the ready desktop window as the current target.

Startup state and fixed lifecycle facts are appended to the product-owned desktop log. The recovery renderer can request only three Main-owned operations: serialized retry, `shell.openPath(DesktopLog.currentPath())`, and bounded application exit. Raw startup diagnostics never enter renderer state. The Harness supervisor retains its own child shutdown deadline, while Main applies an explicit deadline to the complete exit wait so Electron can terminate after a child violates cancellation.

Uninstall cleanup is selected before normal runtime resolution, the single-instance lock, Harness startup, or window creation. It accepts exactly one `--uninstall-delete-user-data=<token>` argument and requires the same 256-bit unpadded base64url token in `DSH_UNINSTALL_CLEANUP_TOKEN`; format validation precedes a constant-time comparison, and failures never echo either value. The installer is the only intended producer of both channels, and the environment channel is inherited only by that cleanup child.

The cleanup root is always resolved as the fixed `DeepSeek Harness` child of an explicit absolute `%APPDATA%`. Cleanup rejects filesystem roots, missing or unsafe APPDATA values, non-directory ancestors, and symbolic links or junctions at any existing ancestor or product root. Before mutation it builds a same-volume validation tree whose ordinary files are hardlinks and whose directory and link entries are recreated without following links; the explicit 100,000-entry ceiling bounds this work without duplicating session bytes. Cleanup runs every unlink and directory-removal stage on that tree. A validation failure leaves the canonical tree untouched. After validation, one identity-checked same-volume rename commits canonical-path removal, and link-aware tombstone purge cannot convert a post-commit failure into a false rollback-capable error. No caller can provide a deletion root or bypass token and path validation through dependency injection.

## Alternatives considered

**Quit after the first startup error.** Rejected because runtime and profile failures are recoverable, and terminating removes the only product-owned place to explain and retry the failure.

**Start a replacement child immediately when Retry is clicked.** Rejected because overlapping children can contend for mutable Harness state and allow late completion from the old attempt to replace current UI state.

**Accept a cleanup path from the command line.** Rejected because a compromised or accidental invocation could turn the signed desktop binary into an arbitrary recursive-delete primitive.

**Authorize cleanup with only a command-line flag or predictable token.** Rejected because any ordinary desktop launch can supply command-line arguments. An independently inherited high-entropy environment value confines authorization to the uninstaller-created child.

**Use recursive removal directly on the product path.** Rejected because Windows junction handling can traverse outside the owned directory and a mid-tree failure cannot restore already removed entries. Hardlink rehearsal, final-component link inspection, the atomic canonical rename, and unlinking links preserve both pre-commit failure atomicity and the external target.

## Consequences

Startup failures keep a usable native recovery window and retries cannot overlap supervised children. The desktop owns additional lifecycle state and a complete cleanup timeout; if that timeout expires, Electron exits after reporting the failure even though a defective child may remain. Assisted uninstall removes the canonical mutable-data root without exposing a general delete interface. Failures before the atomic rename are nonzero and leave every canonical entry intact; after the rename commits success, an operating-system failure may leave a randomly named non-canonical tombstone rather than claim that rollback remains possible. Installer code must generate a fresh 32-byte value, encode it as 43-character unpadded base64url, pass it in both cleanup channels, and avoid inheriting the environment value into any unrelated process.
