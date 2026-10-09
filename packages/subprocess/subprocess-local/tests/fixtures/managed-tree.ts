import { spawn } from 'node:child_process'
import { access, writeFile } from 'node:fs/promises'

const [statePath, publicationPermit] = process.argv.slice(2)
if (statePath === undefined) throw new Error('usage: managed-tree.ts <state-path>')

process.on('SIGTERM', () => {})
process.on('SIGHUP', () => {})
const descendant = spawn(process.execPath, [
  '-e',
  'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},60_000)',
], { stdio: 'ignore' })
if (descendant.pid === undefined) throw new Error('managed descendant did not publish a pid')

if (publicationPermit !== undefined) {
  // The parent releases publication only after the host observes incomplete JSON.
  await writeFile(statePath, '{')
  for (;;) {
    try {
      await access(publicationPermit)
      break
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}
await writeFile(statePath, JSON.stringify({ root: process.pid, descendant: descendant.pid }))
setInterval(() => {}, 60_000)
