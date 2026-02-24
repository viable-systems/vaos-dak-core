import { describe, expect, it } from 'vitest'

import { InMemoryAutonomyRepository } from '../src/in-memory-repository'
import { AutonomyLedgerService, AutonomyPolicyViolationError } from '../src/ledger'

describe('AutonomyLedgerService', () => {
  it('appends events with monotonic sequence and hash chaining', async () => {
    const repo = new InMemoryAutonomyRepository()
    const stream = repo.createStream({
      id: 'stream-ledger-1',
      workflow_type: 'factory',
      owner_user_id: 'user-1'
    })
    const ledger = new AutonomyLedgerService(repo)

    const first = await ledger.appendEvent({
      streamId: stream.id,
      eventType: 'stream.started',
      payload: { step: 1 },
      idempotencyKey: 'key-1',
      actorType: 'system',
      actorId: 'worker-a'
    })

    const second = await ledger.appendEvent({
      streamId: stream.id,
      eventType: 'stream.progressed',
      payload: { step: 2 },
      idempotencyKey: 'key-2',
      actorType: 'system',
      actorId: 'worker-a'
    })

    expect(first.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(false)
    expect(first.event.seq_no).toBe(1)
    expect(second.event.seq_no).toBe(2)
    expect(second.event.prev_hash).toBe(first.event.event_hash)
    expect(second.event.event_hash).not.toBe(first.event.event_hash)

    const updatedStream = await repo.getStream(stream.id)
    expect(updatedStream?.last_seq_no).toBe(2)
  })

  it('deduplicates by idempotency key', async () => {
    const repo = new InMemoryAutonomyRepository()
    const stream = repo.createStream({
      id: 'stream-ledger-2',
      workflow_type: 'provisioning',
      owner_user_id: 'user-2'
    })
    const ledger = new AutonomyLedgerService(repo)

    const first = await ledger.appendEvent({
      streamId: stream.id,
      eventType: 'provisioning.creating',
      payload: { status: 'creating' },
      idempotencyKey: 'same-key'
    })

    const second = await ledger.appendEvent({
      streamId: stream.id,
      eventType: 'provisioning.creating',
      payload: { status: 'creating' },
      idempotencyKey: 'same-key'
    })

    expect(first.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(true)
    expect(second.event.id).toBe(first.event.id)

    const latest = await repo.getLatestEvent(stream.id)
    expect(latest?.seq_no).toBe(1)
  })

  it('blocks sensitive non-system writes and records policy.violation event', async () => {
    const repo = new InMemoryAutonomyRepository()
    const stream = repo.createStream({
      id: 'stream-ledger-policy',
      workflow_type: 'factory',
      owner_user_id: 'user-9'
    })
    const ledger = new AutonomyLedgerService(repo)

    try {
      await ledger.appendEvent({
        streamId: stream.id,
        eventType: 'step.succeeded',
        payload: { to_phase: 'research' },
        idempotencyKey: 'policy-denied-key',
        actorType: 'user',
        actorId: 'user-9'
      })
      throw new Error('expected policy violation')
    } catch (error) {
      expect(error instanceof AutonomyPolicyViolationError).toBe(true)
    }

    const events = await repo.getEvents(stream.id)
    expect(events).toHaveLength(1)
    expect(events[0].event_type).toBe('policy.violation')
    expect(events[0].payload_json.denied_event_type).toBe('step.succeeded')
    expect(events[0].payload_json.denied_actor_type).toBe('user')
  })
})
