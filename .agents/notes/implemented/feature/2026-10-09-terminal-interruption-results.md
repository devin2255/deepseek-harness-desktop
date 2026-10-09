# Agent Note: Terminal interruption delivery results

Status: implemented

English | [中文](2026-10-09-terminal-interruption-results.zh.md)

## Problem

Persistent terminal cancellation needs to interrupt a foreground command without destroying shell state. POSIX foreground signals and Windows console input are different operations: ConPTY cannot return a POSIX process-group identity, and writing Ctrl+C does not prove that an application has stopped. Repeated cancellation or signalling that outlives teardown can also interrupt a successor operation.

## Decision

`SubprocessTerminalHandle.interrupt()` returns a discriminated delivery result. Local POSIX and E2B Providers deliver real foreground `SIGINT` and return the observed group. The Windows Provider writes Ctrl+C through its tracked input operation and returns `control-input`, without inventing a group or signal. Windows console input mode determines whether Ctrl+C invokes a control handler or reaches a raw-input reader. POSIX `signalForeground()` retains its existing meaning and rejects on Windows. The [subprocess seam](../architecture/2026-07-26-subprocess-seam.md) still owns process allocation, transport, and termination; [Windows Job ownership](../architecture/2026-10-08-windows-conpty-job-ownership.md) still owns ConPTY cleanup.

Delivery is not command exit or readiness. Applications may ignore interruption. In particular, PowerShell can reset its input buffer after the foreground child exits; a Consumer must observe renewed shell readiness before submitting another command rather than infer it from child death or the input write callback.

The [persistent shell backend](2026-07-16-persistent-pty-sessions.md) uses this operation for send cancellation, still delivering real POSIX `SIGINT`. A send accepts only its first cancellation and retains its reservation until its input write and interruption settle. POSIX local teardown closes input and foreground operations immediately, joins in-flight signalling, and rechecks closure after asynchronous foreground inspection. Windows joins interruption writes during Job cleanup; E2B retains its abort-and-join signalling lifecycle.

## Alternatives considered

**Alias Windows `signalForeground('SIGINT')` to a control byte.** Rejected because the existing result promises a delivered signal and actual group identity. A tagged interruption receipt preserves both facts without weakening POSIX callers.

**Terminate the owned Job for every interruption.** Rejected because killing the shell destroys persistent variables, functions, and interactive state. Whole-session termination remains an explicit cleanup operation.

**Treat accepted input or foreground-child exit as command readiness.** Rejected because neither observes when the shell resumes accepting input. Native PowerShell acceptance reproduces the post-interrupt input-buffer reset.

## Verification

Portable tests pin delivery tags, failed writes, rejection after close, no late foreground signal after cleanup begins, and duplicate cancellation while a signal is pending. Native Windows PowerShell 5.1 and PowerShell 7 tests observe a real foreground child exit, the shell remaining alive, a new prompt, and preserved variables and functions in a subsequent command. A Loader-driven keyless native-terminal transcript observes interruption, continued input, and final root/descendant cleanup; built replay exercises the exported Provider. Its descendant acknowledges an installed SIGINT handler before publication, so foreground-group interruption preserves the process whose final cleanup is asserted. Scoped per-file coverage includes both local implementations, E2B signalling, and Bash send ownership. Live E2B interruption is not qualified by these keyless tests.

## Consequences

Consumers can request interruption without falsely reporting a Windows signal or destroying a persistent shell. They still own readiness, timeout, escalation, and user-visible completion. The [PowerShell Consumer](2026-10-09-persistent-powershell-terminal.md) owns Windows startup and the explicit local desktop composition; this primitive alone supplies neither. Terminal state remains process-local and does not survive Host loss.
