import { randomUUID } from 'crypto'

import {
  AutonomyRepositoryError,
  type AutonomyRepository
} from './repository-types'
import type {
  AutonomyDeadLetter,
  AutonomyEvent,
  AutonomyLease,
  AutonomySnapshot,
  AutonomyStream,
  AutonomyStreamUpdate,
  NewAutonomyDeadLetter,
  NewAutonomyEvent,
  NewAutonomyLease,
  NewAutonomySnapshot
} from './types'

export class InMemoryAutonomyRepository implements AutonomyRepository {
  private streams = new Map<string, AutonomyStream>()
  private eventsByStream = new Map<string, AutonomyEvent[]>()
  private leases = new Map<string, AutonomyLease>()
  private deadLettersByStream = new Map<string, AutonomyDeadLetter[]>()
  private snapshotsByStream = new Map<string, AutonomySnapshot>()

  createStream(stream: Pick<AutonomyStream, 'id' | 'workflow_type' | 'owner_user_id'> & Partial<AutonomyStream>): AutonomyStream {
    const nowIso = new Date().toISOString()
    const row: AutonomyStream = {
      id: stream.id,
      workflow_type: stream.workflow_type,
      owner_user_id: stream.owner_user_id,
      status: stream.status || 'pending',
      current_state: stream.current_state || {},
      last_seq_no: stream.last_seq_no || 0,
      retry_count: stream.retry_count || 0,
      max_retries: stream.max_retries || 5,
      next_tick_at: stream.next_tick_at || nowIso,
      last_error: stream.last_error || null,
      created_at: stream.created_at || nowIso,
      updated_at: stream.updated_at || nowIso
    }
    this.streams.set(row.id, row)
    return { ...row }
  }

  async streamExists(streamId: string): Promise<boolean> {
    return this.streams.has(streamId)
  }

  async getStream(streamId: string): Promise<AutonomyStream | null> {
    const stream = this.streams.get(streamId)
    return stream ? { ...stream, current_state: { ...stream.current_state } } : null
  }

  async updateStream(streamId: string, changes: AutonomyStreamUpdate): Promise<AutonomyStream | null> {
    const stream = this.streams.get(streamId)
    if (!stream) {
      return null
    }

    const updated: AutonomyStream = {
      ...stream,
      ...changes,
      current_state: changes.current_state ? { ...changes.current_state } : stream.current_state,
      updated_at: new Date().toISOString()
    }

    this.streams.set(streamId, updated)
    return { ...updated, current_state: { ...updated.current_state } }
  }

  async listRunnableStreams(now: Date, limit: number): Promise<AutonomyStream[]> {
    return [...this.streams.values()]
      .filter(stream => {
        if (!stream.next_tick_at) {
          return false
        }
        const runnableStatus = stream.status === 'pending' || stream.status === 'running' || stream.status === 'retry_scheduled'
        return runnableStatus && new Date(stream.next_tick_at).getTime() <= now.getTime()
      })
      .sort((a, b) => {
        const aTick = a.next_tick_at ? new Date(a.next_tick_at).getTime() : 0
        const bTick = b.next_tick_at ? new Date(b.next_tick_at).getTime() : 0
        return aTick - bTick
      })
      .slice(0, limit)
      .map(stream => ({ ...stream, current_state: { ...stream.current_state } }))
  }

  async getEvents(streamId: string): Promise<AutonomyEvent[]> {
    return (this.eventsByStream.get(streamId) || []).map(event => ({ ...event }))
  }

  async getEventsAfterSequence(streamId: string, afterSeqNo: number): Promise<AutonomyEvent[]> {
    return (this.eventsByStream.get(streamId) || [])
      .filter(event => event.seq_no > afterSeqNo)
      .map(event => ({ ...event }))
  }

  async getLatestEvent(streamId: string): Promise<AutonomyEvent | null> {
    const events = this.eventsByStream.get(streamId)
    if (!events || events.length === 0) {
      return null
    }
    return { ...events[events.length - 1] }
  }

  async getEventByIdempotencyKey(streamId: string, idempotencyKey: string): Promise<AutonomyEvent | null> {
    const events = this.eventsByStream.get(streamId) || []
    const found = events.find(event => event.idempotency_key === idempotencyKey)
    return found ? { ...found } : null
  }

