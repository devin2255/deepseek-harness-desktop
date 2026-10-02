/** Configuration resolution for the local Task worktree Provider. */

/** Default minimum free space required before creating a worktree. */
export const DEFAULT_MIN_FREE_BYTES = 512 * 1024 * 1024
/** Default Git command deadline. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
/** Default process-tree termination grace. */
export const DEFAULT_TERMINATE_GRACE_MS = 2_000
/** Default collected-output bound for one Git invocation. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

/** Fully resolved local Provider configuration. */
export interface ResolvedConfig {
  readonly home: string
  readonly minFreeBytes: number
  readonly gitCommand: string
  readonly commandTimeoutMs: number
  readonly terminateGraceMs: number
  readonly maxOutputBytes: number
}
