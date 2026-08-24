# Agent Note: Retryable desktop startup and authenticated uninstall cleanup

Status: implemented

English | [中文](2026-08-24-retryable-desktop-startup-and-uninstall-cleanup.zh.md)

## Problem

The desktop process could start its Harness child only once and terminated when startup failed, leaving no local recovery path. A per-user uninstaller also needs an optional way to delete mutable product data without turning the application executable into a general filesystem-deletion command or following Windows links into data outside the product directory.

## Decision

Electron creates the local startup window after `app.whenReady()` and before starting Harness. Main owns a monotonically increasing attempt record containing one `AbortController`, one eventual Harness handle, and one settlement promise. The supervisor reports runtime-file validation, canonical endpoint discovery, and authenticated probe success at their actual commit points; Main projects only those callbacks into startup state and ignores callbacks from stale attempts. Retry is accepted only from failed state, marks that attempt stale, aborts it, awaits its child cleanup, and then starts exactly one replacement. The startup window remains the live single-instance focus target until `handoffTo` settles and Main installs the ready desktop window as the current target.

Startup state and fixed lifecycle facts are appended to the product-owned desktop log. The recovery renderer can request only three Main-owned operations: serialized retry, `shell.openPath(DesktopLog.currentPath())`, and bounded application exit. Raw startup diagnostics never enter renderer state. The Harness supervisor retains its own child shutdown deadline, while Main applies an explicit deadline to the complete exit wait so Electron can terminate after a child violates cancellation.

Uninstall cleanup is selected before normal runtime resolution, the single-instance lock, Harness startup, or window creation. It accepts exactly one `--uninstall-delete-user-data=<token>` argument and requires the same 256-bit unpadded base64url token in `DSH_UNINSTALL_CLEANUP_TOKEN`; format validation precedes a constant-time comparison, and failures never echo either value. The installer is the only intended producer of both channels, and the environment channel is inherited only by that cleanup child.

The cleanup root is always resolved as the fixed `DeepSeek Harness` child of an explicit absolute `%APPDATA%`. Cleanup rejects filesystem roots, missing or unsafe APPDATA values, non-directory ancestors, symbolic links or junctions at any existing ancestor or product root, and links or special files anywhere below the product root. Before mutation it writes a same-volume private archive with exclusive creation, streams ordinary file bytes in 64 KiB chunks, records a SHA-256 digest per file, fsyncs the archive, restores it into a private validation directory, and deletes that validation tree through the same mutation operations used after commit. There is no content-byte limit; the explicit 100,000-entry ceiling bounds metadata and traversal work and fails before mutation. After identity revalidation, a same-volume rename moves the canonical directory to a transaction tombstone. A tombstone purge or final archive-unlink failure restores and verifies the archive, atomically republishes the canonical directory, and reports failure. Success is returned only after the canonical directory, tombstone, archive, and private restore directories are absent. The random transaction id appears in the archive name and header. A later authorized cleanup enumerates every reserved archive, tombstone, validation, and restore prefix before mutation; it rejects malformed names, unexpected filesystem types, orphan artifacts, duplicate artifacts, and conflicting ids without touching them. Only one ordinary archive whose header id and every checksum validate authorizes recovery or removal of associated ordinary directories with the same id. Invalid imitations remain untouched and produce a nonzero result. No caller can provide a deletion root or bypass token and path validation through dependency injection.

## Alternatives considered

**Quit after the first startup error.** Rejected because runtime and profile failures are recoverable, and terminating removes the only product-owned place to explain and retry the failure.

**Start a replacement child immediately when Retry is clicked.** Rejected because overlapping children can contend for mutable Harness state and allow late completion from the old attempt to replace current UI state.

**Accept a cleanup path from the command line.** Rejected because a compromised or accidental invocation could turn the signed desktop binary into an arbitrary recursive-delete primitive.

**Authorize cleanup with only a command-line flag or predictable token.** Rejected because any ordinary desktop launch can supply command-line arguments. An independently inherited high-entropy environment value confines authorization to the uninstaller-created child.

**Use recursive removal directly on the product path.** Rejected because Windows junction handling can traverse outside the owned directory and a mid-tree failure cannot restore already removed entries. Descendant-link rejection, the verified recovery archive, the atomic canonical rename, and link-aware removal preserve the external target and restore canonical contents after a committed deletion fails.

## Consequences

Startup failures keep a usable native recovery window and retries cannot overlap supervised children. The desktop owns additional lifecycle state and a complete cleanup timeout; if that timeout expires, Electron exits after reporting the failure even though a defective child may remain. Assisted uninstall removes the canonical mutable-data root without exposing a general delete interface. Every ordinary nonzero result preserves the complete canonical directory; a fatal recovery diagnostic retains the verified private archive for a later authorized recovery attempt. A zero result means no product data or owned transaction artifact remains. Large sessions consume temporary same-volume archive space proportional to their ordinary file bytes, while streaming keeps memory bounded. Installer code must generate a fresh 32-byte value, encode it as 43-character unpadded base64url, pass it in both cleanup channels, and avoid inheriting the environment value into any unrelated process.
