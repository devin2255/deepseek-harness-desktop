/** Renderer-visible declarations for the isolated desktop preload bridge. */

interface Window {
  /** Immutable desktop metadata exposed through Electron context isolation. */
  readonly deepseekDesktop: Readonly<{
    /** Operating-system platform name reported by the sandboxed preload. */
    readonly platform: string
  }>
  /** Immutable startup recovery operations exposed through context isolation. */
  readonly deepseekStartup: Readonly<{
    /** Subscribe to renderer-safe startup states and return an idempotent disposer. */
    readonly onState: (listener: (state: DesktopStartupViewState) => void) => () => void
    /** Request a fresh startup attempt. */
    readonly retry: () => Promise<void>
    /** Open the owned desktop log location. */
    readonly openLogs: () => Promise<void>
    /** Shut down the desktop application. */
    readonly exit: () => Promise<void>
  }>
}

/** Renderer-safe startup state projected by Electron Main. */
type DesktopStartupViewState = import('./startup-state.ts').DesktopStartupState
