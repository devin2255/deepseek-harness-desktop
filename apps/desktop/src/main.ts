/** Thin Electron entry that binds production operations to the desktop lifecycle. */

import { app } from 'electron'
import { createRequire } from 'node:module'
import { startHarness } from './harness-supervisor.ts'
import { startDesktopMain } from './main-lifecycle.ts'
import { resolveRuntimeContext } from './runtime-context.ts'
import { createDesktopWindow } from './window.ts'

const desktopRequire = createRequire(import.meta.url)
const runtimeContext = resolveRuntimeContext(app, {
  resourcesPath: process.resourcesPath,
  environment: process.env,
  resolveDevelopmentCli: specifier => desktopRequire.resolve(specifier),
})

startDesktopMain({
  app,
  launchSpec: runtimeContext,
  platform: process.platform,
  startHarness: (launchSpec, options) => startHarness(launchSpec, options),
  createWindow: (endpoint, capability) => createDesktopWindow(endpoint, capability),
  reportFailure: (phase, error) => {
    console.error(`Desktop ${phase} failure:`, error)
  },
})
