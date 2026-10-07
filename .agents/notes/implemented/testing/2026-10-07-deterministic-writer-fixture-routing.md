# Agent Note: Deterministic writer fixture routing

Status: implemented

English | [中文](2026-10-07-deterministic-writer-fixture-routing.zh.md)

## Problem

The keyless isolated-writer model selects its scripted response by searching the complete assembled conversation. Runtime context includes the temporary execution path. A random directory beginning with `dsh-isolated-writer-a` therefore makes writer-b select writer-a's script, even though their execution directories remain distinct. CI reports incorrect independent file contents while both turns complete successfully.

## Decision

Writer fixture adapters select the latest exact known task text from user-message content, not substrings in paths, tool results, or unrelated context. Missing task input fails explicitly. Continuation selects the latest task instruction while retaining earlier history. Integration fixtures use the same selection rule for root and child scripts.

The isolated-writer snapshot runs with both the ordinary temporary prefix and a prefix containing `writer-a`. Both compare exact file contents and the unchanged transcript against the same expected output. The colliding prefix reproduces the failure before the routing correction; no output normalization hides it.

## Alternatives considered

**Retry the failed CI job.** Rejected because random directory names conceal rather than remove the routing defect.

**Disable runtime context or rename the temporary prefix.** Rejected because real assembled context is part of the scenario and a different unrelated value can contain the same substring.

## Consequences

The fixture preserves real Loader, agent-loop, filesystem, worktree, persistence, and continuation behavior while replacing only model responses. This changes test routing, not product authority or child isolation. The [preparation](../feature/2026-10-06-isolated-subagent-writer-preparation.md) and [continuation](../feature/2026-10-07-isolated-writer-continuation.md) decisions remain active because their execution ownership and recovery rules are independent of fixture selection. Local source and built-mode snapshots verify the correction; live-model acceptance remains separate.
