import { copyFile } from 'node:fs/promises'

await Promise.all([
  copyFile(new URL('../src/startup.html', import.meta.url), new URL('../lib/startup.html', import.meta.url)),
  copyFile(new URL('../src/startup.css', import.meta.url), new URL('../lib/startup.css', import.meta.url)),
])
