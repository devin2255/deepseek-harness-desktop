/** Lifecycle composition helpers for independently owned client registrations. */

/**
 * Release every independent registration before reporting cleanup failures.
 * @param releases - Independent cleanup callbacks to attempt in order.
 * @param message - Aggregate failure description when multiple callbacks reject.
 * @returns One cleanup callback with stable single- and multi-failure behavior.
 */
export function disposeTogether(releases: readonly (() => void)[], message: string): () => void {
  return () => {
    const failures: unknown[] = []
    for (const release of releases) {
      try { release() } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, message, { cause: failures[0] })
  }
}

/**
 * Install every subscription and release earlier registrations if a later source rejects.
 * @param subscribe - Subscription installers to invoke in order.
 * @param message - Aggregate failure description when registration and rollback both reject.
 * @returns A combined cleanup callback after every registration succeeds.
 */
export function subscribeTogether(subscribe: readonly (() => () => void)[], message: string): () => void {
  const releases: (() => void)[] = []
  try {
    for (const install of subscribe) releases.push(install())
  } catch (error) {
    const failures = [error]
    try { disposeTogether(releases, message)() } catch (cleanupError) { failures.push(cleanupError) }
    if (failures.length === 1) throw error
    throw new AggregateError(failures, message, { cause: error })
  }
  return disposeTogether(releases, message)
}
