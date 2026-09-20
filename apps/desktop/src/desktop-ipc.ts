/** Named one-way IPC channels owned by the desktop shell. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Main-to-renderer event requesting navigation to one authoritative Session. */
export const DESKTOP_OPEN_SESSION_CHANNEL = 'deepseek-harness:desktop-open-session'

/** Maximum Session identity accepted across the isolated desktop IPC channel. */
export const DESKTOP_SESSION_ID_MAX_CODE_UNITS = 4_096

/**
 * Validate and brand one desktop IPC Session target.
 * @param value - Untrusted renderer-bound IPC value.
 * @returns The non-blank bounded Session identity, or `undefined` when invalid.
 */
export function parseDesktopSessionId(value: unknown): SessionId | undefined {
  if (typeof value !== 'string' || value.trim().length === 0
    || value.length > DESKTOP_SESSION_ID_MAX_CODE_UNITS) return undefined
  return value as SessionId
}
