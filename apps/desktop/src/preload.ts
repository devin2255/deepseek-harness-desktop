/** Exposes the intentionally tiny renderer-visible desktop identity. */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_OPEN_SESSION_CHANNEL, parseDesktopSessionId } from './desktop-ipc.ts'

const listeners = new Set<(sessionId: SessionId) => void>()
let pendingSessionId: SessionId | undefined

/** Deliver one validated target without allowing a renderer callback to starve later subscribers. */
function deliver(sessionId: SessionId): void {
  for (const listener of listeners) {
    try {
      listener(sessionId)
    } catch (error) {
      console.error('Desktop Session navigation listener failed', error)
    }
  }
}

ipcRenderer.on(DESKTOP_OPEN_SESSION_CHANNEL, (_event, value: unknown) => {
  const sessionId = parseDesktopSessionId(value)
  if (sessionId === undefined) return
  if (listeners.size === 0) pendingSessionId = sessionId
  else deliver(sessionId)
})

const desktopBridge = Object.freeze({
  platform: process.platform,
  onOpenSession(listener: unknown): () => void {
    if (!isSessionListener(listener)) throw new TypeError('Desktop Session navigation listener must be a function')
    listeners.add(listener)
    const pending = pendingSessionId
    pendingSessionId = undefined
    if (pending !== undefined) deliver(pending)
    let listening = true
    return () => {
      if (!listening) return
      listening = false
      listeners.delete(listener)
    }
  },
})

contextBridge.exposeInMainWorld('deepseekDesktop', desktopBridge)

/** Narrow an untrusted renderer callback at the context-isolation boundary. */
function isSessionListener(value: unknown): value is (sessionId: SessionId) => void {
  return typeof value === 'function'
}
