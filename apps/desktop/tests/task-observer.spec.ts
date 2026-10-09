import { afterEach, expect, it, vi } from 'vitest'
import { createTaskObserver, type TaskObserver, type TaskObserverState } from '../src/task-observer.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function requestFrom(init?: RequestInit): { method: 'task.list' | 'session.list'; rpcId: string } {
  if (typeof init?.body !== 'string') throw new Error('fixture expected a JSON request body')
  const value: unknown = JSON.parse(init.body)
  if (typeof value !== 'object' || value === null || !('method' in value) || !('rpcId' in value)
    || (value.method !== 'task.list' && value.method !== 'session.list') || typeof value.rpcId !== 'string') {
    throw new Error('fixture received an invalid API request')
  }
  return { method: value.method, rpcId: value.rpcId }
}

it('authenticates both list baselines and silently counts running descendants', async () => {
  vi.useFakeTimers()
  const states: unknown[] = []
  const fetch = vi.fn(async (_url: URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private')
    const request = requestFrom(init)
    const value = request.method === 'task.list'
      ? { generation: 1, tasks: [{ taskId: 'root', descendantSessionIds: ['child'], status: 'needs-attention', freshness: 'live', attention: [], risks: [], updatedAt: 1, asOfSeq: 1 }] }
      : { items: [{ sessionId: 'root', running: false, blank: false, updatedAt: 1 }, { sessionId: 'child', running: true, blank: false, updatedAt: 1 }] }
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } })
  })
  const observer = createTaskObserver({
    endpoint: new URL('http://127.0.0.1:1234'), capability: 'private', pollIntervalMs: 100,
    requestTimeoutMs: 1000, fetch, onState: (state) => { states.push(state) }, reportError: (error) => { throw error },
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(states).toEqual([{ activeTaskCount: 1, activeAgentCount: 1, attentionCount: 0, notifications: [], freshness: 'live' }])
  expect(fetch).toHaveBeenCalledTimes(2)
  await observer.dispose()
})

function fixture() {
  const states: TaskObserverState[] = []
  const errors: unknown[] = []
  type FixtureAttention = {
    id: string
    taskId: string
    ownerSessionId: string
    kind: string
    severity: string
    summary: string
    createdAt: number
    sourceId: string
    actionable: boolean
  }
  let task = {
    taskId: 'root', descendantSessionIds: ['child'], status: 'running', freshness: 'live',
    attention: [] as FixtureAttention[], risks: [], updatedAt: 1, asOfSeq: 1,
    definition: undefined as { goal: string; criteria: never[] } | undefined,
  }
  let running = true
  let failure = false
  let malformed = false
  let generation = 1
  let present = true
  let failedMethod: 'task.list' | 'session.list' | undefined
  const fetch = vi.fn(async (_url: URL, init?: RequestInit) => {
    if (failure) throw new Error('offline')
    const request = requestFrom(init)
    if (request.method === failedMethod) {
      return Response.json({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: false, error: { code: 'internal', message: 'denied', details: {} } },
      })
    }
    const value = request.method === 'task.list' ? { generation, tasks: present ? [task] : [] }
      : { items: [{ sessionId: 'root', running: false, blank: false, updatedAt: 1 }, { sessionId: 'child', running, blank: false, updatedAt: 1 }] }
    return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: malformed ? {} : value } })
  })
  const options = {
    endpoint: new URL('http://127.0.0.1:1234'), capability: 'private', pollIntervalMs: 100, requestTimeoutMs: 1000, fetch,
    onState: (state: TaskObserverState) => states.push(state), reportError: (error: unknown) => errors.push(error),
  }
  return {
    options, states, errors, fetch, task: () => task,
    setGeneration: (value: number) => { generation = value },
    setTask: (value: typeof task) => { task = value },
    setRunning: (value: boolean) => { running = value },
    setFailure: (value: boolean) => { failure = value },
    setMalformed: (value: boolean) => { malformed = value },
    setPresent: (value: boolean) => { present = value },
    setFailedMethod: (value: typeof failedMethod) => { failedMethod = value },
  }
}

