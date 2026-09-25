import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as LocalTaskReviewInvariant from '@deepseek-ai/dsh-task-review-local/invariant'

describe('local Task review invariant companion', () => {
  it('registers package ownership with the invariant registry', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await ctx.plugin(LocalTaskReviewInvariant)
    await expect(ctx.plugin(LocalTaskReviewInvariant)).rejects.toThrow()
    await fiber.dispose()
    await expect(ctx.plugin(LocalTaskReviewInvariant)).resolves.toBeDefined()
  })
})
