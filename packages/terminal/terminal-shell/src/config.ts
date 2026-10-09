/** Validated configuration for the local PTY backend. */

import z from '@deepseek-ai/schemastery'
import { Buffer } from 'node:buffer'
import { CONTROLLED_PROMPT } from './sanitize.ts'

/** Public plugin configuration. */
export interface Config {
  /** Backend registry type (default: `shell`). */
  backendType?: string
  /** Shell syntax and startup protocol; explicit execution-world choice (default: `bash`). */
  shell?: 'bash' | 'powershell'
  /** Shell executable (default: `/bin/bash` for Bash, `powershell.exe` for PowerShell). */
  shellPath?: string
  /** Shell arguments; omission installs the selected shell's controlled interactive startup. */
  shellArgs?: string[]
  /** Terminal rows. */
  rows?: number
  /** Terminal columns. */
  cols?: number
  /** Maximum retained logical lines. */
  scrollbackLines?: number
  /** Maximum retained UTF-8 bytes. */
  scrollbackMaxBytes?: number
  /** Maximum bytes returned by one read or settled viewport. */
  maxReadBytes?: number
  /** Readiness polling interval. */
  pollIntervalMs?: number
  /** Delay before Linux exact syscall probes. */
  exactProbeAfterMs?: number
  /** Silence duration that yields `inferred_idle`. */
  idleSilenceMs?: number
  /**
   * Extra wait beyond `idleSilenceMs`, once a prompt marker was seen, for the shell to
   * regain the foreground before `inferred_idle` settles; at least one `pollIntervalMs`.
   */
  handoffGraceMs?: number
  /** Absolute send wait bound. */
  timeoutMs?: number
  /** Provider-owned terminal teardown grace or deadline. */
  disposeGraceMs?: number
}

/** Configuration after schema and shell-specific startup resolution. */
export type ResolvedConfig = Required<Config>

/** Schemastery config exposed by the plugin. */
export const Config: z<Config> = z.object({
  backendType: z.string().default('shell'),
  shell: z.union(['bash', 'powershell'] as const).default('bash'),
  shellPath: z.string(),
  // Arrays alone default to []; the union preserves omission for shell-specific defaults.
  shellArgs: z.union([z.array(z.string())]),
  rows: z.number().default(40),
  cols: z.number().default(160),
  scrollbackLines: z.number().default(10_000),
  scrollbackMaxBytes: z.number().default(4 * 1024 * 1024),
  maxReadBytes: z.number().default(256 * 1024),
  pollIntervalMs: z.number().default(50),
  exactProbeAfterMs: z.number().default(150),
  idleSilenceMs: z.number().default(3_000),
  handoffGraceMs: z.number().default(500),
  timeoutMs: z.number().default(30_000),
  disposeGraceMs: z.number().default(3_000),
})

/**
 * Resolve schema defaults and the explicitly selected shell's startup arguments.
 * @param config - plugin configuration, independent of the Harness host platform.
 * @returns Validated configuration ready for backend construction.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const parsed: Config = Config(config)
  const powershell = parsed.shell === 'powershell'
  const startup = [
    'Remove-Module PSReadLine -ErrorAction SilentlyContinue',
    '$global:OutputEncoding = [System.Text.Encoding]::UTF8',
    "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) }",
    `function global:prompt { [string][char]27 + ']133;D;0' + [char]7 + '${CONTROLLED_PROMPT}' }`,
  ].join('; ')
  const resolved = {
    // oxlint-disable-next-line typescript/no-misused-spread -- Schemastery's callable Config returns plain data, not a schema instance.
    ...parsed,
    shellPath: parsed.shellPath ?? (powershell ? 'powershell.exe' : '/bin/bash'),
    shellArgs: parsed.shellArgs ?? (powershell
      ? ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(startup, 'utf16le').toString('base64')]
      : ['--noprofile', '--norc', '-i']),
  }
  validateConfig(resolved)
  return resolved
}

/**
 * Assert every numeric config field is a positive safe integer and bounds compose.
 * @param config - Schemastery-resolved plugin configuration.
 * @returns Narrows the input to the fully resolved configuration.
 */
export function validateConfig(config: Config): asserts config is ResolvedConfig {
  const resolved = config as ResolvedConfig
  if (resolved.backendType.length === 0) throw new Error('terminal-shell: backendType must be non-empty')
  if (resolved.shellPath.length === 0) throw new Error('terminal-shell: shellPath must be non-empty')
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`terminal-shell: ${name} must be a positive safe integer`)
    }
  }
  if (resolved.maxReadBytes > resolved.scrollbackMaxBytes) {
    throw new Error('terminal-shell: maxReadBytes must not exceed scrollbackMaxBytes')
  }
  if (resolved.handoffGraceMs < resolved.pollIntervalMs) {
    throw new Error('terminal-shell: handoffGraceMs must be at least pollIntervalMs so one readiness poll runs inside the grace window')
  }
}
