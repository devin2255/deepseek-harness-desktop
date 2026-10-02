import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  readonly id?: string
  readonly uses?: string
  readonly if?: string
  readonly run?: string
  readonly with?: Record<string, unknown>
  readonly env?: Record<string, string>
}

interface Workflow {
  readonly on: Record<string, unknown>
  readonly permissions: Record<string, string>
  readonly env: Record<string, string>
  readonly jobs: Record<string, {
    readonly 'runs-on': string
    readonly defaults: { readonly run: { readonly shell: string } }
    readonly steps: readonly Step[]
  }>
}

const root = resolve(import.meta.dirname, '..')
const installerVitest = 'node node_modules/vitest/vitest.mjs run --config vitest.desktop-installer.config.ts'

function workflow(): Workflow {
  return yaml.load(readFileSync(resolve(root, '.github/workflows/desktop-installer.yml'), 'utf8')) as Workflow
}

function step(id: string): Step {
  const found = workflow().jobs.installer?.steps.find(item => item.id === id)
  if (found === undefined) throw new Error(`Missing installer workflow step: ${id}`)
  return found
}

describe('desktop installer workflow', () => {
  it('prevents script startup from rewriting the workspace dependency mode', () => {
    const workspace = yaml.load(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8')) as {
      readonly verifyDepsBeforeRun?: boolean
    }
    expect(workspace.verifyDepsBeforeRun).toBe(false)
  })

  it('runs unprivileged on pull requests, master, and release tags under hosted native PowerShell', () => {
    const subject = workflow()
    expect(subject.on).toEqual({ pull_request: null, push: { branches: ['master'], tags: ['dsh-v*', 'v*'] } })
    expect(subject.permissions).toEqual({ contents: 'read' })
    expect(subject.jobs.installer).toMatchObject({
      'runs-on': 'windows-2025',
      defaults: { run: { shell: 'pwsh' } },
    })
    expect(subject.env).toMatchObject({ DSH_TELEMETRY_DISABLED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
    expect(JSON.stringify(subject)).not.toMatch(/secrets\s*[.[]/u)
    expect(subject.jobs.installer?.steps.find(item => item.uses?.startsWith('actions/checkout@'))?.with)
      .toMatchObject({ 'persist-credentials': false })
    expect(subject.jobs.installer?.steps.find(item => item.uses?.startsWith('pnpm/action-setup@'))?.with)
      .toMatchObject({ dest: '${{ runner.temp }}/setup-pnpm' })
  })

  it('builds and validates before running the complete installer suite on every event', () => {
    const steps = workflow().jobs.installer?.steps ?? []
    expect(steps.filter(item => item.id !== undefined).map(item => item.id)).toEqual([
      'build', 'package', 'validate', 'matrix', 'upload',
    ])
    expect(step('build').run).toBe('pnpm run build')
    expect(step('package').run).toBe('pnpm run desktop:package')
    expect(step('validate').run).toBe('node --import tsx/esm scripts/desktop/validate-package.ts')
    expect(step('matrix')).toMatchObject({
      env: { DSH_INSTALLER_E2E: '1' },
      run: installerVitest,
    })
    expect(step('matrix').if).toBeUndefined()
  })

  it('retains only validated installer release files even when a later smoke fails', () => {
    expect(step('upload')).toMatchObject({
      uses: 'actions/upload-artifact@v4',
      if: "${{ !cancelled() && steps.validate.outcome == 'success' }}",
      with: {
        path: '.artifacts/desktop/installer/*.exe\n.artifacts/desktop/installer/*.exe.sha256\n.artifacts/desktop/installer/latest.yml\n.artifacts/desktop/installer/release-metadata.json\n',
        'if-no-files-found': 'error',
        'include-hidden-files': true,
        'retention-days': 30,
      },
    })
  })

  it.skipIf(process.platform !== 'win32')('passes the matrix selection intact through native PowerShell', () => {
    // Capture arguments without invoking Node or mutating the installed application.
    const command = `function node { ConvertTo-Json -InputObject @($args) -Compress }; ${step('matrix').run}`
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual([
      'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.desktop-installer.config.ts',
    ])
  })
})
