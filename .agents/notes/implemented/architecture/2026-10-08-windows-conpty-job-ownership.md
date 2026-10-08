# Agent Note: Windows ConPTY Job ownership

Status: implemented

English | [中文](2026-10-08-windows-conpty-job-ownership.zh.md)

## Problem

The desktop runs Windows commands through one-shot PowerShell, but persistent terminal allocation rejects Windows before starting a process. A Windows implementation also needs to stop descendants after the shell or Harness exits without redirecting cleanup to a reused PID. POSIX foreground groups and signals cannot describe that platform.

## Decision

The local subprocess Provider implements its existing terminal primitive with Windows ConPTY and an unnamed, non-inheritable kill-on-close Job. It creates the root suspended, assigns the exact process handle to the Job, and resumes only after assignment succeeds. Assignment failure terminates the suspended root by its exact handle and observes exit before releasing that handle; a failed or timed-out observation rejects rollback. Descendants created normally inherit Job membership; breakaway flags are absent. The Job is lifetime ownership, not a sandbox, and does not include processes created by external brokers such as WMI or services. The [persistent PTY decision](../feature/2026-07-16-persistent-pty-sessions.md) still owns the higher terminal capability and POSIX backend.

Native synchronous pipe clients connect to independently drained Node sockets. The Provider passes an explicit scrubbed UTF-16 environment block using Windows ordinal name ordering, without mutating the host. Windows standard handles are cleared before ConPTY attachment so child output does not inherit the Harness console. Teardown stops new input, terminates the Job, observes zero members and root exit, closes ConPTY while draining final output, and joins pending writes. Unpublished allocations remain owned through cancellation and Provider disposal; a failed native rollback remains in the allocation registry until disposal reports it, while caller cancellation retains its exact reason.

`ClosePseudoConsole` runs synchronously inside a dedicated Node worker. Its Koffi asynchronous invocation reproducibly exits the hosting process with access violation `0xc0000005`, while the synchronous binding and dedicated worker complete normally. Running the synchronous call on the main event loop is not acceptable because older ConPTY versions can block while emitting final output. Worker exit, not a message alone, settles resource release.

Output or worker failure still releases transport and process/Job handles, joins pending input, and rejects cleanup; an uncertain ConPTY close is never repeated. Allocation rollback reports its original failure together with a close failure rather than abandoning the remaining resources or replacing the original cause.

Foreground inspection returns undefined and POSIX signals reject without sending control bytes. A keyboard Ctrl+C is not a delivered POSIX signal and cannot produce a truthful `targetPgid`. A Windows-native persistent-shell Consumer and interruption operation remain separate work; this Provider does not enable the Bash backend in desktop defaults.

## Alternatives considered

**Assign the shell after ordinary `node-pty.spawn`.** Rejected because Windows allocation is asynchronous and user code can spawn descendants before Job assignment. The library's kill path also includes numeric console-member PID kills, which are unsuitable after the root exits.

**Use `taskkill /T` or POSIX group identifiers.** Rejected for persistent Windows terminals because root exit and PID reuse break numeric tree ownership, while ConPTY has no POSIX foreground group.

**Close ConPTY on the main thread or through Koffi's asynchronous call.** Rejected because the former can deadlock output draining and the latter faults in the verified native path. A dedicated Node worker retains both event-loop progress and a proven synchronous binding.

## Verification

Native PowerShell acceptance checks persistent variables, functions, Unicode/spaced cwd, a real foreground child, output EOF, and post-cleanup process absence. Host-process tests externally observe root and descendant exit after normal disposal, direct exit, unhandled failures, and forced termination that executes no JavaScript callback. Portable lifecycle tests cover concurrent close, survivor timeout, retry, transport/write failure, allocation cancellation, and disposal. A real Loader-driven keyless terminal transcript verifies persistent line input and whole-tree cleanup through the runnable example; built-mode replay exercises the published Provider.

## Consequences

Windows terminal processes acquire OS lifetime ownership before user execution and retain it when the Harness cannot run its [synchronous exit callback](../bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.md). POSIX terminals retain their existing process-inspection limits. Terminal state still does not survive Host loss, and full Windows persistent-shell interaction remains incomplete until its Consumer is implemented and qualified.
