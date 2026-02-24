import { describe, expect, it } from 'vitest'

import {
  buildDeterminismReceipt,
  computeAutonomyEventHash,
  verifyDeterminismReceipt,
  verifyEventHashChain,
  type AutonomyEvent,
  type AutonomyStream
} from '../src'

function makeEvent(partial: Partial<AutonomyEvent> & Pick<AutonomyEvent, 'seq_no' | 'event_type'>): AutonomyEvent {
  const prevHash = partial.prev_hash || null
  const createdAt = partial.created_at || `2026-02-24T00:00:0${partial.seq_no}.000Z`
  const eventBase = {
    stream_id: partial.stream_id || 'receipt-stream',
    seq_no: partial.seq_no,
    event_type: partial.event_type,
    payload_json: partial.payload_json || {},
    metadata_json: partial.metadata_json || {},
    idempotency_key: partial.idempotency_key || `k-${partial.seq_no}`,
    prev_hash: prevHash,
    actor_type: partial.actor_type || 'system',
    actor_id: partial.actor_id || 'worker-1',
    created_at: createdAt
  }
  return {
    id: partial.id || `e-${partial.seq_no}`,
    ...eventBase,
    event_hash: partial.event_hash || computeAutonomyEventHash(eventBase)
  }
}

const stream: AutonomyStream = {
  id: 'receipt-stream',
  workflow_type: 'factory',
  owner_user_id: 'user-1',
  status: 'running',
  current_state: { phase: 'plan' },
  last_seq_no: 2,
  retry_count: 0,
  max_retries: 5,
  next_tick_at: '2026-02-24T00:00:10.000Z',
  last_error: null,
  created_at: '2026-02-24T00:00:00.000Z',
  updated_at: '2026-02-24T00:00:00.000Z'
}

describe('determinism receipts', () => {
  it('produces and verifies a signed receipt', () => {
    const first = makeEvent({ seq_no: 1, event_type: 'stream.started', prev_hash: null })
    const second = makeEvent({
      seq_no: 2,
      event_type: 'step.succeeded',
      payload_json: { from_phase: 'ideas', to_phase: 'plan' },
      prev_hash: first.event_hash
    })
    const events = [first, second]

    const receipt = buildDeterminismReceipt({
      stream,
      events,
      tickId: 'tick-1',
      signingSecret: 'secret'
    })

    const verification = verifyDeterminismReceipt(receipt, {
      stream,
      events,
      tickId: 'tick-1',
      signingSecret: 'secret'
    })

    expect(verification.valid).toBe(true)
    expect(receipt.signature).toBeTruthy()
  })

  it('flags hash-chain tampering', () => {
    const first = makeEvent({ seq_no: 1, event_type: 'stream.started', prev_hash: null })
    const second = makeEvent({ seq_no: 2, event_type: 'step.succeeded', prev_hash: 'not-the-first-hash' })
    const result = verifyEventHashChain([first, second])

    expect(result.valid).toBe(false)
    expect(result.issues.some(issue => issue.includes('prev_hash_mismatch'))).toBe(true)
  })
})
