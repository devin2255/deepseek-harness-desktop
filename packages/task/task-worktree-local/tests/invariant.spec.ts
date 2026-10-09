import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as LocalTaskWorktreeInvariant from '@deepseek-ai/dsh-task-worktree-local/invariant'

describe('local Task worktree invariant companion', () => {
  it('registers package ownership with the invariant registry', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(LocalTaskWorktreeInvariant)
    await expect(ctx.plugin(LocalTaskWorktreeInvariant)).rejects.toThrow()
    await fiber.dispose()
    await expect(ctx.plugin(LocalTaskWorktreeInvariant)).resolves.toBeDefined()
  })
})
