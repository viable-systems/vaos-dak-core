import { describe, expect, it } from 'vitest'

import { computeBoundedAdaptationDecision } from '../src/adaptation'
import type { AutonomyEvent } from '../src/types'

function adaptationEvent(seqNo: number, idempotencyKey: string): AutonomyEvent {
  return {
    id: `evt-${seqNo}`,
    stream_id: 'stream-adaptation',
    seq_no: seqNo,
    event_type: 'adaptation.applied',
    payload_json: { attempt: seqNo, policy_id: 'scope.narrow_context' },
    metadata_json: {},
    idempotency_key: idempotencyKey,
    prev_hash: null,
    event_hash: `hash-${seqNo}`,
    actor_type: 'system',
    actor_id: 'worker',
    created_at: '2026-02-24T00:00:00.000Z'
  }
}

describe('computeBoundedAdaptationDecision', () => {
  it('returns the first deterministic policy when no attempts exist', () => {
    const decision = computeBoundedAdaptationDecision({
      events: [],
      errorMessage: 'timeout',
      maxAttempts: 3
    })

    expect(decision.applied).toBe(true)
    expect(decision.attempt).toBe(1)
    expect(decision.policyId).toBe('scope.narrow_context')
    expect(decision.errorDigest.length).toBe(64)
  })

  it('is bounded by max attempts using ledger history', () => {
    const events = [
      adaptationEvent(1, 'tick-1:adapt:1'),
      adaptationEvent(2, 'tick-2:adapt:2'),
      adaptationEvent(3, 'tick-3:adapt:3')
    ]

    const decision = computeBoundedAdaptationDecision({
      events,
      errorMessage: 'still failing',
      maxAttempts: 3
    })

    expect(decision.applied).toBe(false)
    expect(decision.exhausted).toBe(true)
    expect(decision.priorAttempts).toBe(3)
    expect(decision.policyId).toBeNull()
  })

  it('deduplicates attempts by idempotency key', () => {
    const events = [
      adaptationEvent(1, 'tick-1:adapt:1'),
      adaptationEvent(2, 'tick-1:adapt:1')
    ]

    const decision = computeBoundedAdaptationDecision({
      events,
      errorMessage: 'failure',
      maxAttempts: 3
    })

    expect(decision.priorAttempts).toBe(1)
    expect(decision.applied).toBe(true)
    expect(decision.attempt).toBe(2)
    expect(decision.policyId).toBe('execution.reduce_step_size')
  })
})
