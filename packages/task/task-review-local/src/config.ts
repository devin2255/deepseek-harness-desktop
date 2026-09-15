/** Configuration resolution for the local Task review Provider. */

/** Default Git command deadline. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
/** Default process-tree termination grace. */
export const DEFAULT_TERMINATE_GRACE_MS = 2_000
/** Default collected-output bound for one Git invocation. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
/** Default returned patch bound. */
export const DEFAULT_MAX_DIFF_BYTES = 2 * 1024 * 1024
/** Default complete patch bound for Apply stdin. */
export const DEFAULT_MAX_PATCH_BYTES = 16 * 1024 * 1024
/** Default number of files returned in one review summary. */
export const DEFAULT_MAX_FILES = 2_000

/** Fully resolved local Task review configuration. */
export interface ResolvedConfig {
  readonly gitCommand: string
  readonly commandTimeoutMs: number
  readonly terminateGraceMs: number
  readonly maxOutputBytes: number
  readonly maxDiffBytes: number
  readonly maxPatchBytes: number
  readonly maxFiles: number
}
