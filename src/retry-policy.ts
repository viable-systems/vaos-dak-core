export function computeRetryBackoffMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) {
    return 1000
  }
  const cappedAttempt = Math.min(attempt, 5)
  return Math.pow(2, cappedAttempt - 1) * 1000
}

