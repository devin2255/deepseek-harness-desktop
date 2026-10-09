# @deepseek-ai/dsh-terminal-shell

English | [中文](README.zh.md)

Persistent shell backend for `ctx.terminals` over `ctx.subprocess.spawnTerminal`. It starts an interactive shell under the shared `ctx.sandboxPolicy`, retains bounded line-oriented output, and detects readiness while the subprocess provider owns PTY allocation, environment scrubbing, foreground process groups, signalling, and complete terminal-session cleanup. The same PTY backend therefore composes with local or remote execution-world providers.

## Plugin (`terminal-shell`)

`shell` explicitly selects `bash` (default) or `powershell`; it never infers the execution world from the Harness host. Omitted `shellPath` resolves to `/bin/bash` or `powershell.exe` respectively; set `shellPath: pwsh` for PowerShell 7. PowerShell executables resolve through the mounted subprocess Provider. Omitted `shellArgs` installs the selected controlled interactive startup, while an explicit array replaces it. PowerShell starts without profiles or PSReadLine, uses a UTF-16LE encoded startup command, sets UTF-8 pipeline output, and sets console encodings only in FullLanguage mode. Its prompt uses core string operations so read-only ConstrainedLanguage remains usable. ConPTY does not report a foreground group, so Windows sends return `inferred_idle` or `timeout`, never a fabricated exact stdin wait. The [PowerShell decision](../../../.agents/notes/implemented/feature/2026-10-09-persistent-powershell-terminal.md) owns startup and confined interruption.

The plugin injects `terminals`, `sandboxPolicy`, and `subprocess`, then registers the configured backend type (`shell`). `danger-full-access` starts the shell directly without requiring a sandbox provider; confined modes require a same-world `ctx.sandbox` and wrap the exact shell argv through it, failing before spawn when none is mounted. At spawn, one `ctx.sandboxPolicy.resolve({ session })` call supplies both the effective mode and the session workspace root; the same root is the default shell cwd when the caller omits one. A change to a different effective mode is rejected before its `sandbox/mode` event commits while that owner has an open PTY or a spawn in progress; the fence is attached to the exact owner and therefore outlives a provider reload that retains existing sessions. Wait for creation to settle and close the sessions before changing modes, so a terminal opened with wider access cannot survive a downgrade.

Readiness combines a foreground-verified private bash prompt marker, provider-reported foreground stdin-wait facts, silence fallback, and absolute timeout. A marker is not ready until the printable tail after the latest owned marker exactly equals the controlled `PS1`, including when the OSC marker and prompt are split across data callbacks; echoed input or output following an earlier prompt therefore cannot settle the current send. The controlled `PROMPT_COMMAND` re-asserts that `PS1` before every prompt, so an in-shell prompt override cannot degrade later sends to silence readiness. Prompt and silence evidence collected before the provider write, including while pre-write foreground inspection is pending, is discarded at the write boundary. When bash prints the marker before the terminal provider publishes its return to the foreground process group, polling retains the candidate for `handoffGraceMs` past the ordinary silence bound so a coincident handoff can win. An interactive child that inherits `PROMPT_COMMAND` therefore cannot suppress inferred-idle readiness until the absolute timeout. Unknown foreground state is never a positive exact-idle signal. A foreground group's stdin wait that existed before a send is likewise not post-write readiness: the same group must be observed outside that wait before a later wait can settle the send, while a changed foreground group is new evidence. During unpublished startup, a fallback requires observed output; zero-output silence cannot publish an empty session, and timeout rejects the spawn. Cancellation closes the unpublished shell and rejects with the caller's exact abort reason; `TerminalBackendCleanupError` separately preserves a cleanup failure. The caller's signal is forwarded for terminal allocation and readiness initialization; after publication the handle owns its lifetime. Incomplete terminal-control sequences are bounded by `maxReadBytes` and discarded through their terminator after crossing that limit; malformed UTF-8 terminal output uses replacement characters, and a trailing carriage return is carried across callbacks so split CRLF becomes one newline.

Send cancellation marks queued input as canceled before calling the terminal handle's native `interrupt()` operation; POSIX delivers real foreground `SIGINT`, while Windows writes native Ctrl+C input without claiming a delivered signal or child exit. If asynchronous pre-write inspection later settles, it cannot execute canceled input. If a provider write is already in flight, interruption waits for it to settle; a rejected write sends no interrupt. Only the first cancellation request is accepted. The canceled send retains its slot until the write and interruption settle, so a successor cannot receive either late bytes or that interrupt. A provider write or interrupt that never settles therefore retains the slot indefinitely; closing the session (`terminal_close`) is the recovery. The absolute deadline remains armed while cancellation waits. An interruption failure is a terminal transport failure and rejects the active send. Close rejects new public signals, stops readiness polling, and awaits the handle's provider-owned complete-session termination before settling the active send as `session_exit`. The [interruption decision](../../../.agents/notes/implemented/feature/2026-10-09-terminal-interruption-results.md) owns platform-specific delivery results; delivery alone does not provide shell readiness.

## Model Experience

### Current file policy and indirect consumer

#### What the model sees

The policy owner contributes capability-neutral `sandbox:policy` context. Through `@deepseek-ai/dsh-tool-terminal` or another PTY consumer, the model may also receive bounded MOTD, send deltas, scrollback pages, readiness reasons, and cleanup errors. PowerShell session creation prefixes the logged MOTD with the following text.

##### PowerShell MOTD prefix

```markdown
PowerShell session; use PowerShell syntax. Read-only mode may restrict .NET methods (ConstrainedLanguage).
```

#### Token effect

The current-policy clause is present while this backend is mounted. Retained PTY scrollback is not placed in model history until a consumer returns bounded output.

#### KV Cache effect

A standing-policy change appends an owner-rendered superseding runtime-context snapshot after retained history; consumer results remain append-only.

## Known Limitations and Deferred Work

- Line-oriented output is normalized; full-screen alternate-buffer interaction is unsupported.
- Exact stdin-wait detection depends on the mounted subprocess provider. Prompt readiness also requires an observed foreground group; missing foreground facts, including at startup, leave only silence (`inferred_idle`) or timeout readiness.
- Cleanup guarantees are those of `SubprocessTerminalHandle`; provider-specific gaps belong to that implementation's contract rather than this PTY consumer.
- Sessions do not survive harness process exit.
