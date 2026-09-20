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

/** Protected directories used for immediate built-asset writes. */
export interface BuiltAssetCopyRoot {
  readonly desktop: string
  readonly lib: string
}

/**
 * Resolve the protected directories required by a built-asset copy.
 * @param desktopRoot - Trusted file URL for the desktop package directory.
 * @returns Ordinary desktop and lib directories.
 * @throws When the URL is not local or either directory is absent, linked, or not a directory.
 */
export function resolveBuiltAssetCopyRoot(desktopRoot: URL): Promise<BuiltAssetCopyRoot>

/**
 * Recheck protected directories and resolve one absent or ordinary-file write target.
 * @param paths - Previously guarded desktop paths.
 * @param name - Fixed direct child name below the lib directory.
 * @returns Absolute destination path after the current filesystem checks.
 * @throws When the name is not a direct child or a protected path is linked or has the wrong type.
 */
export function resolveBuiltAssetWriteTarget(paths: BuiltAssetCopyRoot, name: string): Promise<string>
