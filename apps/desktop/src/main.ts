/** Thin Electron entry that binds production operations to the desktop lifecycle. */

import { app, BrowserWindow } from 'electron'
import { startHarness } from './harness-supervisor.ts'
import { startDesktopMain } from './main-lifecycle.ts'
import { createDesktopWindow } from './window.ts'

startDesktopMain({
  app,
  platform: process.platform,
  startHarness: options => startHarness({}, options),
  createWindow: (endpoint, capability) => createDesktopWindow(endpoint, capability),
  windowCount: () => BrowserWindow.getAllWindows().length,
  reportFailure: (phase, error) => {
    console.error(`Desktop ${phase} failure:`, error)
  },
})
