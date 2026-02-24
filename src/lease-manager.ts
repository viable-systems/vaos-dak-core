import type { AutonomyRepository } from './repository-types'
import type {
  AcquireLeaseInput,
  AcquireLeaseResult,
  AutonomyLease,
  NewAutonomyLease
} from './types'

export class AutonomyLeaseManager {
  constructor(private readonly repository: AutonomyRepository) {}

  async acquireLease(input: AcquireLeaseInput): Promise<AcquireLeaseResult> {
    const now = input.now || new Date()

    if (!(await this.repository.streamExists(input.streamId))) {
      return {
        acquired: false,
        lease: null,
        reason: 'stream_not_found'
      }
    }

    const leasePayload: NewAutonomyLease = {
      stream_id: input.streamId,
      worker_id: input.workerId,
      heartbeat_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + input.leaseTtlMs).toISOString()
    }

    const existing = await this.repository.getLease(input.streamId)

    if (!existing) {
      try {
        const created = await this.repository.createLease(leasePayload)
        return { acquired: true, lease: created }
      } catch {
        const afterConflict = await this.repository.getLease(input.streamId)
        return {
          acquired: false,
          lease: afterConflict,
          reason: 'held_by_other'
        }
      }
    }

    const isOwner = existing.worker_id === input.workerId
    const isExpired = new Date(existing.lease_expires_at).getTime() <= now.getTime()

    if (!isOwner && !isExpired) {
      return {
        acquired: false,
        lease: existing,
        reason: 'held_by_other'
      }
    }

    const updated = await this.repository.updateLeaseIfCurrentHolder(
      input.streamId,
      existing.worker_id,
      leasePayload
    )

    if (!updated) {
      const current = await this.repository.getLease(input.streamId)
      return {
        acquired: false,
        lease: current,
        reason: 'held_by_other'
      }
    }

    return { acquired: true, lease: updated }
  }

  async heartbeatLease(streamId: string, workerId: string, leaseTtlMs: number, now: Date = new Date()): Promise<AutonomyLease | null> {
    const current = await this.repository.getLease(streamId)
    if (!current || current.worker_id !== workerId) {
      return null
    }

    const nextLease: NewAutonomyLease = {
      stream_id: streamId,
      worker_id: workerId,
      heartbeat_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + leaseTtlMs).toISOString()
    }

    return this.repository.updateLeaseIfCurrentHolder(streamId, workerId, nextLease)
  }

  async releaseLease(streamId: string, workerId: string): Promise<boolean> {
    return this.repository.deleteLease(streamId, workerId)
  }
}
