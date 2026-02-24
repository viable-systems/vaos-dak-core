import { describe, expect, it } from 'vitest'

import { InMemoryAutonomyRepository } from '../src/in-memory-repository'
import { AutonomyLeaseManager } from '../src/lease-manager'

describe('AutonomyLeaseManager', () => {
  it('acquires a lease for an available stream', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-lease-1',
      workflow_type: 'factory',
      owner_user_id: 'user-1'
    })
    const manager = new AutonomyLeaseManager(repo)

    const result = await manager.acquireLease({
      streamId: 'stream-lease-1',
      workerId: 'worker-a',
      leaseTtlMs: 30_000,
      now: new Date('2026-02-24T12:00:00.000Z')
    })

    expect(result.acquired).toBe(true)
    expect(result.lease?.worker_id).toBe('worker-a')
  })

  it('blocks another worker while lease is active', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-lease-2',
      workflow_type: 'factory',
      owner_user_id: 'user-1'
    })
    const manager = new AutonomyLeaseManager(repo)

    await manager.acquireLease({
      streamId: 'stream-lease-2',
      workerId: 'worker-a',
      leaseTtlMs: 30_000,
      now: new Date('2026-02-24T12:00:00.000Z')
    })

    const blocked = await manager.acquireLease({
      streamId: 'stream-lease-2',
      workerId: 'worker-b',
      leaseTtlMs: 30_000,
      now: new Date('2026-02-24T12:00:10.000Z')
    })

    expect(blocked.acquired).toBe(false)
    expect(blocked.reason).toBe('held_by_other')
    expect(blocked.lease?.worker_id).toBe('worker-a')
  })

  it('allows takeover after lease expiry', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-lease-3',
      workflow_type: 'factory',
      owner_user_id: 'user-1'
    })
    const manager = new AutonomyLeaseManager(repo)

    await manager.acquireLease({
      streamId: 'stream-lease-3',
      workerId: 'worker-a',
      leaseTtlMs: 5_000,
      now: new Date('2026-02-24T12:00:00.000Z')
    })

    const takeover = await manager.acquireLease({
      streamId: 'stream-lease-3',
      workerId: 'worker-b',
      leaseTtlMs: 30_000,
      now: new Date('2026-02-24T12:00:10.000Z')
    })

    expect(takeover.acquired).toBe(true)
    expect(takeover.lease?.worker_id).toBe('worker-b')
  })

  it('renews and releases lease for owner', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-lease-4',
      workflow_type: 'provisioning',
      owner_user_id: 'user-2'
    })
    const manager = new AutonomyLeaseManager(repo)

    await manager.acquireLease({
      streamId: 'stream-lease-4',
      workerId: 'worker-a',
      leaseTtlMs: 10_000,
      now: new Date('2026-02-24T12:00:00.000Z')
    })

    const renewed = await manager.heartbeatLease(
      'stream-lease-4',
      'worker-a',
      20_000,
      new Date('2026-02-24T12:00:05.000Z')
    )

    expect(renewed).not.toBeNull()
    expect(renewed?.lease_expires_at).toBe('2026-02-24T12:00:25.000Z')

    const released = await manager.releaseLease('stream-lease-4', 'worker-a')
    expect(released).toBe(true)
    expect(await repo.getLease('stream-lease-4')).toBeNull()
  })
})

