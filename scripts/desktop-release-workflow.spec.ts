import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  readonly id?: string
  readonly uses?: string
  readonly run?: string
  readonly env?: Record<string, string>
  readonly with?: Record<string, unknown>
}

interface Workflow {
  readonly on: { readonly workflow_dispatch: { readonly inputs: Record<string, unknown> } }
  readonly permissions: Record<string, string>
  readonly jobs: Record<string, {
    readonly if: string
    readonly environment: string
    readonly permissions: Record<string, string>
    readonly 'runs-on': string
    readonly steps: readonly Step[]
  }>
}

const root = resolve(import.meta.dirname, '..')
const subject = yaml.load(readFileSync(resolve(root, '.github/workflows/desktop-release.yml'), 'utf8')) as Workflow
const steps = subject.jobs.release?.steps ?? []

function step(id: string): Step {
  const found = steps.find(item => item.id === id)
  if (found === undefined) throw new Error(`Missing desktop release workflow step: ${id}`)
  return found
}

describe('desktop production release workflow', () => {
  it('requires an explicit protected manual publication decision', () => {
    expect(subject.on.workflow_dispatch.inputs.publish).toEqual({
      description: 'Publish a signed Windows installer from the selected dsh-v* tag.',
      required: true,
      type: 'boolean',
      default: false,
    })
    expect(subject.permissions).toEqual({ contents: 'read' })
    expect(subject.jobs.release).toMatchObject({
      if: 'inputs.publish',
      environment: 'desktop-release',
      'runs-on': 'windows-2025',
      permissions: {
        contents: 'write', 'id-token': 'write', attestations: 'write', 'artifact-metadata': 'write',
      },
    })
  })

  it('keeps signing credentials in the package step and rejects untagged or divergent releases', () => {
    expect(step('package').env).toEqual({
      WIN_CSC_LINK: '${{ secrets.WIN_CSC_LINK }}',
      WIN_CSC_KEY_PASSWORD: '${{ secrets.WIN_CSC_KEY_PASSWORD }}',
    })
    expect(step('ref').run).toMatch(/GITHUB_REF_TYPE[\s\S]*GITHUB_REF_NAME[\s\S]*dsh-v\$version[\s\S]*merge-base --is-ancestor HEAD origin\/master/u)
    const serialized = JSON.stringify(subject)
    expect(serialized.match(/secrets\./gu)).toHaveLength(2)
    expect(serialized).not.toMatch(/pull_request|push/u)
  })

  it('qualifies the signed artifact before attestation and publication', () => {
    expect(steps.filter(item => item.id !== undefined).map(item => item.id)).toEqual([
      'ref', 'build', 'package', 'validate', 'production', 'matrix', 'final', 'attest', 'upload', 'publish',
    ])
    expect(step('production').run).toBe('node --import tsx/esm scripts/desktop/verify-production-release.ts')
    expect(step('matrix')).toMatchObject({
      env: { DSH_INSTALLER_E2E: '1' },
      run: 'node node_modules/vitest/vitest.mjs run --config vitest.desktop-installer.config.ts',
    })
    expect(step('final').run).toBe('node --import tsx/esm scripts/desktop/verify-production-release.ts')
    expect(step('attest')).toMatchObject({
      uses: 'actions/attest@v4',
      with: { 'subject-path': '.artifacts/desktop/installer/DeepSeek-Harness-Setup-*-x64.exe' },
    })
    expect(step('publish').run).toMatch(/gh @arguments[\s\S]*GitHub Release publication failed/u)
  })
})
