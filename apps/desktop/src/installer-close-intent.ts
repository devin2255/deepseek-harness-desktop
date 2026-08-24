/** Installer-only launch intent that must never compose normal desktop runtime state. */

const INSTALLER_CLOSE_ARGUMENT = '--installer-request-close'

/** Classification of arguments that may request an installer-owned shutdown. */
export type InstallerCloseIntent = 'none' | 'exact' | 'malformed'

/**
 * Classify desktop arguments after the executable entry has been removed.
 *
 * @param arguments_ - Arguments owned by the desktop executable.
 * @returns Exact only for the sole supported close argument; any matching prefix fails closed.
 */
export function classifyInstallerCloseIntent(arguments_: readonly string[]): InstallerCloseIntent {
  const closeArguments = arguments_.filter(argument => argument.startsWith(INSTALLER_CLOSE_ARGUMENT))
  if (closeArguments.length === 0) return 'none'
  if (arguments_.length === 1 && closeArguments[0] === INSTALLER_CLOSE_ARGUMENT) return 'exact'
  return 'malformed'
}
