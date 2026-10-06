# Agent Note: Desktop read-only delegation

Status: implemented

English | [中文](2026-10-06-desktop-read-only-delegation.zh.md)

## Problem

Root-task worktrees isolate concurrent desktop tasks, but ordinary in-process children share their parent's cwd. Inheriting a writable parent therefore permits multiple Agents to mutate the same task checkout. Research and review children do not need that authority. The [mission-control proposal](../../proposed/feature/2026-08-14-desktop-agent-mission-control.md) requires ordinary children to be read-only and parallel writers to use separate worktrees.

## Decision

The sandbox-policy owner exposes `delegationMode: inherit | read-only`, defaulting to inheritance for existing compositions. The Desktop overlay explicitly selects read-only and preserves the deployment's root mode and fallback directory. Both one-shot and continuable creation capture `delegatedModeOf(parent.session)` before their first await and append the resulting `sandbox/mode` event during unpublished setup, after any fork history. The existing filesystem and subprocess consumers enforce that recorded mode; no tool-visibility filter or UI label grants or denies file authority.

This extends, rather than replaces, [delegation-time policy inheritance](2026-07-25-subagent-policy-inheritance.md). Under inheritance, only a parent's explicit override is copied. Read-only delegation records its own narrower child mode even when the parent has no override or has full access. One-shot approved grants and root deployment defaults are not copied. The child's existing approval pin remains `never`, so a model cannot escalate a denied write through an approval prompt.

Cold continuable children replay their recorded creation policy. A changed deployment setting affects new delegations, not previously created Sessions. The mode uses the existing durable event and current-policy runtime context; there is no second permission record or new Session format.

## Alternatives considered

**Change every profile's child default.** Rejected because generic CLI and Web compositions deliberately permit inherited writing children. The desktop product owns the narrower choice through explicit composition.

**Hide mutation tools from children.** Rejected because shell commands and alternate capability callers can still write. The operation's sandbox policy must deny the effect, independently of tool advertisement.

**Tighten the whole task.** Rejected because the root task needs to implement and integrate changes. Delegation records a child-specific mode without mutating its parent.

## Consequences

New desktop spawn, fork, nested, and continuable children can inspect shared task files without modifying them through sandbox-enforced operations. A parent's writable mode and stale writable fork history cannot widen their creation policy. Other profiles retain the inheritance default. Existing persisted children keep their original policy, so this does not retroactively revoke running or cold Sessions.

Child-writer worktrees, explicit Integration nodes, and conflict attention remain required product work. This decision does not make parallel writing available and must not be used to present the broader mission-control proposal as complete. Out-of-process providers retain their own deployment policy.

The separately configured [isolated writer preparation](2026-10-06-isolated-subagent-writer-preparation.md) provides one-shot execution in child worktrees without changing this shared-child default. Its explicit authority and durable execution record do not replace this delegation decision.

## Verification

Policy tests pin both delegation choices, parent immutability, omitted defaults, and load-time rejection of unsupported settings. Real filesystem tests deny writes from unswitched, workspace-write, and full-access parents and override writable fork history. Continuation tests retain the recorded policy through persistence and cold resume. The desktop bundle test checks the shipped patch, and keyless Loader snapshots pin both parent-only inheritance and deployment-selected read-only children under a writable root, including an externally verified absent output file.
