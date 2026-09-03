import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawn as spawnProcess } from 'node:child_process'

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn<typeof spawnProcess>(() => ({} as ReturnType<typeof spawnProcess>)),
}))

vi.mock('node:child_process', () => ({ spawn }))

import { spawnDialogWorker } from '../src/win32-dialog-host.ts'

describe('spawnDialogWorker', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    spawn.mockClear()
  })

  it('forces the packaged Electron executable to run the dialog child as Node', () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '0')

    spawnDialogWorker({ title: 'Pick a directory' })

    const [, , options] = spawn.mock.calls[0]!
    expect(options?.env).toMatchObject({
      DSH_DIALOG_TITLE: 'Pick a directory',
      ELECTRON_RUN_AS_NODE: '1',
    })
  })
})
