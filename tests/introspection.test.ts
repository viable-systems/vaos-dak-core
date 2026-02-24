import { describe, expect, it } from 'vitest'

import { InMemoryAutonomyRepository } from '../src/in-memory-repository'
import { AutonomyIntrospectionService } from '../src/introspection'
import { AutonomyLedgerService } from '../src/ledger'

describe('AutonomyIntrospectionService', () => {
  it('returns healthy stream introspection', async () => {
    const repo = new InMemoryAutonomyRepository()
    const stream = repo.createStream({
      id: 'stream-introspection-healthy',
      workflow_type: 'factory',
      owner_user_id: 'user-1',
      status: 'pending',
      current_state: { phase: 'queued' }
    })
    const ledger = new AutonomyLedgerService(repo)
    const introspection = new AutonomyIntrospectionService(repo)

    await ledger.appendEvent({
      streamId: stream.id,
      eventType: 'stream.started',
      idempotencyKey: 'introspection-start',
      actorType: 'system',
      actorId: 'worker-introspection'
    })

    const result = await introspection.inspectStream(stream.id)

    expect(result.status).toBe('ok')
    expect(result.stream?.id).toBe(stream.id)
    expect(result.lastEvent?.event_type).toBe('stream.started')
    expect(result.reducedState?.status).toBe('running')
    expect(result.memoryContext?.graph.eventCount).toBe(1)
  })

  it('returns unknown_stream for missing stream id', async () => {
    const repo = new InMemoryAutonomyRepository()
    const introspection = new AutonomyIntrospectionService(repo)
    const result = await introspection.inspectStream('does-not-exist')

    expect(result.status).toBe('unknown_stream')
    expect(result.stream).toBeNull()
    expect(result.reducedState).toBeNull()
    expect(result.memoryContext).toBeNull()
  })

  it('returns inconsistent_stream when sequence is corrupted', async () => {
    const repo = new InMemoryAutonomyRepository()
    const stream = repo.createStream({
      id: 'stream-introspection-inconsistent',
      workflow_type: 'factory',
      owner_user_id: 'user-2',
      status: 'running',
      current_state: { phase: 'queued' }
    })
    const introspection = new AutonomyIntrospectionService(repo)

    await repo.insertEvent({
      stream_id: stream.id,
      seq_no: 2,
      event_type: 'stream.started',
      payload_json: {},
      metadata_json: {},
      idempotency_key: 'gap-seq-2',
      prev_hash: null,
      event_hash: 'hash-gap-2',
      actor_type: 'system',
      actor_id: 'worker-a',
      created_at: '2026-02-24T00:00:00.000Z'
    })

    const result = await introspection.inspectStream(stream.id)

    expect(result.status).toBe('inconsistent_stream')
    expect(result.reducedState?.reason).toBe('sequence_gap_at_1')
  })
})