  async insertEvent(event: NewAutonomyEvent): Promise<AutonomyEvent> {
    const events = this.eventsByStream.get(event.stream_id) || []
    const duplicateSeq = events.some(existing => existing.seq_no === event.seq_no)
    const duplicateKey = events.some(existing => existing.idempotency_key === event.idempotency_key)
    if (duplicateSeq || duplicateKey) {
      throw new AutonomyRepositoryError('Duplicate event', 'conflict', {
        streamId: event.stream_id,
        seqNo: event.seq_no,
        idempotencyKey: event.idempotency_key
      })
    }

    const inserted: AutonomyEvent = {
      id: randomUUID(),
      ...event
    }
    this.eventsByStream.set(event.stream_id, [...events, inserted])
    return { ...inserted }
  }

  async advanceStreamSequence(streamId: string, nextSeqNo: number): Promise<void> {
    const stream = this.streams.get(streamId)
    if (!stream) {
      throw new AutonomyRepositoryError('Stream not found', 'not_found', { streamId })
    }
    if (nextSeqNo > stream.last_seq_no) {
      stream.last_seq_no = nextSeqNo
      stream.updated_at = new Date().toISOString()
      this.streams.set(streamId, stream)
    }
  }

  async getLease(streamId: string): Promise<AutonomyLease | null> {
    const lease = this.leases.get(streamId)
    return lease ? { ...lease } : null
  }

  async createLease(lease: NewAutonomyLease): Promise<AutonomyLease> {
    if (this.leases.has(lease.stream_id)) {
      throw new AutonomyRepositoryError('Lease already exists', 'conflict', { streamId: lease.stream_id })
    }
    const nowIso = new Date().toISOString()
    const inserted: AutonomyLease = {
      ...lease,
      created_at: nowIso,
      updated_at: nowIso
    }
    this.leases.set(lease.stream_id, inserted)
    return { ...inserted }
  }

  async updateLeaseIfCurrentHolder(
    streamId: string,
    expectedWorkerId: string,
    nextLease: NewAutonomyLease
  ): Promise<AutonomyLease | null> {
    const current = this.leases.get(streamId)
    if (!current || current.worker_id !== expectedWorkerId) {
      return null
    }
    const updated: AutonomyLease = {
      ...current,
      worker_id: nextLease.worker_id,
      lease_expires_at: nextLease.lease_expires_at,
      heartbeat_at: nextLease.heartbeat_at,
      updated_at: new Date().toISOString()
    }
    this.leases.set(streamId, updated)
    return { ...updated }
  }

  async deleteLease(streamId: string, workerId: string): Promise<boolean> {
    const current = this.leases.get(streamId)
    if (!current || current.worker_id !== workerId) {
      return false
    }
    this.leases.delete(streamId)
    return true
  }

  async insertDeadLetter(record: NewAutonomyDeadLetter): Promise<AutonomyDeadLetter> {
    const existing = this.deadLettersByStream.get(record.stream_id) || []
    const inserted: AutonomyDeadLetter = {
      id: randomUUID(),
      stream_id: record.stream_id,
      terminal_reason: record.terminal_reason,
      attempts: record.attempts,
      last_error: record.last_error || null,
      last_event_id: record.last_event_id || null,
      created_at: new Date().toISOString()
    }
    this.deadLettersByStream.set(record.stream_id, [...existing, inserted])
    return { ...inserted }
  }

  async getLatestDeadLetter(streamId: string): Promise<AutonomyDeadLetter | null> {
    const entries = this.deadLettersByStream.get(streamId) || []
    if (entries.length === 0) {
      return null
    }
    return { ...entries[entries.length - 1] }
  }

  async upsertSnapshot(snapshot: NewAutonomySnapshot): Promise<AutonomySnapshot> {
    const existing = this.snapshotsByStream.get(snapshot.stream_id)
    const nowIso = new Date().toISOString()
    const next: AutonomySnapshot = {
      id: existing?.id || randomUUID(),
      stream_id: snapshot.stream_id,
      last_seq_no: snapshot.last_seq_no,
      state_blob: { ...snapshot.state_blob },
      state_hash: snapshot.state_hash,
      created_at: existing?.created_at || nowIso,
      updated_at: nowIso
    }
    this.snapshotsByStream.set(snapshot.stream_id, next)
    return {
      ...next,
      state_blob: { ...next.state_blob }
    }
  }

  async getLatestSnapshot(streamId: string): Promise<AutonomySnapshot | null> {
    const snapshot = this.snapshotsByStream.get(streamId)
    if (!snapshot) {
      return null
    }
    return {
      ...snapshot,
      state_blob: { ...snapshot.state_blob }
    }
  }
}
