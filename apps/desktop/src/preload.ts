/** Exposes the intentionally tiny renderer-visible desktop identity. */

import { contextBridge } from 'electron'

const desktopBridge = Object.freeze({ platform: process.platform })

contextBridge.exposeInMainWorld('deepseekDesktop', desktopBridge)
