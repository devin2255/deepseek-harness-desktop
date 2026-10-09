/** Portable provider lifecycle tests control only the native Windows allocation. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import LocalSubprocessRuntime from '../src/index.ts'
import { createWindowsPty, WindowsPtyAllocationCleanupError, type WindowsPtyProcess } from '../src/windows-pty.ts'
import { nativeProcess } from './windows-terminal-harness.ts'

vi.mock('../src/windows-pty.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/windows-pty.ts')>(), createWindowsPty: vi.fn(),
}))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

const spec = { argv: ['shell'], cwd: process.cwd(), rows: 24, cols: 80, graceMs: 100 }

it('owns Windows terminals and forwards only the scrubbed effective environment', async () => {
  const process = nativeProcess()
  vi.mocked(createWindowsPty).mockResolvedValue(process.native)
  vi.stubEnv('DSH_AMBIENT_TERMINAL_TEST', 'drop')
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  const service = ctx.subprocess as LocalSubprocessRuntime
  service.internals.platform = 'win32'
  try {
    const handle = await service.spawnTerminal({ ...spec, env: { DSH_EXPLICIT_TERMINAL_TEST: 'keep' }, signal: new AbortController().signal })
    const environment = vi.mocked(createWindowsPty).mock.lastCall?.[1]
    expect(environment?.DSH_AMBIENT_TERMINAL_TEST).toBeUndefined()
    expect(environment?.DSH_EXPLICIT_TERMINAL_TEST).toBe('keep')
    process.exit(0)
    process.members(0)
    await handle.done
    await handle.terminate()
  } finally {
    await fiber.dispose()
  }
})

it('aborts and joins unpublished native allocation before service disposal settles', async () => {
  const process = nativeProcess()
  const allocated = Promise.withResolvers<WindowsPtyProcess>()
  vi.mocked(createWindowsPty).mockReturnValue(allocated.promise)
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  const service = ctx.subprocess as LocalSubprocessRuntime
  service.internals.platform = 'win32'
  const spawn = expect(service.spawnTerminal(spec)).rejects.toThrow('disposing')
  const disposed = fiber.dispose()
  await vi.waitFor(() => { expect(vi.mocked(createWindowsPty).mock.lastCall?.[0].signal?.aborted).toBe(true) })
  allocated.resolve(process.native)
  await spawn
  await disposed
  expect(process.native.close).toHaveBeenCalledOnce()
  await expect(service.spawnTerminal(spec)).rejects.toThrow('disposing')
})

it('rejects publication when disposal starts after native allocation resolves', async () => {
  const process = nativeProcess()
  const allocated = Promise.withResolvers<WindowsPtyProcess>()
  vi.mocked(createWindowsPty).mockReturnValue(allocated.promise)
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  const service = ctx.subprocess as LocalSubprocessRuntime
  service.internals.platform = 'win32'
  const rejected = expect(service.spawnTerminal(spec)).rejects.toThrow('disposing')
  // Cordis schedules effect cleanup; target the provider entry to pin the publication race.
  const provider = service as unknown as { disposeManagedProcesses(): Promise<void> }
  const disposed = allocated.promise.then(() => provider.disposeManagedProcesses())
  allocated.resolve(process.native)
  await rejected
  await disposed
  expect(process.native.close).toHaveBeenCalledOnce()
  await fiber.dispose()
})

it('preserves allocation cancellation while retaining failed rollback for disposal', async () => {
  const process = nativeProcess()
  const allocated = Promise.withResolvers<WindowsPtyProcess>()
  vi.mocked(createWindowsPty).mockReturnValue(allocated.promise)
  vi.mocked(process.native.kill).mockImplementationOnce(() => { throw new Error('rollback failed') })
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  const service = ctx.subprocess as LocalSubprocessRuntime
  service.internals.platform = 'win32'
  const controller = new AbortController()
  const reason = new Error('caller canceled')
  const spawn = expect(service.spawnTerminal({ ...spec, signal: controller.signal })).rejects.toBe(reason)
  controller.abort(reason)
  allocated.resolve(process.native)
  await spawn
  expect(process.native.close).not.toHaveBeenCalled()
  await fiber.dispose()
  expect(process.native.kill).toHaveBeenCalledTimes(2)
  expect(process.native.close).toHaveBeenCalledOnce()
})

it.each([false, true])('reports unpublished native rollback failure during disposal: %s', async (duringDisposal) => {
  const allocated = Promise.withResolvers<WindowsPtyProcess>()
  vi.mocked(createWindowsPty).mockReturnValue(allocated.promise)
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  const service = ctx.subprocess as LocalSubprocessRuntime
  service.internals.platform = 'win32'
  const errors: unknown[] = []
  ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof ctx.logger.error
  const controller = new AbortController()
  const reason = new Error('caller canceled')
  const failure = new WindowsPtyAllocationCleanupError(reason, [new Error('native cleanup failed')])
  const rejected = expect(service.spawnTerminal({ ...spec, signal: controller.signal })).rejects.toBe(duringDisposal ? failure : reason)
  const disposed = duringDisposal ? fiber.dispose() : undefined
  if (!duringDisposal) controller.abort(reason)
  allocated.reject(failure)
  await rejected
  await (disposed ?? fiber.dispose())
  expect(errors).toEqual([failure])
})
