/** Authenticated validation of the desktop Harness readiness response. */

const READINESS_PATH = '/.well-known/deepseek-harness-desktop/readiness'
const MAX_RESPONSE_BYTES = 16 * 1024
const JSON_MEDIA_TYPE = 'application/json'

/** Inputs required to validate one discovered desktop Harness endpoint. */
export interface DesktopReadinessProbeOptions {
  /** Canonical loopback endpoint discovered from the owned child process. */
  readonly endpoint: URL
  /** Per-launch bearer capability retained only for the request header. */
  readonly capability: string
  /** Desktop application version the child must report. */
  readonly expectedVersion: string
  /** API operations that must be mounted before renderer handoff. */
  readonly requiredCapabilities: readonly string[]
  /** Attempt-scoped cancellation and deadline signal. */
  readonly signal: AbortSignal
}

interface DesktopReadinessResponse {
  readonly product: string
  readonly version: string
  readonly capabilities: readonly string[]
}

/**
 * Issue one bounded authenticated GET and validate the desktop runtime identity.
 * @param options - Trusted endpoint, launch capability, expected identity, and attempt signal.
 * Rejects without including the bearer capability or discovered URL when the endpoint,
 * transport, response bounds, or reported runtime identity is invalid.
 * @returns The validated runtime version.
 */
export async function probeDesktopReadiness(
  options: DesktopReadinessProbeOptions,
): Promise<{ version: string }> {
  const target = readinessTarget(options.endpoint)
  let response: Response
  try {
    response = await fetch(target, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.capability}` },
      signal: options.signal,
      redirect: 'error',
    })
  } catch {
    throw new Error('Desktop readiness request failed')
  }
  if (response.status !== 200) throw new Error('Desktop readiness returned an unexpected status')
  if (mediaType(response.headers.get('content-type')) !== JSON_MEDIA_TYPE) {
    throw new Error('Desktop readiness returned an unexpected content type')
  }
  const body = await readBoundedBody(response, MAX_RESPONSE_BYTES)
  const payload = parseReadiness(body)
  if (payload.product !== 'deepseek-harness-desktop') {
    throw new Error('Desktop readiness returned an unexpected product')
  }
  if (payload.version !== options.expectedVersion) {
    throw new Error('Desktop readiness returned an unexpected version')
  }
  const available = new Set(payload.capabilities)
  if (options.requiredCapabilities.some(capability => !available.has(capability))) {
    throw new Error('Desktop readiness is missing a required capability')
  }
  return { version: payload.version }
}

/** Construct the fixed readiness URL only from the canonical owned loopback origin. */
function readinessTarget(endpoint: URL): URL {
  if (endpoint.protocol !== 'http:'
    || endpoint.hostname !== '127.0.0.1'
    || endpoint.port === ''
    || endpoint.username !== ''
    || endpoint.password !== ''
    || endpoint.pathname !== '/'
    || endpoint.search !== ''
    || endpoint.hash !== '') {
    throw new Error('Desktop readiness requires a trusted loopback endpoint')
  }
  return new URL(READINESS_PATH, endpoint.origin)
}

/** Normalize an HTTP Content-Type header while accepting ordinary parameters. */
function mediaType(value: string | null): string | undefined {
  return value?.split(';', 1)[0]?.trim().toLowerCase()
}

/** Read at most the protocol response limit without retaining an oversized complete body. */
async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await response.body?.cancel()
    throw new Error('Desktop readiness response exceeded the byte limit')
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>
    try {
      result = await reader.read()
    } catch {
      throw new Error('Desktop readiness response failed while reading')
    }
    if (result.done) break
    length += result.value.byteLength
    if (length > maximumBytes) {
      await reader.cancel()
      throw new Error('Desktop readiness response exceeded the byte limit')
    }
    chunks.push(result.value)
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** Parse the small JSON object and reject malformed response fields. */
function parseReadiness(body: Uint8Array): DesktopReadinessResponse {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    throw new Error('Desktop readiness returned malformed JSON')
  }
  if (!isRecord(value)
    || !Object.hasOwn(value, 'product')
    || typeof value.product !== 'string'
    || !Object.hasOwn(value, 'version')
    || typeof value.version !== 'string'
    || !Object.hasOwn(value, 'capabilities')
    || !Array.isArray(value.capabilities)
    || value.capabilities.some(capability => typeof capability !== 'string')) {
    throw new Error('Desktop readiness returned malformed JSON fields')
  }
  return {
    product: value.product,
    version: value.version,
    capabilities: value.capabilities as string[],
  }
}

/** Narrow an unknown JSON value to an object with inspectable own fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
