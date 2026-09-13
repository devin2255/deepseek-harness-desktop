/** Task Review workspace composition over the runtime-owned review object. */
import type { ClientContext, TaskReviewState } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { en, zh, type TaskReviewKey } from './locales.ts'
import { TaskReview } from './TaskReview.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Task Review workspace copy. */
    taskReview: TaskReviewKey
  }
}

/** Narrow Task runtime face injected into the pure Review component. */
export interface TaskReviewInjected {
  showTasks(): void
  refresh(): Promise<void>
  selectFile(path: string): Promise<void>
  requestChanges(expectedSeq: number): Promise<unknown>
  commit(message: string, expectedSeq: number): Promise<unknown>
  apply(commit: string, expectedSeq: number): Promise<unknown>
  discard(confirmedUncommittedLoss: boolean, expectedSeq: number): Promise<unknown>
  hooks: { taskReview: HostObservable<TaskReviewState> }
}

/** Services required by Review registration and actions. */
export const inject = ['slots', 'tasks', 'layout', 'locale']

/** Register the separate Review workspace. @param ctx - client plugin context. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('taskReview', { zh, en }), 'ui-task-review: dictionaries')
  ctx.slots.inject('shell.review', () => ctx.slots.register({
    name: 'shell.review', locale: 'taskReview', inject: (): TaskReviewInjected => ({
      showTasks: () => { ctx.layout.showHome() },
      refresh: () => ctx.tasks.refreshReview(),
      selectFile: path => ctx.tasks.selectReviewFile(path),
      requestChanges: expectedSeq => ctx.tasks.requestChanges(expectedSeq),
      commit: (message, expectedSeq) => ctx.tasks.commitReview(message, expectedSeq),
      apply: (commit, expectedSeq) => ctx.tasks.applyReview(commit, expectedSeq),
      discard: (confirmedUncommittedLoss, expectedSeq) => ctx.tasks.discardReview(confirmedUncommittedLoss, expectedSeq),
      hooks: { taskReview: ctx.tasks.reviewState },
    }),
  }, TaskReview))
}
