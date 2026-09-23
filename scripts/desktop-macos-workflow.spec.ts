import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly env?: Record<string, string>
  readonly with?: Record<string, unknown>
}

interface Workflow {
  readonly on: Record<string, unknown>
  readonly permissions: Record<string, string>
  readonly env: Record<string, string>
  readonly jobs: Record<string, {
    readonly 'runs-on': string
    readonly steps: readonly Step[]
  }>
}

const root = resolve(import.meta.dirname, '..')

function workflow(): Workflow {
  return yaml.load(readFileSync(resolve(root, '.github/workflows/desktop-macos.yml'), 'utf8')) as Workflow
}

describe('desktop macOS smoke workflow', () => {
  it('runs on Apple Silicon without release credentials or write permissions', () => {
    const subject = workflow()
    expect(subject.on).toEqual({ pull_request: null, push: { branches: ['master'], tags: ['dsh-v*'] } })
    expect(subject.permissions).toEqual({ contents: 'read' })
    expect(subject.env).toEqual({ DSH_TELEMETRY_DISABLED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
    expect(subject.jobs.desktop?.['runs-on']).toBe('macos-15')
    expect(JSON.stringify(subject)).not.toMatch(/secrets\s*[.[]/u)
    expect(subject.jobs.desktop?.steps.find(item => item.uses?.startsWith('actions/checkout@'))?.with)
      .toMatchObject({ 'persist-credentials': false })
  })

  it('builds and exercises the real desktop entry after confirming arm64', () => {
    const steps = workflow().jobs.desktop?.steps ?? []
    expect(steps.filter(item => item.run !== undefined).map(item => [item.name, item.run])).toEqual([
      ['Require Apple Silicon runner', 'test "$(uname -m)" = arm64'],
      ['Install (immutable)', 'pnpm install --frozen-lockfile'],
      ['Build workspace artifacts', 'pnpm run build'],
      ['Exercise desktop entry and windows', 'pnpm run test:desktop:e2e:ci'],
      ['Build unsigned DMG and ZIP', 'pnpm run desktop:package:macos:unsigned'],
      ['Install and launch the DMG application',
        'pnpm exec vitest run --config vitest.desktop-e2e.config.ts apps/desktop/tests/mac-installed.e2e.ts'],
    ])
    expect(steps.find(item => item.name === 'Install and launch the DMG application')?.env)
      .toMatchObject({ DSH_MACOS_PACKAGE_E2E: '1' })
    expect(steps.find(item => item.uses?.startsWith('actions/setup-node@'))?.with)
      .toMatchObject({ 'node-version': '24', cache: 'pnpm' })
  })

  it('retains only Mac test archives after the package check succeeds', () => {
    const steps = workflow().jobs.desktop?.steps ?? []
    const uploadIndex = steps.findIndex(item => item.uses?.startsWith('actions/upload-artifact@'))
    const upload = steps[uploadIndex]
    expect(uploadIndex).toBeGreaterThan(steps.findIndex(item => item.name === 'Install and launch the DMG application'))
    expect(upload?.with).toMatchObject({ 'if-no-files-found': 'error', 'retention-days': 30 })
    expect(upload?.with?.path).toContain('.artifacts/desktop/installer/*.dmg')
    expect(upload?.with?.path).toContain('.artifacts/desktop/installer/*.zip')
  })
})
