/** Owns a stable Windows mutex through a child whose lifetime follows the desktop app. */

import { spawn } from 'node:child_process'

const MUTEX_NAME = 'Local\\DeepSeekHarnessDesktop-5e7c4c1c-7429-5bb9-9c22-4e1bf4e2e478'

/** Handle for the explicit application mutex helper. */
export interface ApplicationMutexHandle {
  /** Release the mutex and wait for its owner process to exit. */
  release(): Promise<void>
}

/** Return the fixed helper program used by production and inspected by tests. */
export function applicationMutexPowerShell(): string {
  return `$createdNew=$false;$mutex=[Threading.Mutex]::new($true,'${MUTEX_NAME}',[ref]$createdNew);if(-not $createdNew){exit 2};[Console]::Out.WriteLine('ready');try{[Console]::In.ReadToEnd()|Out-Null}finally{$mutex.ReleaseMutex();$mutex.Dispose()}`
}

/** Acquire the stable application mutex without relying on Electron's private lock name. */
export async function acquireApplicationMutex(): Promise<ApplicationMutexHandle> {
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', applicationMutexPowerShell()], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => { reject(new Error(`Application mutex helper exited before acquisition (${String(code)})`)) })
    child.stdout.once('data', (chunk) => {
      if (String(chunk).trim() === 'ready') { resolve() }
      else reject(new Error('Application mutex helper returned an invalid readiness marker'))
    })
  })
  let released: Promise<void> | undefined
  return {
    release: () => released ??= new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Application mutex helper exited with ${String(code)}`))
      })
      child.stdin.end()
    }),
  }
}
