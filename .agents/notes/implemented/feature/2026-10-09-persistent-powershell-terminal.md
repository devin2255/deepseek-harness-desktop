# Agent Note: Persistent PowerShell terminals

Status: implemented

English | [中文](2026-10-09-persistent-powershell-terminal.zh.md)

## Problem

Windows desktop tasks need shell variables, functions, cwd, and interactive stdin to survive tool calls. ConPTY allocation alone does not choose shell syntax, initialize a usable prompt, or make cancellation safe under the desktop's default restricted-token sandbox. A Harness running on Windows may also use a remote Linux subprocess Provider, so host-platform guessing inside a backend can select the wrong shell.

## Decision

`dsh-terminal-shell` owns the shared persistent-session implementation for explicitly selected Bash and PowerShell. Its `shell` configuration defaults to Bash independently of the host; the local desktop overlay explicitly chooses PowerShell on Windows. PowerShell resolves its executable through the mounted subprocess Provider, defaults to Windows PowerShell 5.1 (`powershell.exe`), and accepts `shellPath: pwsh` for PowerShell 7. Omitted arguments install the selected controlled startup; explicit arguments replace it. The [persistent PTY decision](2026-07-16-persistent-pty-sessions.md) retains ownership, output bounds, readiness tiers, and process-local lifetime.

PowerShell startup removes PSReadLine and profiles, sets UTF-8 pipeline output, and installs the private OSC marker through core string operations. Console encoding setters run only in FullLanguage. Read-only [Windows confinement](2026-08-08-windows-acl-restricted-token-sandbox.md) can trigger ConstrainedLanguage because its AppLocker startup probe cannot write temp files; startup preserves that restriction instead of granting temp writes or changing language mode. The logged MOTD identifies PowerShell syntax and this restriction.

ConPTY supplies no foreground process-group fact. PowerShell output silence therefore returns `inferred_idle`, not `stdin_read`, and a timeout does not imply command exit. Cancellation discards pre-interrupt readiness evidence, waits for pending writes, and uses the [native interruption operation](2026-10-09-terminal-interruption-results.md). The canceled send retains ownership while delivery is pending. Native acceptance observes the renewed prompt before demonstrating continued input; a delivery receipt or child exit alone is insufficient.

The Windows ACL runner consumes its own SIGINT through Node's process-local listener while retaining its existing restricted token, inherited stdio, Job ownership, and grant cleanup. It does not set `SetConsoleCtrlHandler(NULL, TRUE)`: Microsoft's [console-control documentation](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler) specifies that this ignore flag is inherited by children. Native acceptance reproduces a confined foreground child surviving Ctrl+C with that flag, and proves child exit plus preserved shell state with the process-local listener.

## Alternatives considered

**Duplicate the Bash lifecycle in a PowerShell-only package.** Rejected because readiness polling, bounded output, owner fences, cancellation, and teardown have the same owner and settlement points. Separate copies would permit their safety fixes to diverge.

**Choose a shell from the Harness host inside the Provider.** Rejected because a remote execution world can have a different OS. The local desktop composition owns its platform choice explicitly.

**Grant writable temp space in read-only mode or force FullLanguage.** Rejected because terminal startup must not widen file authority or override host language policy. Core-only prompt construction preserves a usable restricted session.

**Kill the entire terminal for every cancellation.** Rejected because it destroys the state persistence requires. Whole-session termination remains the recovery for ignored input or transport failure.

## Verification

Portable tests pin shell-specific default resolution, explicit argument replacement, execution-world executable lookup, cancellation during lookup, and PowerShell MOTD/readiness without foreground facts. Source and built Loader transcripts cover the real backend and terminal tools with only the OS transport controlled. Native Windows PowerShell 5.1 and 7 acceptance covers Unicode, spaced cwd changes, multiline state, interactive child input, Ctrl+C, renewed prompts, and subsequent commands. Restricted-mode acceptance checks workspace writes, read-only denial, outside-workspace denial, confined interruption, and owner-disposal root/descendant quiescence. The ACL runner's existing native suite pins its unchanged write restrictions and failure behavior.

## Consequences

Desktop Agents can use persistent PowerShell without an unrestricted fallback or fictitious foreground identity. The six terminal tools coexist with bounded one-shot tools; POSIX signal operations still reject on Windows. PowerShell prompt overrides and native control-input handling remain application-dependent, so inferred readiness is not a command-completion receipt. Terminal state does not survive Host loss, and full-screen interaction remains unsupported. This implementation does not qualify installer signing, updates, or the complete desktop release.
