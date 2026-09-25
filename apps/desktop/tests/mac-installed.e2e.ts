import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { describe, expect, it } from 'vitest'

const enabled = process.platform === 'darwin' && process.arch === 'arm64'
  && process.env.CI === 'true' && process.env.DSH_MACOS_PACKAGE_E2E === '1'
const sensitiveKey = /KEY|SECRET|TOKEN|PASSWORD/iu
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const packageVersion = (JSON.parse(readFileSync(join(repositoryRoot, 'apps/desktop/package.json'), 'utf8')) as {
  readonly version: string
}).version

describe.skipIf(!enabled)('installed macOS desktop package', () => {
  it('mounts the DMG, copies its application, and reaches authenticated desktop readiness', { timeout: 180_000 }, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-macos-install-'))
    const mount = join(fixture, 'mounted')
    const installed = join(fixture, 'installed', 'DeepSeek Harness.app')
    const executable = join(installed, 'Contents', 'MacOS', 'DeepSeek Harness')
    const dmg = join(repositoryRoot, '.artifacts/desktop/installer', `DeepSeek-Harness-${packageVersion}-mac-arm64.dmg`)
    let attachAttempted = false
    let detached = false
    let application: ElectronApplication | undefined
    let applicationClosed = true
    let operationError: unknown
    const cleanupFailures: unknown[] = []
    try {
      await Promise.all([mkdir(mount), mkdir(join(fixture, 'installed'))])
      attachAttempted = true
      execFileSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], { timeout: 30_000 })
      execFileSync('ditto', [join(mount, 'DeepSeek Harness.app'), installed], { timeout: 60_000 })
      expect((await stat(executable)).isFile()).toBe(true)
      execFileSync('hdiutil', ['detach', mount], { timeout: 30_000 })
      detached = true

      const environment = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => {
        return value === undefined || sensitiveKey.test(key) ? [] : [[key, value]]
      }))
      application = await electron.launch({
        executablePath: executable,
        args: [`--user-data-dir=${join(fixture, 'electron-profile')}`],
        env: { ...environment, DSH_TELEMETRY_DISABLED: '1' },
        timeout: 15_000,
      })
      applicationClosed = false
      const startup = await application.firstWindow({ timeout: 5_000 })
      expect(startup.url()).toMatch(/^file:/u)
      await expect.poll(() => application?.windows().some(page => /^http:\/\/127\.0\.0\.1:\d+\//u.test(page.url())), {
        timeout: 75_000,
      }).toBe(true)
      const main = application.windows().find(page => /^http:\/\/127\.0\.0\.1:\d+\//u.test(page.url()))
      if (main === undefined) throw new Error('installed macOS desktop did not open its authorized window')
      await main.waitForLoadState('load', { timeout: 10_000 })
      const result = await main.evaluate(async () => {
        const response = await fetch('/api/host.describe', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          signal: AbortSignal.timeout(10_000),
        })
        return { status: response.status, body: await response.json() as unknown, title: document.title }
      })
      expect(result.status).toBe(200)
      expect(result.title).toBe('DeepSeek Harness')
      expect(result.body).toHaveProperty('result')
      const unauthorized = await fetch(new URL('/api/host.describe', main.url()), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(10_000),
      })
      expect(unauthorized.status).toBe(401)
    } catch (error: unknown) {
      operationError = error
    } finally {
      if (application !== undefined) {
        let closeTimer: ReturnType<typeof setTimeout> | undefined
        try {
          await application.evaluate(({ app }) => { app.quit() }).catch(() => {})
          await Promise.race([
            application.close(),
            new Promise<never>((_resolve, reject) => {
              closeTimer = setTimeout(() => { reject(new Error('installed macOS application did not close within 15s')) }, 15_000)
            }),
          ])
          applicationClosed = true
        } catch (error: unknown) { cleanupFailures.push(error) } finally {
          if (closeTimer !== undefined) clearTimeout(closeTimer)
        }
      }
      if (attachAttempted && !detached) {
        try {
          execFileSync('hdiutil', ['detach', mount], { timeout: 30_000 })
          detached = true
        } catch (error: unknown) { cleanupFailures.push(error) }
      }
      if ((!attachAttempted || detached) && applicationClosed) {
        await rm(fixture, { recursive: true, force: true }).catch((error: unknown) => cleanupFailures.push(error))
      }
      if (cleanupFailures.length > 0) {
        if (operationError !== undefined) cleanupFailures.unshift(operationError)
        throw new AggregateError(cleanupFailures, 'macOS installed-package cleanup failed')
      }
    }
    if (operationError !== undefined) throw operationError
  })
})
