/** OS-only fixture: persistent line input and a descendant that outlives its root unless cleaned up. */
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

const statePath = process.argv[2]
if (statePath === undefined) throw new Error('terminal-child requires a state file')
const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},60000)'], { stdio: 'ignore' })
if (descendant.pid === undefined) throw new Error('descendant allocation failed')
await writeFile(statePath, JSON.stringify({ root: process.pid, descendant: descendant.pid }))
let count = 0
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'ping') console.log(`__PONG__:${++count}`)
})
setInterval(() => {}, 60_000)
