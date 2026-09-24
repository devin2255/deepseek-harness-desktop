/** Read-only desktop activity from authenticated Host baselines. */
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TaskSnapshot } from '@deepseek-ai/dsh-task/types'

/** Notification with authoritative navigation targets. */
interface TaskNotification {
  readonly key: string
  readonly kind: 'attention' | 'complete' | 'failed'
  readonly taskId: SessionId
  readonly ownerSessionId: SessionId
  readonly title: string
  readonly body: string
}
/** Frozen aggregate; request failure retains the last known counts. */
export interface TaskObserverState {
  readonly activeTaskCount: number
  readonly activeAgentCount: number
  readonly attentionCount: number
  readonly notifications: readonly TaskNotification[]
  readonly freshness: 'live' | 'unavailable'
}
/** Settled runtime and explicit observation policy. */
export interface TaskObserverOptions {
  readonly endpoint: URL
  readonly capability: string
  readonly pollIntervalMs: number
  readonly requestTimeoutMs: number
  readonly fetch?: (input: URL, init?: RequestInit) => Promise<Response>
  readonly onState: (state: TaskObserverState) => void
  readonly reportError: (error: unknown) => void
}
/** Owns polling and asynchronous request disposal. */
export interface TaskObserver {
  /** Stop callbacks, abort requests, and await quiescence. */
  dispose(): Promise<void>
}
class ObserverApiClient extends AbstractApiClient {
  private readonly origin: string
  constructor(private readonly options: TaskObserverOptions) { super(options.requestTimeoutMs); this.origin = options.endpoint.origin }
  protected override resolveBase(): string { return this.origin }
  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Bearer ${this.options.capability}`)
    return (this.options.fetch ?? globalThis.fetch)(input, { ...init, headers, redirect: 'error' })
  }
}
/**
 * Start immediate, serialized completion-relative polls. First success is silent; failures
 * retain prior live observations. No callbacks run after disposal starts.
 * @param options - Trusted runtime, positive finite timings, and isolated callbacks.
 * @returns Idempotent asynchronous polling owner.
 */
export function createTaskObserver(options: TaskObserverOptions): TaskObserver {
  for (const value of [options.pollIntervalMs, options.requestTimeoutMs]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Task observer timings must be positive and finite')
  }
  const client = new ObserverApiClient(options)
  const abort = new AbortController()
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: Promise<void>
  let baseline = false
  let epoch: number | undefined
  let transitionSequence = 0
  const previous = new Map<SessionId, { running: boolean; status: TaskSnapshot['status']; attentionCount: number }>()
  const seen = new Map<SessionId, Set<string>>()
  const awaitingLiveBaseline = new Set<SessionId>()
  let state: TaskObserverState = Object.freeze({
    activeTaskCount: 0, activeAgentCount: 0, attentionCount: 0,
    notifications: Object.freeze([]), freshness: 'unavailable',
  })
  function report(error: unknown): void {
    if (disposed) return
    try { options.reportError(error) } catch (reportError) {
      // A failing reporter cannot stop polling.
      console.error('Task observer error reporter failed', reportError)
    }
  }
  function publish(next: TaskObserverState): void {
    if (disposed) return
    state = Object.freeze({
      ...next,
      notifications: Object.freeze(next.notifications.map(notification => Object.freeze({ ...notification }))),
    })
    try { options.onState(state) } catch (error) { report(error) }
  }
  async function poll(): Promise<void> {
    try {
      const tasks = await client.tasks.list({}, abort.signal)
      if (!tasks.result.ok) throw new Error(`Task observer task.list failed: ${tasks.result.error.code}`)
      if (abort.signal.aborted) return
      const sessions = await client.sessions.list({}, abort.signal)
      if (!sessions.result.ok) throw new Error(`Task observer session.list failed: ${sessions.result.error.code}`)
      if (disposed) return
      const generation = tasks.result.value.generation
      if (epoch !== generation) {
        baseline = false
        previous.clear()
        seen.clear()
        awaitingLiveBaseline.clear()
        transitionSequence = 0
        epoch = generation
      }
      const present = new Set(tasks.result.value.tasks.map(task => task.taskId))
      for (const id of previous.keys()) if (!present.has(id)) previous.delete(id)
      for (const id of seen.keys()) if (!present.has(id)) seen.delete(id)
      for (const id of awaitingLiveBaseline) if (!present.has(id)) awaitingLiveBaseline.delete(id)
      const runningSessions = new Set(sessions.result.value.items.filter(session => session.running).map(session => session.sessionId))
      const agents = new Set<SessionId>()
      const notifications: TaskNotification[] = []
      let activeTaskCount = 0
      let attentionCount = 0
      let freshness: TaskObserverState['freshness'] = 'live'
      for (const task of tasks.result.value.tasks) {
        const owned = new Set([task.taskId, ...task.descendantSessionIds])
        const running = [...owned].some(id => runningSessions.has(id))
        for (const id of owned) if (runningSessions.has(id)) agents.add(id)
        if (running) activeTaskCount++
        const prior = previous.get(task.taskId)
        if (task.freshness !== 'live') {
          freshness = 'unavailable'
          attentionCount += prior?.attentionCount ?? 0
          if (prior === undefined) awaitingLiveBaseline.add(task.taskId)
          continue
        }
        const canNotify = baseline && !awaitingLiveBaseline.delete(task.taskId)
        function add(kind: TaskNotification['kind'], identity: string, ownerSessionId: SessionId, body: string): void {
          const key = `${generation}:${task.taskId}:${kind}:${identity}`
          let identities = seen.get(task.taskId)
          if (identities === undefined) { identities = new Set(); seen.set(task.taskId, identities) }
          if (!identities.has(key) && canNotify) notifications.push({ key, kind, taskId: task.taskId, ownerSessionId, title: task.definition?.goal ?? 'Task', body })
          identities.add(key)
        }
        function addTransition(kind: 'complete' | 'failed', ownerSessionId: SessionId, body: string): void {
          const key = `${generation}:${task.taskId}:${kind}:transition-${++transitionSequence}`
          if (canNotify) notifications.push({ key, kind, taskId: task.taskId, ownerSessionId, title: task.definition?.goal ?? 'Task', body })
        }
        let count = 0
        for (const item of task.attention) {
          if (!item.actionable || item.taskId !== task.taskId || !owned.has(item.ownerSessionId)) continue
          count++
          add('attention', item.id, item.ownerSessionId, item.summary)
        }
        attentionCount += count
        if (task.status === 'failed' && prior?.status !== 'failed') {
          const failure = task.attention.findLast(item =>
            item.kind === 'run-failure' && item.taskId === task.taskId && owned.has(item.ownerSessionId))
          addTransition('failed', failure?.ownerSessionId ?? task.taskId, failure?.summary ?? 'Task failed')
        }
        if (prior?.running && !running && (task.status === 'ready' || task.status === 'settled')) {
          addTransition('complete', task.taskId, 'Task ready for review or settled')
        }
        previous.set(task.taskId, { running, status: task.status, attentionCount: count })
      }
      baseline = true
      publish({ activeTaskCount, activeAgentCount: agents.size, attentionCount, notifications, freshness })
    } catch (error) {
      if (!disposed) { report(error); publish({ ...state, notifications: [], freshness: 'unavailable' }) }
    } finally {
      if (!disposed) timer = setTimeout(() => { active = poll() }, options.pollIntervalMs)
    }
  }
  active = poll()
  return { async dispose() { disposed = true; if (timer !== undefined) clearTimeout(timer); abort.abort(); await active } }
}
