import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { GitCommandError, parseWorktreeList, runGit } from '../src/git.ts'

const config = { commandTimeoutMs: 1_000, terminateGraceMs: 100, maxOutputBytes: 4_096 }

function runtime(options: {
  exitCode?: number | null
  signal?: string | null
  stdout?: { text: string; lossy: boolean } | null
  stderr?: { text: string; lossy: boolean } | null
} = {}) {
  const spawn = vi.fn(() => ({
    done: Promise.resolve({ exitCode: options.exitCode === undefined ? 0 : options.exitCode, signal: options.signal ?? null }),
    collected: {
      stdout: options.stdout === null ? undefined : { readFrom: () => options.stdout ?? { text: 'ok', lossy: false } },
      stderr: options.stderr === null ? undefined : { readFrom: () => options.stderr ?? { text: '', lossy: false } },
    },
  }))
  return { subprocess: { spawn } as unknown as SubprocessRuntime, spawn }
}

describe('managed worktree Git utilities', () => {
  it('passes bounded invocation options and accepts a caller-approved exit code', async () => {
    const { subprocess, spawn } = runtime({ exitCode: 1, stdout: { text: 'unmerged', lossy: false } })
    const abort = new AbortController()
    await expect(runGit(subprocess, 'git', 'D:\\repo', ['status', '--porcelain'], config,
      abort.signal, [0, 1], 'input', { GIT_CONFIG_NOSYSTEM: '1' })).resolves.toEqual({
      exitCode: 1, stdout: 'unmerged', stderr: '',
    })
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['git', '-c', 'core.quotePath=false', 'status', '--porcelain'],
      cwd: 'D:\\repo',
      stdio: {
        stdin: { data: 'input' }, stdout: { maxBytes: 4_096 }, stderr: { maxBytes: 4_096 },
      },
      graceMs: 100, env: { GIT_CONFIG_NOSYSTEM: '1' },
    }))
  })

  it('reports bounded Git failures without losing stderr, stdout, or an empty diagnostic', async () => {
    for (const [result, diagnostic] of [
      [{ exitCode: 2, stdout: 'out', stderr: 'err' }, 'err'],
      [{ exitCode: 2, stdout: 'out', stderr: '' }, 'out'],
      [{ exitCode: 2, stdout: '', stderr: '' }, 'no diagnostics'],
    ] as const) {
      expect(new GitCommandError(result).message).toContain(diagnostic)
    }
    const { subprocess } = runtime({ exitCode: 2, stderr: { text: 'fatal', lossy: false } })
    await expect(runGit(subprocess, 'git', 'D:\\repo', ['status'], config)).rejects.toMatchObject({
      name: 'GitCommandError', result: { exitCode: 2, stderr: 'fatal' },
    })
  })

  it.each([
    ['missing stdout', { stdout: null }],
    ['missing stderr', { stderr: null }],
    ['lossy stdout', { stdout: { text: '', lossy: true } }],
    ['lossy stderr', { stderr: { text: '', lossy: true } }],
  ])('rejects %s before parsing it', async (_name, options) => {
    const { subprocess } = runtime(options)
    await expect(runGit(subprocess, 'git', 'D:\\repo', ['status'], config))
      .rejects.toThrow('Git output exceeded the configured validation bound')
  })

  it('distinguishes process termination from successful exit', async () => {
    const withSignal = runtime({ exitCode: null, signal: 'SIGTERM' })
    await expect(runGit(withSignal.subprocess, 'git', 'D:\\repo', ['status'], config))
      .rejects.toThrow('Git terminated by SIGTERM')
    const withoutSignal = runtime({ exitCode: null })
    await expect(runGit(withoutSignal.subprocess, 'git', 'D:\\repo', ['status'], config))
      .rejects.toThrow('Git terminated by an unknown signal')
  })

  it('honors caller cancellation before and after spawn, and its own deadline', async () => {
    const initial = new AbortController()
    initial.abort()
    const before = runtime()
    await expect(runGit(before.subprocess, 'git', 'D:\\repo', ['status'], config, initial.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(before.spawn).not.toHaveBeenCalled()

    const later = new AbortController()
    const during = {
      spawn: vi.fn(() => {
        later.abort()
        return runtime().spawn()
      }),
    } as unknown as SubprocessRuntime
    await expect(runGit(during, 'git', 'D:\\repo', ['status'], config, later.signal))
      .rejects.toMatchObject({ name: 'AbortError' })

    const timed = {
      spawn: vi.fn(({ signal }: { signal: AbortSignal }) => ({
        done: new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve({ exitCode: null, signal: 'SIGTERM' })
          }, { once: true })
        }),
        collected: {},
      })),
    } as unknown as SubprocessRuntime
    await expect(runGit(timed, 'git', 'D:\\repo', ['status'], { ...config, commandTimeoutMs: 5 }))
      .rejects.toThrow('Git command exceeded 5 ms')
  })

  it('parses complete NUL-delimited worktree records and rejects missing paths', () => {
    expect(parseWorktreeList('worktree D:\\repo\0HEAD abc\0branch refs/heads/main\0\0worktree D:\\detached\0HEAD def\0\0'))
      .toEqual([
        { path: 'D:\\repo', head: 'abc', branch: 'refs/heads/main' },
        { path: 'D:\\detached', head: 'def' },
      ])
    expect(parseWorktreeList('worktree D:\\bare\0bare\0\0')).toEqual([{ path: 'D:\\bare' }])
    expect(() => parseWorktreeList('HEAD abc\0\0')).toThrow('Git worktree record has no path')
    expect(() => parseWorktreeList('worktree \0\0')).toThrow('Git worktree record has no path')
  })
})
