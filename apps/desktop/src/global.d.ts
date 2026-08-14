/** Renderer-visible declarations for the isolated desktop preload bridge. */

interface Window {
  /** Immutable desktop metadata exposed through Electron context isolation. */
  readonly deepseekDesktop: Readonly<{
    /** Operating-system platform name reported by the sandboxed preload. */
    readonly platform: string
  }>
}