it('notifies new actionable ids once, retains them through failures, and detects completion and failure transitions', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const observer = createTaskObserver(f.options)
  await vi.advanceTimersByTimeAsync(0)
  f.task().attention.push({ id: 'ask', taskId: 'root', ownerSessionId: 'child', kind: 'question', severity: 'info', summary: 'Need answer', createdAt: 1, sourceId: 'question', actionable: true })
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications.map(item => item.kind)).toEqual(['attention'])
  expect(Object.isFrozen(f.states.at(-1)?.notifications[0])).toBe(true)
  f.setFailure(true)
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)).toMatchObject({ activeTaskCount: 1, activeAgentCount: 1, freshness: 'unavailable', notifications: [] })
  f.setFailure(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications).toEqual([])
  f.task().status = 'ready'
  f.task().asOfSeq++
  f.setRunning(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications.map(item => item.kind)).toEqual(['complete'])
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications).toEqual([])
  f.task().status = 'failed'
  f.task().asOfSeq++
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications.map(item => item.kind)).toEqual(['failed'])
  await observer.dispose()
})

it('notifies repeated descendant transitions when the root sequence is unchanged', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const observer = createTaskObserver(f.options)
  await vi.advanceTimersByTimeAsync(0)

  f.task().status = 'settled'
  f.setRunning(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications.map(item => item.kind)).toEqual(['complete'])

  f.task().status = 'running'
  f.setRunning(true)
  await vi.advanceTimersByTimeAsync(100)
  f.task().status = 'settled'
  f.setRunning(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications.map(item => item.kind)).toEqual(['complete'])

  f.task().status = 'running'
  await vi.advanceTimersByTimeAsync(100)
  f.task().status = 'failed'
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications.map(item => item.kind)).toEqual(['failed'])
  f.task().status = 'running'
  await vi.advanceTimersByTimeAsync(100)
  f.task().status = 'failed'
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications.map(item => item.kind)).toEqual(['failed'])
  expect(f.task().asOfSeq).toBe(1)
  await observer.dispose()
})

it('routes a failed transition to the descendant named by the failure projection', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const observer = createTaskObserver(f.options)
  await vi.advanceTimersByTimeAsync(0)
  f.task().attention.push({
    id: 'child-failure', taskId: 'root', ownerSessionId: 'child', kind: 'run-failure', severity: 'error',
    summary: 'Child command failed', createdAt: 2, sourceId: 'turn:2', actionable: false,
  })
  f.task().status = 'failed'
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications).toMatchObject([{
    kind: 'failed', taskId: 'root', ownerSessionId: 'child', body: 'Child command failed',
  }])
  await observer.dispose()
})

it('rejects malformed responses using shared schemas and recovers without an initial notification', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.setMalformed(true)
  const observer = createTaskObserver(f.options)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.states.at(-1)?.freshness).toBe('unavailable')
  expect(f.errors).toHaveLength(1)
  f.setMalformed(false)
  f.task().status = 'failed'
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications).toEqual([])
  await observer.dispose()
})

it('continues polling after a state callback throws', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const onState = vi.fn(() => { throw new Error('callback') })
  const observer = createTaskObserver({ ...f.options, onState })
  await vi.advanceTimersByTimeAsync(200)
  expect(onState).toHaveBeenCalledTimes(3)
  expect(f.errors).toHaveLength(3)
  await observer.dispose()
})

it('never overlaps polls and joins an aborted in-flight request without late callbacks', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const fetch = vi.fn((_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('fixture request aborted'))
    }, { once: true })
  }))
  const observer = createTaskObserver({ ...f.options, fetch })
  await vi.advanceTimersByTimeAsync(500)
  expect(fetch).toHaveBeenCalledTimes(1)
  await observer.dispose()
  await vi.advanceTimersByTimeAsync(500)
  expect(f.states).toEqual([])
  expect(f.errors).toEqual([])
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('applies the configured request timeout and reports an unavailable baseline', async () => {
  const f = fixture()
  const fetch = vi.fn((_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('fixture request timed out'))
    }, { once: true })
  }))
  const observer = createTaskObserver({ ...f.options, fetch, requestTimeoutMs: 10 })
  await vi.waitFor(() => { expect(f.errors).toHaveLength(1) })
  expect(f.states.at(-1)?.freshness).toBe('unavailable')
  await observer.dispose()
})

