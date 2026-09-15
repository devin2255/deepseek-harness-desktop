/**
 * Guard and remove generated startup assets below one trusted desktop source root.
 * @param desktopRoot - Trusted file URL for the desktop package directory.
 * @returns Completion after safe asset removal or an absent lib directory.
 */
export function cleanBuiltAssets(desktopRoot: URL): Promise<void>

/**
 * Guard and verify generated startup assets below one trusted desktop source root.
 * @param desktopRoot - Trusted file URL for the desktop package directory.
 * @returns Completion after every required asset passes verification.
 */
export function verifyBuiltAssets(desktopRoot: URL): Promise<void>
