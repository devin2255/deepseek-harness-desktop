/**
 * Copy source-owned static files into one built desktop package.
 * @param desktopRoot - Trusted desktop package root URL.
 * @returns Completion after all files are copied.
 */
export function copyBuiltAssets(desktopRoot: URL): Promise<void>
