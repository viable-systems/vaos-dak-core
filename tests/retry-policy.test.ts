import { describe, expect, it } from 'vitest'

import { computeRetryBackoffMs } from '../src/retry-policy'

describe('computeRetryBackoffMs', () => {
  it('follows deterministic exponential backoff with cap', () => {
    expect(computeRetryBackoffMs(1)).toBe(1000)
    expect(computeRetryBackoffMs(2)).toBe(2000)
    expect(computeRetryBackoffMs(3)).toBe(4000)
    expect(computeRetryBackoffMs(4)).toBe(8000)
    expect(computeRetryBackoffMs(5)).toBe(16000)
    expect(computeRetryBackoffMs(6)).toBe(16000)
    expect(computeRetryBackoffMs(99)).toBe(16000)
  })
})