it('keeps non-live row observations and counts actual running sessions without synthesizing completion', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const observer = createTaskObserver(f.options)
  await vi.advanceTimersByTimeAsync(0)
  f.task().freshness = 'unavailable'
  f.task().status = 'ready'
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)).toMatchObject({ freshness: 'unavailable', activeTaskCount: 1, notifications: [] })
  f.task().freshness = 'live'
  f.setRunning(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications.map(item => item.kind)).toEqual(['complete'])
  await observer.dispose()
})

it('silently establishes the first live observation after a non-live row', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.task().freshness = 'unavailable'
  f.task().status = 'failed'
  const observer = createTaskObserver(f.options)
  await vi.advanceTimersByTimeAsync(0)
  f.task().freshness = 'live'
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications).toEqual([])
  await observer.dispose()
})

it('rejects invalid timing configuration before requesting', () => {
  const f = fixture()
  expect(() => createTaskObserver({ ...f.options, pollIntervalMs: 0 })).toThrow('positive')
  expect(() => createTaskObserver({ ...f.options, requestTimeoutMs: Infinity })).toThrow('positive')
  expect(f.fetch).not.toHaveBeenCalled()
})

it('silently establishes a new generation instead of comparing prior activity', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const observer = createTaskObserver(f.options)
  await vi.advanceTimersByTimeAsync(0)
  f.setGeneration(2)
  f.setRunning(false)
  f.task().status = 'ready'
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications).toEqual([])
  await observer.dispose()
})

it('uses the platform fetch when no transport override is supplied', async () => {
  vi.useFakeTimers()
  const f = fixture()
  vi.stubGlobal('fetch', f.fetch)
  const { fetch: _fetch, ...options } = f.options
  const observer = createTaskObserver(options)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.fetch).toHaveBeenCalledTimes(2)
  await observer.dispose()
})

it('reports task and session protocol failures even when the reporter throws', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const reporter = vi.fn(() => { throw new Error('reporter') })
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  f.setFailedMethod('task.list')
  const observer = createTaskObserver({ ...f.options, reportError: reporter })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.states.at(-1)?.freshness).toBe('unavailable')
  f.setFailedMethod('session.list')
  await vi.advanceTimersByTimeAsync(100)
  expect(reporter).toHaveBeenCalledTimes(2)
  expect(consoleError).toHaveBeenCalledTimes(2)
  await observer.dispose()
})

it('suppresses reporter and state callbacks once either callback starts disposal', async () => {
  vi.useFakeTimers()
  const fromState = fixture()
  const stateOwner: { observer?: TaskObserver } = {}
  let stateDisposal: Promise<void> | undefined
  const stateReporter = vi.fn()
  stateOwner.observer = createTaskObserver({
    ...fromState.options,
    onState: () => {
      stateDisposal = stateOwner.observer?.dispose()
      throw new Error('callback after disposal')
    },
    reportError: stateReporter,
  })
  await vi.advanceTimersByTimeAsync(0)
  await stateDisposal
  expect(stateReporter).not.toHaveBeenCalled()

  const fromReporter = fixture()
  fromReporter.setFailedMethod('task.list')
  const reportOwner: { observer?: TaskObserver } = {}
  let reportDisposal: Promise<void> | undefined
  reportOwner.observer = createTaskObserver({
    ...fromReporter.options,
    reportError: () => { reportDisposal = reportOwner.observer?.dispose() },
  })
  await vi.advanceTimersByTimeAsync(0)
  await reportDisposal
  expect(fromReporter.states).toEqual([])
})

