/** Reproduce desktop application and native tray art from the canonical SVG mark. */

import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { REPOSITORY_ROOT } from './packaging-layout.ts'

const desktopRequire = createRequire(join(REPOSITORY_ROOT, 'apps/desktop/package.json'))
const sharp = desktopRequire('sharp') as (input: Buffer) => {
  resize(width: number, height: number): {
    png(options: { readonly compressionLevel: number }): { toBuffer(): Promise<Buffer> }
  }
}

const sizes = [16, 32, 48, 256] as const
const source = await readFile(join(REPOSITORY_ROOT, 'website/public/favicon.svg'))
const images: Buffer[] = await Promise.all(sizes.map(size => sharp(source).resize(size, size).png({ compressionLevel: 9 }).toBuffer()))
const headerBytes = 6 + images.length * 16
const icon = Buffer.alloc(headerBytes + images.reduce((total, image) => total + image.length, 0))
icon.writeUInt16LE(0, 0)
icon.writeUInt16LE(1, 2)
icon.writeUInt16LE(images.length, 4)
let offset = headerBytes
for (const [index, image] of images.entries()) {
  const entry = 6 + index * 16
  const size = sizes[index] as number
  icon[entry] = size === 256 ? 0 : size
  icon[entry + 1] = size === 256 ? 0 : size
  icon[entry + 2] = 0
  icon[entry + 3] = 0
  icon.writeUInt16LE(1, entry + 4)
  icon.writeUInt16LE(32, entry + 6)
  icon.writeUInt32LE(image.length, entry + 8)
  icon.writeUInt32LE(offset, entry + 12)
  image.copy(icon, offset)
  offset += image.length
}
const templateSource = Buffer.from(source.toString('utf8').replaceAll('#4D6BFE', '#000000'))
const [template, templateRetina] = await Promise.all([
  sharp(templateSource).resize(16, 16).png({ compressionLevel: 9 }).toBuffer(),
  sharp(templateSource).resize(32, 32).png({ compressionLevel: 9 }).toBuffer(),
])
const buildRoot = join(REPOSITORY_ROOT, 'apps/desktop/build')
await Promise.all([
  writeFile(join(buildRoot, 'icon.ico'), icon),
  writeFile(join(buildRoot, 'tray.ico'), icon),
  writeFile(join(buildRoot, 'trayTemplate.png'), template),
  writeFile(join(buildRoot, 'trayTemplate@2x.png'), templateRetina),
])
