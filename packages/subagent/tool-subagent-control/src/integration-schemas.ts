/** Canonical result schemas for isolated writer review and integration tools. */

const text = { type: 'string', required: true } as const
const number = { type: 'number', required: true } as const
const boolean = { type: 'boolean', required: true } as const
const nullableCount = { oneOf: [{ type: 'number' }, { type: 'null' }], required: true } as const

/** Bounded child review with the independently inspected root revision. */
export const reviewSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    rootRevision: text,
    summary: {
      type: 'object', required: true, additionalProperties: false,
      properties: {
        taskId: text, workspaceId: text, revision: text, baseCommit: text, headCommit: text, sourceHead: text,
        sourceDirty: boolean, branch: text, dirty: boolean, truncated: boolean, additions: number, deletions: number,
        files: { type: 'array', required: true, items: {
          type: 'object', additionalProperties: false,
          properties: {
            path: text, previousPath: { type: 'string' }, status: text, binary: boolean,
            additions: nullableCount, deletions: nullableCount,
          },
        } },
      },
    },
    diff: {
      type: 'object', additionalProperties: false,
      properties: {
        taskId: text, workspaceId: text, revision: text, path: text, previousPath: { type: 'string' },
        binary: boolean, truncated: boolean, patch: text,
      },
    },
  },
} as const

/** Exact revision and commit returned by a successful child commit. */
export const commitSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'commit' }, operationId: text, taskId: text, workspaceId: text,
    reviewRevision: text, committedRevision: text, branch: text, commit: text, committedAt: number,
  },
} as const

const integration = {
  operationId: text, taskId: text, workspaceId: text, reviewRevision: text, headBefore: text,
  contributors: { type: 'array', required: true, items: {
    type: 'object', additionalProperties: false,
    properties: { sessionId: text, branch: text, commit: text, reviewRevision: text },
  } },
} as const

/** Complete integration receipt or non-mutating conflict with exact contributor identities. */
export const integrationSchema = {
  oneOf: [
    { type: 'object', additionalProperties: false, properties: {
      ...integration, kind: { type: 'string', required: true, const: 'integrated' }, headAfter: text, integratedAt: number,
    } },
    { type: 'object', additionalProperties: false, properties: {
      ...integration, kind: { type: 'string', required: true, const: 'conflict' }, conflictingSessionId: text,
      paths: { type: 'array', required: true, items: { type: 'string' } }, detectedAt: number,
    } },
  ],
} as const
