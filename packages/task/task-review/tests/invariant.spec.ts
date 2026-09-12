import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as TaskReviewInvariant from '@deepseek-ai/dsh-task-review/invariant'

describe('Task review invariant companion', () => {
  it('registers package ownership with the invariant registry', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(TaskReviewInvariant)
    await expect(ctx.plugin(TaskReviewInvariant)).rejects.toThrow()
    await fiber.dispose()
    await expect(ctx.plugin(TaskReviewInvariant)).resolves.toBeDefined()
  })
})
