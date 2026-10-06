// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { RequestView } from '@deepseek-ai/dsh-client-runtime/client'
import { HarnessStudio, latestRecordedRequest, type HarnessStudioProps } from '../src/client/HarnessStudio.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const prompt = {
  config: { provider: 'deepseek', model: 'deepseek-chat' },
  system: 'Be precise.',
  tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
}

function request(startSeq: number, purpose: 'assistant' | 'compaction' = 'assistant'): RequestView {
  return purpose === 'assistant'
    ? { purpose, startSeq, startedAt: 1, completedAt: 2, status: 'complete', turn: 1, step: startSeq, prompt }
    : { purpose, startSeq, startedAt: 2, completedAt: 3, status: 'complete', turn: 1, step: 0 }
}

function props(active = true, selected = true): HarnessStudioProps {
  const trajectory = { requests: [request(1), request(2, 'compaction')], eventNodes: [
    { kind: 'assistant', seq: 4, time: 1_750_000_000_000 },
  ] }
  return {
    active, sessionId: selected ? 'root' as never : undefined,
    useSessions: selector => selector({ byId: { root: { displayTitle: 'Task A', agentPreset: 'standard' } } } as never),
    useSession: selector => selected ? selector({} as never) : undefined,
    useProjection: () => undefined,
    useWorkspaces: (() => undefined) as never,
    useInput: () => undefined,
    inputActions: undefined,
    inspect: () => trajectory as never,
    listPlugins: vi.fn(async () => ({ entries: [
      { entryId: 'plugin-1' as never, moduleName: '@deepseek-ai/dsh-tools', enabled: true, fiberPhase: 'active' as const },
    ] })),
    readComposition: vi.fn(async () => ({
      composition: { agentPreset: 'standard', entries: [
        { entryId: 'preset-1', moduleName: 'preset-tool', enabled: true },
        { entryId: 'preset-2', moduleName: 'preset-disabled', enabled: false },
      ] },
      seq: 0,
    })),
    back: vi.fn(),
    t: ((key: keyof typeof en) => en[key]) as HarnessStudioProps['t'],
  }
}

