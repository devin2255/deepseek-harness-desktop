# Agent Note: Bounded Windows atomic replacement retries

Status: implemented

English | [中文](2026-10-08-windows-atomic-replacement-retry.zh.md)

## Problem

Windows can reject replacement of an existing settings document with `EPERM` while another handle temporarily occupies it. An assembled browser settings operation receives `settings-rejected`, leaving the durable preference unchanged. The same atomic-write primitive also publishes credentials, so retrying only the browser gesture leaves other consumers exposed.

## Decision

`dsh-atomic-write` retries Windows `EPERM`, `EACCES`, and `EBUSY` rename failures against the same prepared sibling and destination. A monotonic one-second retry budget uses exponential delays from 10 ms to 100 ms, capped by the remaining budget. A successful rename is the publication point. Exhaustion rethrows the last filesystem error; unrelated errors and other platforms fail immediately.

Publication never unlinks the destination, rewrites the prepared content, or falls back to a non-atomic copy. Failure cleanup removes only the operation's temporary sibling. These retry limits are fixed filesystem-protocol bounds below the two-second writer-lock acquisition deadline, not plugin deployment settings. They do not cancel an in-flight filesystem call or change the [settings writer-lock and read-modify-write rules](../architecture/2026-07-30-settings-write-path-integrity.md).

## Alternatives considered

**Use `graceful-fs`.** Its [Windows rename wrapper](https://github.com/isaacs/node-graceful-fs/blob/main/polyfills.js) retries only when a subsequent destination stat reports `ENOENT`, so it does not retry replacement of an existing document. Its 60-second retry allowance also exceeds this store's writer-lock acquisition budget.

**Delete the destination or overwrite it in place.** Either loses the old-or-new complete-content guarantee; a failed publication can lose the previous settings or expose partial content.

**Retry the entire settings mutation.** Re-rendering a document is not necessary to publish an already prepared replacement, and a browser-only retry does not protect credentials or other settings callers. Publication retries stay inside the existing writer lock.

**Retry every error on every platform.** Missing paths, I/O failures, and non-Windows permission failures do not establish temporary sharing contention. Delaying them hides an actionable failure without supporting evidence.

## Consequences

Temporary Windows sharing failures no longer require another user gesture. Persistent permission failures can take one extra second before rejection. Atomicity, exclusive temp creation, caller-selected mode bits, lock ownership, and last-good settings publication remain unchanged. This does not add fsync durability or Windows DACL preservation to this utility; the [DACL replacement decision](2026-07-19-windows-atomic-write-dacl-preservation.md) owns the separate `dsh-fs-local` implementation.

The [Host-backed preference decision](2026-08-06-host-backed-web-preferences.md) still owns browser synchronization, while the [request-level configuration decision](../architecture/2026-07-29-request-level-llm-config-credentials.md) still owns credential references and the shared utility's consumers. None of these independent decisions is superseded.

## Verification

Host-independent fault injection covers all three retryable codes, identical rename arguments, one content write, deadline exhaustion, last-error preservation, unrelated errors, and immediate POSIX failure. The settings and credentials provider suites retain cross-instance serialization, failure cleanup, and watcher coverage. The keyless assembled browser settings scenario injects two native Windows rename failures, verifies the persisted preference, and retains the existing UI snapshots, reload, and distinct-port checks. It uses no model API calls and changes no golden output.
