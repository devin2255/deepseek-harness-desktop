/** Built declaration consumer; executed independently by verify-node-next-types after build. */

import type {} from '@deepseek-ai/dsh-subagent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const execution: SessionEvent<'subagent/execution-provider'>['data'] = { provider: 'writer' }
void execution

// @ts-expect-error the durable owner requires its provider identity.
const missingProvider: SessionEvent<'subagent/execution-provider'>['data'] = {}
void missingProvider