describe('Harness Studio', () => {
  it('selects the last recorded ordinary request, not a later compaction', () => {
    expect(latestRecordedRequest([request(1), request(2, 'compaction')])?.startSeq).toBe(1)
    expect(latestRecordedRequest([])).toBeUndefined()
  })

  it('shows task-logged route, tools and events separately from current Host plugins', async () => {
    const p = props()
    const view = render(<HarnessStudio {...p} />)
    expect(view.getByText('standard')).toBeTruthy()
    expect(view.getByText('deepseek / deepseek-chat')).toBeTruthy()
    expect(view.getByText('read_file')).toBeTruthy()
    expect(view.getByText('Be precise.')).toBeTruthy()
    expect(view.getByText('#4')).toBeTruthy()
    await waitFor(() => { expect(view.getByText('@deepseek-ai/dsh-tools')).toBeTruthy() })
    await waitFor(() => { expect(view.getByText('preset-tool')).toBeTruthy() })
    expect(view.getByText('preset-disabled')).toBeTruthy()
    expect(view.getByText(/current Loader inventory/)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Back to task' }))
    expect(p.back).toHaveBeenCalledOnce()
  })

  it('does not query Host plugins before Studio opens or without a selected task', () => {
    const hidden = props(false)
    const first = render(<HarnessStudio {...hidden} />)
    expect(hidden.listPlugins).not.toHaveBeenCalled()
    expect(hidden.readComposition).not.toHaveBeenCalled()
    first.unmount()
    const empty = props(true, false)
    const second = render(<HarnessStudio {...empty} />)
    expect(second.getByText('Select a task from the overview first.')).toBeTruthy()
    expect(empty.listPlugins).not.toHaveBeenCalled()
    expect(empty.readComposition).not.toHaveBeenCalled()
  })

  it('labels missing recorded facts and an empty current Host inventory', async () => {
    const p = props()
    p.useSessions = selector => selector({ byId: {} } as never)
    p.inspect = () => undefined
    p.listPlugins = vi.fn(async () => ({ entries: [] }))
    p.readComposition = vi.fn(async () => ({ composition: null, seq: null }))
    const view = render(<HarnessStudio {...p} />)
    expect(view.getByText('No preset recorded for this session')).toBeTruthy()
    expect(view.getByText('No model request recorded yet')).toBeTruthy()
    expect(view.getByText('No tools sent in the latest request')).toBeTruthy()
    expect(view.getByText('No system prompt in the latest request')).toBeTruthy()
    expect(view.getByText('No events in the loaded window')).toBeTruthy()
    await waitFor(() => { expect(view.getByText('No plugin entries')).toBeTruthy() })
    expect(view.getByText('No preset plugin snapshot was recorded for this session')).toBeTruthy()
  })

  it('distinguishes disabled and unobserved current Host plugin entries', async () => {
    const p = props()
    p.listPlugins = vi.fn(async () => ({ entries: [
      { entryId: 'disabled' as never, moduleName: 'disabled-plugin', enabled: false, fiberPhase: null },
      { entryId: 'unobserved' as never, moduleName: 'unobserved-plugin', enabled: true, fiberPhase: null },
    ] }))
    const view = render(<HarnessStudio {...p} />)
    await waitFor(() => { expect(view.getByText('unobserved-plugin')).toBeTruthy() })
    expect(view.getByText('disabled-plugin')).toBeTruthy()
    expect(view.getByText('No observed runtime state')).toBeTruthy()
  })

  it('ignores inventory results and errors after the page unmounts', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const p = props()
      let settle!: (value?: never) => void
      p.listPlugins = vi.fn(() => new Promise<Awaited<ReturnType<HarnessStudioProps['listPlugins']>>>((resolve, reject) => {
        settle = outcome === 'resolve' ? () => { resolve({ entries: [] }) } : () => { reject(new Error('offline')) }
      }))
      const view = render(<HarnessStudio {...p} />)
      expect(p.listPlugins).toHaveBeenCalledOnce()
      view.unmount()
      settle()
      await Promise.resolve()
    }
  })

  it('allows retry after a plugin inventory failure without hiding recorded facts', async () => {
    const p = props()
    p.listPlugins = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ entries: [] })
    const view = render(<HarnessStudio {...p} />)
    await waitFor(() => { expect(view.getByRole('alert')).toBeTruthy() })
    expect(view.getByText('deepseek / deepseek-chat')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(view.getByText('No plugin entries')).toBeTruthy() })
    expect(p.listPlugins).toHaveBeenCalledTimes(2)
  })

  it('retries a failed task composition read and distinguishes an empty recorded preset', async () => {
    const p = props()
    p.readComposition = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      composition: { agentPreset: 'standard', entries: [] }, seq: 5,
    })
    const view = render(<HarnessStudio {...p} />)
    await waitFor(() => { expect(view.getByText(/Could not read the task plugin record/)).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(view.getByText('This preset mounted no plugin entries')).toBeTruthy() })
    expect(p.readComposition).toHaveBeenCalledTimes(2)
  })

  it('ignores composition results and errors after the page unmounts', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const p = props()
      let settle!: () => void
      p.readComposition = vi.fn(() => new Promise<Awaited<ReturnType<HarnessStudioProps['readComposition']>>>((resolve, reject) => {
        settle = outcome === 'resolve'
          ? () => { resolve({ composition: null, seq: null }) }
          : () => { reject(new Error('offline')) }
      }))
      const view = render(<HarnessStudio {...p} />)
      expect(p.readComposition).toHaveBeenCalledOnce()
      view.unmount()
      settle()
      await Promise.resolve()
    }
  })
})
