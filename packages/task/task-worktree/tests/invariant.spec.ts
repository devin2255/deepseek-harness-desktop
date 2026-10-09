import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as TaskWorktreeInvariant from '@deepseek-ai/dsh-task-worktree/invariant'

describe('Task worktree invariant companion', () => {
  it('registers package ownership with the invariant registry', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(TaskWorktreeInvariant)
    await expect(ctx.plugin(TaskWorktreeInvariant)).rejects.toThrow()
    await fiber.dispose()
    await expect(ctx.plugin(TaskWorktreeInvariant)).resolves.toBeDefined()
  })
})
