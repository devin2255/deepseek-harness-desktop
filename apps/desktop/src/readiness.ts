const MAX_INCOMPLETE_LINE_BYTES = 8 * 1024

/** Accepts decoded stdout chunks until the canonical Web readiness line appears. */
export interface ReadinessParser {
  /**
   * Consume one decoded stdout chunk.
   * @param chunk - Text received from the child process's stdout stream.
   */
  write(chunk: string): void
}

/**
 * Create a line-oriented parser for the desktop launcher's Web readiness signal.
 * @param onReady - Receives the first canonical loopback URL printed by `dsh web`.
 * @returns A parser that accepts stdout chunks.
 */
export function createReadinessParser(onReady: (url: string) => void): ReadinessParser {
  let incomplete = ''
  let discardingOversizedLine = false
  let settled = false

  const inspect = (line: string): void => {
    if (settled) return
    const match = /^dsh web: (http:\/\/127\.0\.0\.1:(\d+))(?: .*)?$/u.exec(line)
    if (match === null) return

    const url = match[1]
    const portText = match[2]
    if (url === undefined || portText === undefined) return

    const port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return

    settled = true
    onReady(url)
  }

  const appendIncomplete = (text: string): void => {
    if (discardingOversizedLine) return
    if (Buffer.byteLength(incomplete) + Buffer.byteLength(text) > MAX_INCOMPLETE_LINE_BYTES) {
      incomplete = ''
      discardingOversizedLine = true
      return
    }
    incomplete += text
  }

  return {
    write(chunk): void {
      if (settled) return

      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf('\n', start)
        if (newline === -1) {
          appendIncomplete(chunk.slice(start))
          return
        }

        const suffix = chunk.slice(start, newline)
        if (discardingOversizedLine) {
          discardingOversizedLine = false
        } else if (Buffer.byteLength(incomplete) + Buffer.byteLength(suffix) <= MAX_INCOMPLETE_LINE_BYTES) {
          const line = `${incomplete}${suffix}`
          inspect(line.endsWith('\r') ? line.slice(0, -1) : line)
        }
        incomplete = ''
        start = newline + 1
      }
    },
  }
}
