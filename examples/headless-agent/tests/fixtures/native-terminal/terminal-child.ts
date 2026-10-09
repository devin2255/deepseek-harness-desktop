/** OS-only fixture: persistent line input and a descendant that outlives its root unless cleaned up. */
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const statePath = process.argv[2]
if (statePath === undefined) throw new Error('terminal-child requires a state file')
const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},60000)'], { stdio: 'ignore' })
if (descendant.pid === undefined) throw new Error('descendant allocation failed')
if (!process.stdin.isTTY) throw new Error('native terminal requires a real TTY')
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.on('SIGINT', () => { console.log('__INTERRUPTED__') })
let pending = ''
let count = 0
process.stdin.on('data', (data: string) => {
  for (const character of data) {
    if (character === '\x03') console.log('__INTERRUPTED__')
    else if (character === '\r' || character === '\n') {
      if (pending === 'ping') console.log(`__PONG__:${++count}`)
      pending = ''
    } else pending += character
  }
})
await writeFile(statePath, JSON.stringify({ root: process.pid, descendant: descendant.pid }))
setInterval(() => {}, 60_000)
