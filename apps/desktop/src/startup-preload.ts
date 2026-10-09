/** Exposes the narrow startup and recovery bridge to the isolated renderer. */

import { contextBridge, ipcRenderer } from 'electron'
import {
  STARTUP_EXIT_CHANNEL,
  STARTUP_OPEN_LOGS_CHANNEL,
  STARTUP_RETRY_CHANNEL,
  STARTUP_STATE_CHANNEL,
} from './startup-ipc.ts'
import type { DesktopStartupState } from './startup-state.ts'

const startupBridge = Object.freeze({
  onState(listener: (state: DesktopStartupState) => void): () => void {
    const receiveState = (_event: Electron.IpcRendererEvent, state: DesktopStartupState): void => {
      listener(state)
    }
    let listening = true
    ipcRenderer.on(STARTUP_STATE_CHANNEL, receiveState)
    return () => {
      if (!listening) return
      listening = false
      ipcRenderer.removeListener(STARTUP_STATE_CHANNEL, receiveState)
    }
  },
  retry: () => ipcRenderer.invoke(STARTUP_RETRY_CHANNEL) as Promise<void>,
  openLogs: () => ipcRenderer.invoke(STARTUP_OPEN_LOGS_CHANNEL) as Promise<void>,
  exit: () => ipcRenderer.invoke(STARTUP_EXIT_CHANNEL) as Promise<void>,
})

contextBridge.exposeInMainWorld('deepseekStartup', startupBridge)
