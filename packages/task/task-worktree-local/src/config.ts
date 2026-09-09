/** Configuration resolution for the local Task worktree Provider. */

import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Default minimum free space required before creating a worktree. */
export const DEFAULT_MIN_FREE_BYTES = 512 * 1024 * 1024
/** Default Git command deadline. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
/** Default process-tree termination grace. */
export const DEFAULT_TERMINATE_GRACE_MS = 2_000
/** Default collected-output bound for one Git invocation. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

/** User configuration for the local Task worktree Provider. */
export interface Config {
  /** Explicit Harness home; omitted follows `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Minimum free bytes required on the Harness-home volume. */
  minFreeBytes?: number
  /** Bare or absolute Git executable. */
  gitCommand?: string
  /** Deadline for each Git subprocess. */
  commandTimeoutMs?: number
  /** Termination grace for each Git subprocess tree. */
  terminateGraceMs?: number
  /** Per-stream collected-output byte bound. */
  maxOutputBytes?: number
}

/** Fully resolved local Provider configuration. */
export interface ResolvedConfig {
  readonly home: string
  readonly minFreeBytes: number
  readonly gitCommand: string
  readonly commandTimeoutMs: number
  readonly terminateGraceMs: number
  readonly maxOutputBytes: number
}

/** Schemastery declaration used by Cordis configuration loading. */
export const ConfigSchema: z<Config> = z.object({
  dshHome: z.string(),
  minFreeBytes: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MIN_FREE_BYTES),
  gitCommand: z.string().default('git'),
  commandTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_COMMAND_TIMEOUT_MS),
  terminateGraceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TERMINATE_GRACE_MS),
  maxOutputBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_OUTPUT_BYTES),
})

/**
 * Resolve all deployment choices once at Provider construction.
 * @param config - User configuration after Cordis schema defaults.
 * @returns Absolute roots and validated numeric limits.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const gitCommand = config.gitCommand ?? 'git'
  if (gitCommand.trim().length === 0 || gitCommand !== gitCommand.trim()) {
    throw new Error('task-worktree-local: gitCommand must be non-empty and normalized')
  }
  return Object.freeze({
    home: resolve(resolveDshHome(config.dshHome)),
    minFreeBytes: config.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES,
    gitCommand,
    commandTimeoutMs: config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    terminateGraceMs: config.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  })
}