it('joins a response that settles after disposal without publishing it', async () => {
  let resolveSession: ((response: Response) => void) | undefined
  const states: TaskObserverState[] = []
  const errors: unknown[] = []
  const fetch = vi.fn(async (_url: URL, init?: RequestInit) => {
    const request = requestFrom(init)
    if (request.method === 'task.list') {
      return Response.json({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: true, value: { generation: 1, tasks: [] } },
      })
    }
    return new Promise<Response>((resolve) => {
      resolveSession = resolve
    })
  })
  const observer = createTaskObserver({
    endpoint: new URL('http://127.0.0.1:1234'), capability: 'private', pollIntervalMs: 100,
    requestTimeoutMs: 1000, fetch,
    onState: (state) => { states.push(state) },
    reportError: (error) => { errors.push(error) },
  })
  await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(2) })
  const disposal = observer.dispose()
  const request = requestFrom(fetch.mock.calls[1]?.[1])
  resolveSession?.(Response.json({
    type: 'server-response', rpcId: request.rpcId,
    result: { ok: true, value: { items: [] } },
  }))
  await disposal
  expect(states).toEqual([])
  expect(errors).toEqual([])
})

it('does not start the session request when disposal begins during the task request', async () => {
  let resolveTasks: ((response: Response) => void) | undefined
  let taskRequest: ReturnType<typeof requestFrom> | undefined
  const f = fixture()
  const fetch = vi.fn(async (_url: URL, init?: RequestInit) => {
    const request = requestFrom(init)
    if (request.method === 'task.list') {
      taskRequest = request
      return new Promise<Response>((resolve) => { resolveTasks = resolve })
    }
    return Response.json({
      type: 'server-response', rpcId: request.rpcId,
      result: { ok: true, value: { items: [] } },
    })
  })
  const observer = createTaskObserver({ ...f.options, fetch })
  await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1) })
  const disposal = observer.dispose()
  resolveTasks?.(Response.json({
    type: 'server-response', rpcId: taskRequest?.rpcId,
    result: { ok: true, value: { generation: 1, tasks: [] } },
  }))
  await disposal
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(f.states).toEqual([])
  expect(f.errors).toEqual([])
})

it('prunes absent task history and filters invalid attention before a settled completion', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.task().definition = { goal: 'Ship release', criteria: [] }
  f.task().attention.push(
    { id: 'ask', taskId: 'root', ownerSessionId: 'child', kind: 'question', severity: 'info', summary: 'Need answer', createdAt: 1, sourceId: 'question', actionable: true },
    { id: 'info', taskId: 'root', ownerSessionId: 'child', kind: 'question', severity: 'info', summary: 'FYI', createdAt: 1, sourceId: 'question', actionable: false },
    { id: 'wrong-task', taskId: 'other', ownerSessionId: 'child', kind: 'question', severity: 'info', summary: 'Wrong task', createdAt: 1, sourceId: 'question', actionable: true },
    { id: 'wrong-owner', taskId: 'root', ownerSessionId: 'other', kind: 'question', severity: 'info', summary: 'Wrong owner', createdAt: 1, sourceId: 'question', actionable: true },
  )
  const observer = createTaskObserver(f.options)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.states.at(-1)).toMatchObject({ attentionCount: 1, notifications: [] })

  f.setPresent(false)
  await vi.advanceTimersByTimeAsync(100)
  f.setPresent(true)
  f.task().freshness = 'unavailable'
  f.task().status = 'failed'
  await vi.advanceTimersByTimeAsync(100)
  f.setPresent(false)
  await vi.advanceTimersByTimeAsync(100)
  f.setPresent(true)
  f.task().freshness = 'live'
  f.task().asOfSeq++
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications.map(item => [item.kind, item.title])).toEqual([
    ['attention', 'Ship release'],
    ['failed', 'Ship release'],
  ])

  f.task().status = 'settled'
  f.task().asOfSeq++
  f.setRunning(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(f.states.at(-1)?.notifications.map(item => item.kind)).toEqual(['complete'])
  await observer.dispose()
})
