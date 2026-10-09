/**
 * Assembled-app regression: inherited and deployment-selected child policies
 * confine a real write without tightening the deployment's root-session mode.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { normalizeSessionLog, scrubRequestHeaders, type NormalizeContext } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./subagent-inheritance-snapshots/parent-override', import.meta.url))
const replayOverride = join(fixtureDir, 'replay.override.json')
const childReplay = join(fixtureDir, 'child.replay.jsonl')
const configPath = fileURLToPath(new URL('../subagent-inheritance.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const sessionId = SessionId('subagent-inheritance-parent')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const task = 'Delegate the write probe to a subagent.'

/** Seed a completed parent turn, optionally carrying the sole read-only override. */
async function seedParent(root: string, cwd: string, readOnly: boolean): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    cwd,
    delegationDepth: 0,
  }
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 11, data: createUserMessage({ content: [{ type: 'text', text: readOnly ? 'Tighten this session to read-only.' : 'Keep the root session writable.' }], source: { kind: 'user' } }), surfaceOp: 'append' },
  ]
  if (readOnly) events.push({ type: 'sandbox/mode', seq: 2, time: 12, data: { mode: 'read-only' } })
  events.push({ type: 'turn/end', seq: events.length, time: 13, data: { turn: 1, reason: { kind: 'completed' } } })
  try {
    await ctx.sessionPersistence.create(meta)
    await ctx.sessionPersistence.append(sessionId, events)
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('delegated child policy snapshots', () => {
  it.each([
    { name: 'parent-override', parentMode: 'workspace-write', delegationMode: 'inherit', parentReadOnly: true },
    { name: 'desktop-read-only', parentMode: 'danger-full-access', delegationMode: 'read-only', parentReadOnly: false },
  ])('confines a delegated child with $name through the assembled app', async (scenario) => {
    const expectedDir = fileURLToPath(new URL(`./subagent-inheritance-snapshots/${scenario.name}`, import.meta.url))
    const parentExpected = join(expectedDir, 'parent.expected.jsonl')
    const childExpected = join(expectedDir, 'child.expected.jsonl')
    let cwd = ''
    const result = await runLoaderSmoke({
      label: 'subagent inheritance headless stream-json snapshot',
      tempDirPrefix: 'dsh-subagent-inherit-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, task],
      tsconfigPath,
      env: {
        // The primary fixture path must exist for llm-replay's config guard;
        // the override sidecar fully replaces the derived parent script.
        DSH_SNAPSHOT_FILE: replayOverride,
        DSH_SNAPSHOT_OVERRIDE: replayOverride,
        DSH_SNAPSHOT_CHILD_FILES: childReplay,
        DSH_SNAPSHOT_PARENT_MODE: scenario.parentMode,
        DSH_SNAPSHOT_DELEGATION_MODE: scenario.delegationMode,
      },
      prepare: async (runCwd) => {
        cwd = runCwd
        await seedParent(join(runCwd, '.sessions'), runCwd, scenario.parentReadOnly)
      },
      inspect: async (runCwd) => {
        // The writable deployment default would allow this without the child policy.
        await expect(readFile(join(runCwd, 'inherited.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

        // Collect both persisted logs (parent resumed turn + child run).
        const sessionsDir = join(runCwd, '.sessions')
        const files = (await readdir(sessionsDir, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        const logs = await Promise.all(files.map(async file => readFile(join(sessionsDir, file), 'utf8')))
        const headerOf = (content: string): Record<string, unknown> =>
          JSON.parse(content.split('\n')[0] ?? '{}') as Record<string, unknown>
        const parent = logs.find(content => headerOf(content).id === sessionId)
        const child = logs.find(content => typeof headerOf(content).parentSession === 'string')
        if (parent === undefined || child === undefined) throw new Error('missing persisted parent or child log')

        const childRecords = child.trimEnd().split('\n').map(
          line => JSON.parse(line) as Record<string, unknown>,
        )
        expect(childRecords[1]).toMatchObject({
          type: 'sandbox/mode',
          seq: 0,
          data: { mode: 'read-only', source: 'delegation' },
        })

        const runtimeContexts = (content: string): string[] => content.trimEnd().split('\n').flatMap((line) => {
          const record = JSON.parse(line) as {
            type?: string
            data?: { source?: { kind?: string; plugin?: string }; content?: Array<{ type?: string; text?: unknown }> }
          }
          if (record.type !== 'user/message'
            || record.data?.source?.kind !== 'plugin'
            || record.data.source.plugin !== '@deepseek-ai/dsh-system-prompt') return []
          return record.data.content?.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []) ?? []
        })
        const parentContexts = runtimeContexts(parent)
        const childContexts = runtimeContexts(child)
        const policyContexts = [...parentContexts, ...childContexts]
        expect(policyContexts).toHaveLength(2)
        const expectedReadOnly = scenario.parentReadOnly ? policyContexts : childContexts
        for (const context of expectedReadOnly) {
          expect(context).toContain('Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode.')
          expect(context).toContain('Do not refuse a required modification from this policy alone')
          expect(context).not.toContain('write and edit tools')
          expect(context).not.toContain('one-shot bash commands')
          expect(context).not.toContain('terminal sessions')
        }
        if (!scenario.parentReadOnly) {
          expect(parentContexts[0]).toContain('Current DSH file policy: danger-full-access.')
          expect(parent.trimEnd().split('\n').some(line =>
            (JSON.parse(line) as Record<string, unknown>).type === 'sandbox/mode')).toBe(false)
        }

        const context: NormalizeContext = { sessionIds: [sessionId, String(headerOf(child).id)], cwd }
        const normalizedParent = scrubRequestHeaders(normalizeSessionLog(parent, context))
        const normalizedChild = scrubRequestHeaders(normalizeSessionLog(child, context))
        if (refreshing) {
          await mkdir(expectedDir, { recursive: true })
          await writeFile(parentExpected, normalizedParent)
          await writeFile(childExpected, normalizedChild)
        }
        expect(normalizedParent).toBe(await readFile(parentExpected, 'utf8'))
        expect(normalizedChild).toBe(await readFile(childExpected, 'utf8'))
        // The child's real write was denied by the real fence.
        expect(normalizedChild).toContain('file access denied under read-only mode')
      },
    })

    expect(result.stderr).toBe('')
    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      sessionId,
      output: 'The delegated child was denied by the sandbox. PARENT_DONE',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
