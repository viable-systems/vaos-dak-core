import { describe, expect, it } from 'vitest'

import { reduceAutonomyStream } from '../src/reducer'
import type { AutonomyEvent, AutonomyStream } from '../src/types'

function buildEvent(overrides: Partial<AutonomyEvent> & Pick<AutonomyEvent, 'seq_no' | 'event_type'>): AutonomyEvent {
  const seq = overrides.seq_no
  return {
    id: overrides.id || `event-${seq}`,
    stream_id: overrides.stream_id || 'stream-reducer',
    seq_no: seq,
    event_type: overrides.event_type,
    payload_json: overrides.payload_json || {},
    metadata_json: overrides.metadata_json || {},
    idempotency_key: overrides.idempotency_key || `key-${seq}`,
    prev_hash: overrides.prev_hash ?? null,
    event_hash: overrides.event_hash || `hash-${seq}`,
    actor_type: overrides.actor_type ?? null,
    actor_id: overrides.actor_id ?? null,
    created_at: overrides.created_at || '2026-02-24T00:00:00.000Z'
  }
}

describe('reduceAutonomyStream', () => {
  it('deterministically rebuilds provisioning state to terminal', () => {
    const stream: AutonomyStream = {
      id: 'stream-reducer-provisioning',
      workflow_type: 'provisioning',
      owner_user_id: 'user-1',
      status: 'pending',
      current_state: {},
      last_seq_no: 0,
      retry_count: 0,
      max_retries: 5,
      next_tick_at: '2026-02-24T00:00:00.000Z',
      last_error: null,
      created_at: '2026-02-24T00:00:00.000Z',
      updated_at: '2026-02-24T00:00:00.000Z'
    }

    const events: AutonomyEvent[] = [
      buildEvent({ seq_no: 1, event_type: 'stream.started' }),
      buildEvent({ seq_no: 2, event_type: 'step.succeeded', payload_json: { to_phase: 'creating' } }),
      buildEvent({ seq_no: 3, event_type: 'step.succeeded', payload_json: { to_phase: 'installing' } }),
      buildEvent({ seq_no: 4, event_type: 'step.succeeded', payload_json: { to_phase: 'ready' } })
    ]

    const reduced = reduceAutonomyStream(stream, events)

    expect(reduced.inconsistent).toBe(false)
    expect(reduced.phase).toBe('ready')
    expect(reduced.status).toBe('completed')
    expect(reduced.lastSeqNo).toBe(4)
    expect(reduced.lastError).toBeNull()
  })

  it('ignores duplicate semantic events by idempotency key', () => {
    const stream: AutonomyStream = {
      id: 'stream-reducer-dup',
      workflow_type: 'factory',
      owner_user_id: 'user-1',
      status: 'running',
      current_state: { phase: 'queued' },
      last_seq_no: 0,
      retry_count: 0,
      max_retries: 5,
      next_tick_at: '2026-02-24T00:00:00.000Z',
      last_error: null,
      created_at: '2026-02-24T00:00:00.000Z',
      updated_at: '2026-02-24T00:00:00.000Z'
    }

    const events: AutonomyEvent[] = [
      buildEvent({ seq_no: 1, event_type: 'stream.started' }),
      buildEvent({
        seq_no: 2,
        event_type: 'step.succeeded',
        idempotency_key: 'step-1',
        payload_json: { to_phase: 'research' }
      }),
      buildEvent({
        seq_no: 3,
        event_type: 'step.succeeded',
        idempotency_key: 'step-1',
        payload_json: { to_phase: 'plan' }
      })
    ]

    const reduced = reduceAutonomyStream(stream, events)

    expect(reduced.inconsistent).toBe(false)
    expect(reduced.phase).toBe('research')
    expect(reduced.status).toBe('running')
  })

  it('marks stream inconsistent when sequence has a gap', () => {
    const stream: AutonomyStream = {
      id: 'stream-reducer-gap',
      workflow_type: 'factory',
      owner_user_id: 'user-1',
      status: 'running',
      current_state: { phase: 'queued' },
      last_seq_no: 0,
      retry_count: 0,
      max_retries: 5,
      next_tick_at: '2026-02-24T00:00:00.000Z',
      last_error: null,
      created_at: '2026-02-24T00:00:00.000Z',
      updated_at: '2026-02-24T00:00:00.000Z'
    }

    const events: AutonomyEvent[] = [
      buildEvent({ seq_no: 1, event_type: 'stream.started' }),
      buildEvent({ seq_no: 3, event_type: 'step.succeeded', payload_json: { to_phase: 'research' } })
    ]

    const reduced = reduceAutonomyStream(stream, events)

    expect(reduced.inconsistent).toBe(true)
    expect(reduced.status).toBe('inconsistent')
    expect(reduced.reason).toBe('sequence_gap_at_2')
  })

  it('rebuilds deterministically from snapshot seed and tail events', () => {
    const stream: AutonomyStream = {
      id: 'stream-reducer-snapshot',
      workflow_type: 'provisioning',
      owner_user_id: 'user-3',
      status: 'running',
      current_state: { phase: 'creating' },
      last_seq_no: 4,
      retry_count: 1,
      max_retries: 5,
      next_tick_at: '2026-02-24T00:00:00.000Z',
      last_error: null,
      created_at: '2026-02-24T00:00:00.000Z',
      updated_at: '2026-02-24T00:00:00.000Z'
    }

    const tailEvents: AutonomyEvent[] = [
      buildEvent({ seq_no: 5, event_type: 'step.succeeded', payload_json: { to_phase: 'installing' } }),
      buildEvent({ seq_no: 6, event_type: 'step.succeeded', payload_json: { to_phase: 'ready' } })
    ]

    const reduced = reduceAutonomyStream(stream, tailEvents, {
      startSeqNo: 4,
      seedState: {
        status: 'running',
        phase: 'creating',
        retryCount: 1,
        lastError: null,
        lastSeqNo: 4
      }
    })

    expect(reduced.inconsistent).toBe(false)
    expect(reduced.phase).toBe('ready')
    expect(reduced.status).toBe('completed')
    expect(reduced.lastSeqNo).toBe(6)
  })
})
