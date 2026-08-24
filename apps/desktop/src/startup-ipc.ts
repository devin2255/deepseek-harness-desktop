/** IPC channel carrying renderer-safe startup state from Main to the startup page. */
export const STARTUP_STATE_CHANNEL = 'dsh-startup:state'

/** IPC channel requesting a fresh startup attempt. */
export const STARTUP_RETRY_CHANNEL = 'dsh-startup:retry'

/** IPC channel requesting the owned desktop log location. */
export const STARTUP_OPEN_LOGS_CHANNEL = 'dsh-startup:open-logs'

/** IPC channel requesting application shutdown. */
export const STARTUP_EXIT_CHANNEL = 'dsh-startup:exit'
