import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { pruneForeignNativePayloads, sanitizeBundlerRegionMarkers, validatePackage } from './validate-package.ts'

const temporaryRoots: string[] = []

function x64Pe(): Buffer {
  const value = Buffer.alloc(256)
  value.write('MZ', 0, 'ascii')
  value.writeUInt32LE(128, 0x3c)
  value.write('PE\0\0', 128, 'binary')
  value.writeUInt16LE(0x8664, 132)
  return value
}

async function ordinary(path: string, value: string | Buffer = ''): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
}

async function manifest(root: string, name: string, body: Record<string, unknown> = {}): Promise<string> {
  const packageRoot = join(root, 'node_modules', ...name.split('/'))
  await ordinary(join(packageRoot, 'package.json'), `${JSON.stringify({ name, version: '1.0.0', ...body })}\n`)
  return packageRoot
}

async function completeFixture(): Promise<{ app: string; packageRoot: string }> {
  const packageRoot = await mkdtemp(join(tmpdir(), 'dsh-validated-package-'))
  temporaryRoots.push(packageRoot)
  const app = join(packageRoot, 'resources', 'app')
  await ordinary(join(packageRoot, 'DeepSeek Harness.exe'), x64Pe())
  await ordinary(join(app, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-desktop', version: '0.1.0', dependencies: { '@deepseek-ai/dsh': '1.0.0' },
  })}\n`)
  await ordinary(join(app, 'lib', 'main.js'))
  await ordinary(join(app, 'lib', 'preload.cjs'))
  const dsh = await manifest(app, '@deepseek-ai/dsh', {
    dependencies: {
      '@deepseek-ai/dsh-base': '1.0.0',
      '@deepseek-ai/dsh-web-app': '1.0.0',
      '@deepseek-ai/dsh-desktop-app': '1.0.0',
      '@deepseek-ai/dsh-web-frontend': '1.0.0',
      'fixture-native': '1.0.0',
    },
  })
  await ordinary(join(dsh, 'lib', 'bin.js'))
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-desktop-app']) {
    const root = await manifest(app, name)
    await ordinary(join(root, 'cordis.patch.yml'), 'plugins: []\n')
  }
  const frontend = await manifest(app, '@deepseek-ai/dsh-web-frontend')
  await ordinary(join(frontend, 'dist', 'index.html'), '<!doctype html>')
  const native = await manifest(app, 'fixture-native', {
    peerDependencies: { '@deepseek-ai/dsh-base': '1.0.0', 'optional-peer': '1.0.0' },
    peerDependenciesMeta: { 'optional-peer': { optional: true } },
  })
  await ordinary(join(native, 'binding.node'), x64Pe())
  for (const relativePath of [
    'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.3.node',
    'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
    'node_modules/node-addon-require-builtin-win32-x64-msvc/prebuilt/win32-x64-msvc-napi-v9.node',
    'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
    'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
  ]) await ordinary(join(app, ...relativePath.split('/')), x64Pe())
  return { app, packageRoot }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop package closure', () => {
  it('prunes only known foreign native payloads while retaining x64 files and package records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-prune-'))
    temporaryRoots.push(root)
    for (const platform of ['darwin-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']) {
      await ordinary(join(root, 'node-pty', 'prebuilds', platform, 'binding.node'), x64Pe())
      await ordinary(join(root, 'node-pty', 'prebuilds', platform, 'LICENSE'), 'license')
    }
    await ordinary(join(root, 'node-pty', 'third_party', 'conpty', '1.0', 'win10-arm64', 'OpenConsole.exe'), x64Pe())
    await ordinary(join(root, 'node-pty', 'third_party', 'conpty', '1.0', 'win10-x64', 'OpenConsole.exe'), x64Pe())
    await expect(pruneForeignNativePayloads(root)).resolves.toBe(4)
    await expect(readFile(join(root, 'node-pty', 'prebuilds', 'darwin-arm64', 'binding.node'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'node-pty', 'prebuilds', 'win32-x64', 'binding.node'))).resolves.toBeInstanceOf(Buffer)
    await expect(readFile(join(root, 'node-pty', 'prebuilds', 'darwin-arm64', 'LICENSE'), 'utf8')).resolves.toBe('license')
    await expect(readFile(join(root, 'node-pty', 'third_party', 'conpty', '1.0', 'win10-x64', 'OpenConsole.exe'))).resolves.toBeInstanceOf(Buffer)
  })

  it('rejects an unknown prebuild platform instead of guessing its reachability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-native-prune-'))
    temporaryRoots.push(root)
    await ordinary(join(root, 'package', 'prebuilds', 'win32-ia32', 'binding.node'), x64Pe())
    await expect(pruneForeignNativePayloads(root)).rejects.toThrow(/unknown native platform/u)
  })

  it('accepts a complete relocatable x64 package', async () => {
    const fixture = await completeFixture()
    await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [] })).resolves.toMatchObject({
      packages: 7, nativeBinaries: 7, externalLinks: 0,
    })
  })

  it('requires an explicit product native addon instead of accepting an Electron helper executable', async () => {
    const fixture = await completeFixture()
    await ordinary(join(fixture.packageRoot, 'resources', 'helper.exe'), x64Pe())
    await unlink(join(fixture.app, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'))
    await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [] })).rejects.toThrow(/required native/u)
  })

  it.each([
    ['CLI', 'node_modules/@deepseek-ai/dsh/lib/bin.js'],
    ['profile', 'node_modules/@deepseek-ai/dsh-desktop-app/cordis.patch.yml'],
    ['web', 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'],
    ['native', 'node_modules/node-pty/prebuilds/win32-x64/conpty.node'],
  ])('rejects a missing %s runtime resource', async (_kind, relativePath) => {
    const fixture = await completeFixture()
    await unlink(join(fixture.app, ...relativePath.split('/')))
    await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [] })).rejects.toThrow(/required|native/u)
  })

  it('rejects dangling and package-escaping links without following discovery links', async () => {
    const fixture = await completeFixture()
    const dangling = join(fixture.app, 'dangling.yml')
    await symlink('absent.yml', dangling)
    await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [] })).rejects.toThrow(/dangling/u)
    await unlink(dangling)
    await symlink(homedir(), dangling, 'junction')
    await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [] })).rejects.toThrow(/outside|link/u)
  })

  it.runIf(process.platform === 'win32')('rejects a real junction into the repository or pnpm store', async () => {
    const fixture = await completeFixture()
    const target = await mkdtemp(join(tmpdir(), 'dsh-pnpm-store-sentinel-'))
    temporaryRoots.push(target)
    const junction = join(fixture.app, 'node_modules', 'fixture-junction')
    await symlink(target, junction, 'junction')
    await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [target] })).rejects.toThrow(/link|outside/u)
  })

  it('rejects bounded config and manifests containing normalized absolute build roots', async () => {
    const fixture = await completeFixture()
    const forbidden = 'D:\\repo\\deepseek-harness-desktop'
    await ordinary(join(fixture.app, 'config.yml'), 'root: D:/repo/deepseek-harness-desktop/packages\n')
    await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [forbidden] })).rejects.toThrow(/absolute build path/u)
  })

  it.each(['main.js', 'preload.cjs', 'worker.mjs', 'index.html', 'main.js.map'])(
    'rejects an absolute build root embedded in published text %s',
    async (name) => {
      const fixture = await completeFixture()
      const forbidden = 'D:\\repo\\deepseek-harness-desktop'
      await ordinary(join(fixture.app, 'published', name), 'sourceRoot: D:/repo/deepseek-harness-desktop/packages\n')
      await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [forbidden] }))
        .rejects.toThrow(/absolute build path/u)
    },
  )

  it('removes generated bundler region source paths without rewriting runtime text', async () => {
    const fixture = await completeFixture()
    const generated = join(fixture.app, 'published', 'generated.js')
    await ordinary(generated, [
      '\\t//#region \\0dsh-css:D:\\repo\\deepseek-harness-desktop\\source.css',
      'export const value = 1',
      '//#endregion',
      '',
    ].join('\n'))
    await expect(sanitizeBundlerRegionMarkers(fixture.packageRoot)).resolves.toBe(1)
    expect(await readFile(generated, 'utf8')).toBe('export const value = 1\n//#endregion\n')
    await ordinary(generated, 'export const runtimePath = "D:/repo/deepseek-harness-desktop/runtime"\n')
    await expect(sanitizeBundlerRegionMarkers(fixture.packageRoot)).resolves.toBe(0)
    await expect(validatePackage({
      packageRoot: fixture.packageRoot, forbiddenRoots: ['D:\\repo\\deepseek-harness-desktop'],
    })).rejects.toThrow(/absolute build path/u)
  })

  it('fails closed when a scanned manifest exceeds its configured size cap', async () => {
    const fixture = await completeFixture()
    await ordinary(join(fixture.app, 'large.yaml'), 'x'.repeat(33))
    await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [], maxTextBytes: 32 })).rejects.toThrow(/size cap/u)
  })

  it('skips only Electron\'s fixed root license inventory when it exceeds the text cap', async () => {
    const fixture = await completeFixture()
    await ordinary(join(fixture.packageRoot, 'LICENSES.chromium.html'), 'x'.repeat(1025))
    await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [], maxTextBytes: 1024 }))
      .resolves.toMatchObject({ externalLinks: 0 })
  })

  it.each(['binding.node', 'DeepSeek Harness.exe'])('rejects malformed or non-x64 PE binary %s', async (name) => {
    const fixture = await completeFixture()
    const path = name.endsWith('.node')
      ? join(fixture.app, 'node_modules', 'fixture-native', name)
      : join(fixture.packageRoot, name)
    await ordinary(path, Buffer.from('MZ malformed'))
    await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [] })).rejects.toThrow(/PE|x64/u)
  })

  it('rejects missing production dependencies and required peers while allowing optional peers', async () => {
    const fixture = await completeFixture()
    const dshManifest = join(fixture.app, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const dsh = JSON.parse(await readFile(dshManifest, 'utf8')) as { dependencies: Record<string, string> }
    dsh.dependencies.missing = '1.0.0'
    await ordinary(dshManifest, `${JSON.stringify(dsh)}\n`)
    await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [] })).rejects.toThrow(/missing.*dependency/iu)

    delete dsh.dependencies.missing
    await ordinary(dshManifest, `${JSON.stringify(dsh)}\n`)
    const nativeManifest = join(fixture.app, 'node_modules', 'fixture-native', 'package.json')
    const native = JSON.parse(await readFile(nativeManifest, 'utf8')) as { peerDependencies: Record<string, string> }
    native.peerDependencies['required-peer'] = '1.0.0'
    await ordinary(nativeManifest, `${JSON.stringify(native)}\n`)
    await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [] })).rejects.toThrow(/required peer/iu)
  })

  it('rejects package names that can traverse and terminates duplicate cyclic graphs', async () => {
    const fixture = await completeFixture()
    const dshManifest = join(fixture.app, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const dsh = JSON.parse(await readFile(dshManifest, 'utf8')) as { dependencies: Record<string, string> }
    dsh.dependencies['../escape'] = '1.0.0'
    await ordinary(dshManifest, `${JSON.stringify(dsh)}\n`)
    await expect(validatePackage({ packageRoot: fixture.packageRoot, forbiddenRoots: [] })).rejects.toThrow(/package name/u)
  })
})
