/** Renders startup states and forwards explicit recovery actions through the preload bridge. */

const phaseLabel = document.querySelector<HTMLElement>('[data-phase]')
const progress = document.querySelector<HTMLElement>('[data-progress]')
const failureActions = document.querySelector<HTMLElement>('[data-failure-actions]')
const failureMessage = document.querySelector<HTMLElement>('[data-failure-message]')
const retry = document.querySelector<HTMLButtonElement>('[data-retry]')
const openLogs = document.querySelector<HTMLButtonElement>('[data-open-logs]')
const exit = document.querySelector<HTMLButtonElement>('[data-exit]')

const labels: Readonly<Record<DesktopStartupViewState['phase'], string>> = Object.freeze({
  'waiting-electron': 'Preparing desktop',
  'loading-runtime': 'Loading runtime',
  'validating-profile': 'Validating profile',
  'starting-service': 'Starting service',
  'probing-service': 'Checking service',
  ready: 'Ready',
  failed: 'Startup needs attention',
})

window.deepseekStartup.onState((state) => {
  if (phaseLabel !== null) phaseLabel.textContent = labels[state.phase]
  if (progress !== null) progress.hidden = state.status !== 'working'
  if (failureActions !== null) failureActions.hidden = state.status !== 'failed'
  if (failureMessage !== null) failureMessage.textContent = state.status === 'failed' ? state.error.action : ''
})

retry?.addEventListener('click', () => { void window.deepseekStartup.retry() })
openLogs?.addEventListener('click', () => { void window.deepseekStartup.openLogs() })
exit?.addEventListener('click', () => { void window.deepseekStartup.exit() })

export {}
