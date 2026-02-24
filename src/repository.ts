import { supabase } from '@/lib/supabase'
import {
  AutonomyRepositoryError,
  type AutonomyRepository
} from './repository-types'
import type {
  AutonomyDeadLetter,
  AutonomyEvent,
  AutonomyLease,
  AutonomySnapshot,
  AutonomySnapshotState,
  AutonomyStream,
  AutonomyStreamUpdate,
  NewAutonomyDeadLetter,
  NewAutonomyEvent,
  NewAutonomyLease,
  NewAutonomySnapshot,
} from './types'

function isUniqueViolation(code: unknown): boolean {
  return typeof code === 'string' && code === '23505'
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function toAutonomyEvent(row: unknown): AutonomyEvent {
  const record = normalizeRecord(row)
  return {
    id: String(record.id),
    stream_id: String(record.stream_id),
    seq_no: Number(record.seq_no),
    event_type: String(record.event_type),
    payload_json: normalizeRecord(record.payload_json),
    metadata_json: normalizeRecord(record.metadata_json),
    idempotency_key: String(record.idempotency_key),
    prev_hash: record.prev_hash ? String(record.prev_hash) : null,
    event_hash: String(record.event_hash),
    actor_type: record.actor_type ? String(record.actor_type) : null,
    actor_id: record.actor_id ? String(record.actor_id) : null,
    created_at: String(record.created_at)
  }
}

function toAutonomyStream(row: unknown): AutonomyStream {
  const record = normalizeRecord(row)
  return {
    id: String(record.id),
    workflow_type: (record.workflow_type as AutonomyStream['workflow_type']) || 'factory',
    owner_user_id: String(record.owner_user_id),
    status: (record.status as AutonomyStream['status']) || 'pending',
    current_state: normalizeRecord(record.current_state),
    last_seq_no: Number(record.last_seq_no || 0),
    retry_count: Number(record.retry_count || 0),
    max_retries: Number(record.max_retries || 0),
    next_tick_at: record.next_tick_at ? String(record.next_tick_at) : null,
    last_error: record.last_error ? String(record.last_error) : null,
    created_at: String(record.created_at),
    updated_at: String(record.updated_at)
  }
}

function toAutonomyLease(row: unknown): AutonomyLease {
  const record = normalizeRecord(row)
  return {
    stream_id: String(record.stream_id),
    worker_id: String(record.worker_id),
    lease_expires_at: String(record.lease_expires_at),
    heartbeat_at: String(record.heartbeat_at),
    created_at: String(record.created_at),
    updated_at: String(record.updated_at)
  }
}

function toAutonomyDeadLetter(row: unknown): AutonomyDeadLetter {
  const record = normalizeRecord(row)
  return {
    id: String(record.id),
    stream_id: String(record.stream_id),
    terminal_reason: String(record.terminal_reason),
    attempts: Number(record.attempts || 0),
    last_error: record.last_error ? String(record.last_error) : null,
    last_event_id: record.last_event_id ? String(record.last_event_id) : null,
    created_at: String(record.created_at)
  }
}

function toAutonomySnapshotState(row: unknown): AutonomySnapshotState {
  const record = normalizeRecord(row)
  return {
    status: (record.status as AutonomySnapshotState['status']) || 'pending',
    phase: String(record.phase || ''),
    retry_count: Number(record.retry_count || 0),
    last_error: record.last_error ? String(record.last_error) : null,
    workflow_type: (record.workflow_type as AutonomySnapshotState['workflow_type']) || 'factory'
  }
}

function toAutonomySnapshot(row: unknown): AutonomySnapshot {
  const record = normalizeRecord(row)
  return {
    id: String(record.id),
    stream_id: String(record.stream_id),
    last_seq_no: Number(record.last_seq_no || 0),
    state_blob: toAutonomySnapshotState(record.state_blob),
    state_hash: String(record.state_hash || ''),
    created_at: String(record.created_at),
    updated_at: String(record.updated_at)
  }
}

export class SupabaseAutonomyRepository implements AutonomyRepository {
  async streamExists(streamId: string): Promise<boolean> {
    const { data, error } = await supabase
      .from('autonomy_streams')
      .select('id')
      .eq('id', streamId)
      .maybeSingle()

    if (error) {
      throw new AutonomyRepositoryError('Failed to check stream existence', 'database_error', {
        streamId,
        error
      })
    }

    return !!data
  }

  async getStream(streamId: string): Promise<AutonomyStream | null> {
    const { data, error } = await supabase
      .from('autonomy_streams')
      .select('*')
      .eq('id', streamId)
      .maybeSingle()

    if (error) {
      throw new AutonomyRepositoryError('Failed to fetch autonomy stream', 'database_error', {
        streamId,
        error
      })
    }

    return data ? toAutonomyStream(data) : null
  }

  async updateStream(streamId: string, changes: AutonomyStreamUpdate): Promise<AutonomyStream | null> {
    const payload: Record<string, unknown> = { ...changes, updated_at: new Date().toISOString() }
    const { data, error } = await supabase
      .from('autonomy_streams')
      .update(payload)
      .eq('id', streamId)
      .select('*')
      .maybeSingle()

    if (error) {
      throw new AutonomyRepositoryError('Failed to update autonomy stream', 'database_error', {
        streamId,
        changes,
        error
      })
    }

    return data ? toAutonomyStream(data) : null
  }

  async listRunnableStreams(now: Date, limit: number): Promise<AutonomyStream[]> {
    const iso = now.toISOString()
    const { data, error } = await supabase
      .from('autonomy_streams')
      .select('*')
      .in('status', ['pending', 'running', 'retry_scheduled'])
      .lte('next_tick_at', iso)
      .order('next_tick_at', { ascending: true })
      .limit(limit)

    if (error) {
      throw new AutonomyRepositoryError('Failed to list runnable autonomy streams', 'database_error', {
        now: iso,
        limit,
        error
      })
    }

    return (data || []).map(toAutonomyStream)
  }

  async getEvents(streamId: string): Promise<AutonomyEvent[]> {
    const { data, error } = await supabase
      .from('autonomy_events')
      .select('*')
      .eq('stream_id', streamId)
      .order('seq_no', { ascending: true })

    if (error) {
      throw new AutonomyRepositoryError('Failed to fetch autonomy events', 'database_error', {
        streamId,
        error
      })
    }

    return (data || []).map(toAutonomyEvent)
  }

  async getEventsAfterSequence(streamId: string, afterSeqNo: number): Promise<AutonomyEvent[]> {
    const { data, error } = await supabase
      .from('autonomy_events')
      .select('*')
      .eq('stream_id', streamId)
      .gt('seq_no', afterSeqNo)
      .order('seq_no', { ascending: true })

    if (error) {
      throw new AutonomyRepositoryError('Failed to fetch autonomy events after sequence', 'database_error', {
        streamId,
        afterSeqNo,
        error
      })
    }

    return (data || []).map(toAutonomyEvent)
  }

  async getLatestEvent(streamId: string): Promise<AutonomyEvent | null> {
    const { data, error } = await supabase
      .from('autonomy_events')
      .select('*')
      .eq('stream_id', streamId)
      .order('seq_no', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      throw new AutonomyRepositoryError('Failed to fetch latest autonomy event', 'database_error', {
        streamId,
        error
      })
    }

    return data ? toAutonomyEvent(data) : null
  }

  async getEventByIdempotencyKey(streamId: string, idempotencyKey: string): Promise<AutonomyEvent | null> {
    const { data, error } = await supabase
      .from('autonomy_events')
      .select('*')
      .eq('stream_id', streamId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle()

    if (error) {
      throw new AutonomyRepositoryError('Failed to fetch autonomy event by idempotency key', 'database_error', {
        streamId,
        idempotencyKey,
        error
      })
    }

    return data ? toAutonomyEvent(data) : null
  }

  async insertEvent(event: NewAutonomyEvent): Promise<AutonomyEvent> {
    const { data, error } = await supabase
      .from('autonomy_events')
      .insert([event])
      .select('*')
      .single()

    if (error) {
      if (isUniqueViolation((error as { code?: unknown }).code)) {
        throw new AutonomyRepositoryError('Autonomy event insert conflict', 'conflict', {
          streamId: event.stream_id,
          idempotencyKey: event.idempotency_key,
          seqNo: event.seq_no,
          error
        })
      }
      throw new AutonomyRepositoryError('Failed to insert autonomy event', 'database_error', {
        streamId: event.stream_id,
        idempotencyKey: event.idempotency_key,
        seqNo: event.seq_no,
        error
      })
    }

    return toAutonomyEvent(data)
  }

  async advanceStreamSequence(streamId: string, nextSeqNo: number): Promise<void> {
    const { error } = await supabase
      .from('autonomy_streams')
      .update({
        last_seq_no: nextSeqNo,
        updated_at: new Date().toISOString()
      })
      .eq('id', streamId)
      .lt('last_seq_no', nextSeqNo)

    if (error) {
      throw new AutonomyRepositoryError('Failed to advance autonomy stream sequence', 'database_error', {
        streamId,
        nextSeqNo,
        error
      })
    }
  }

  async getLease(streamId: string): Promise<AutonomyLease | null> {
    const { data, error } = await supabase
      .from('autonomy_leases')
      .select('*')
      .eq('stream_id', streamId)
      .maybeSingle()

    if (error) {
      throw new AutonomyRepositoryError('Failed to fetch autonomy lease', 'database_error', {
        streamId,
        error
      })
    }

    return data ? toAutonomyLease(data) : null
  }

  async createLease(lease: NewAutonomyLease): Promise<AutonomyLease> {
    const { data, error } = await supabase
      .from('autonomy_leases')
      .insert([lease])
      .select('*')
      .single()

    if (error) {
      if (isUniqueViolation((error as { code?: unknown }).code)) {
        throw new AutonomyRepositoryError('Autonomy lease conflict', 'conflict', {
          streamId: lease.stream_id,
          workerId: lease.worker_id,
          error
        })
      }
      throw new AutonomyRepositoryError('Failed to create autonomy lease', 'database_error', {
        streamId: lease.stream_id,
        workerId: lease.worker_id,
        error
      })
    }

    return toAutonomyLease(data)
  }

  async updateLeaseIfCurrentHolder(
    streamId: string,
    expectedWorkerId: string,
    nextLease: NewAutonomyLease
  ): Promise<AutonomyLease | null> {
    const { data, error } = await supabase
      .from('autonomy_leases')
      .update({
        worker_id: nextLease.worker_id,
        lease_expires_at: nextLease.lease_expires_at,
        heartbeat_at: nextLease.heartbeat_at,
        updated_at: new Date().toISOString()
      })
      .eq('stream_id', streamId)
      .eq('worker_id', expectedWorkerId)
      .select('*')
      .maybeSingle()

    if (error) {
      throw new AutonomyRepositoryError('Failed to update autonomy lease', 'database_error', {
        streamId,
        expectedWorkerId,
        nextWorkerId: nextLease.worker_id,
        error
      })
    }

    return data ? toAutonomyLease(data) : null
  }

  async deleteLease(streamId: string, workerId: string): Promise<boolean> {
    const { error } = await supabase
      .from('autonomy_leases')
      .delete()
      .eq('stream_id', streamId)
      .eq('worker_id', workerId)

    if (error) {
      throw new AutonomyRepositoryError('Failed to delete autonomy lease', 'database_error', {
        streamId,
        workerId,
        error
      })
    }

    return true
  }

  async insertDeadLetter(record: NewAutonomyDeadLetter): Promise<AutonomyDeadLetter> {
    const { data, error } = await supabase
      .from('autonomy_dead_letters')
      .insert([{
        stream_id: record.stream_id,
        terminal_reason: record.terminal_reason,
        attempts: record.attempts,
        last_error: record.last_error || null,
        last_event_id: record.last_event_id || null
      }])
      .select('*')
      .single()

    if (error) {
      throw new AutonomyRepositoryError('Failed to insert autonomy dead letter', 'database_error', {
        streamId: record.stream_id,
        error
      })
    }

    return toAutonomyDeadLetter(data)
  }

  async getLatestDeadLetter(streamId: string): Promise<AutonomyDeadLetter | null> {
    const { data, error } = await supabase
      .from('autonomy_dead_letters')
      .select('*')
      .eq('stream_id', streamId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      throw new AutonomyRepositoryError('Failed to fetch latest autonomy dead letter', 'database_error', {
        streamId,
        error
      })
    }

    return data ? toAutonomyDeadLetter(data) : null
  }

  async upsertSnapshot(snapshot: NewAutonomySnapshot): Promise<AutonomySnapshot> {
    const { data, error } = await supabase
      .from('autonomy_snapshots')
      .upsert([{
        stream_id: snapshot.stream_id,
        last_seq_no: snapshot.last_seq_no,
        state_blob: snapshot.state_blob,
        state_hash: snapshot.state_hash
      }], {
        onConflict: 'stream_id',
        ignoreDuplicates: false
      })
      .select('*')
      .single()

    if (error) {
      throw new AutonomyRepositoryError('Failed to upsert autonomy snapshot', 'database_error', {
        streamId: snapshot.stream_id,
        lastSeqNo: snapshot.last_seq_no,
        error
      })
    }

    return toAutonomySnapshot(data)
  }

  async getLatestSnapshot(streamId: string): Promise<AutonomySnapshot | null> {
    const { data, error } = await supabase
      .from('autonomy_snapshots')
      .select('*')
      .eq('stream_id', streamId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      throw new AutonomyRepositoryError('Failed to fetch autonomy snapshot', 'database_error', {
        streamId,
        error
      })
    }

    return data ? toAutonomySnapshot(data) : null
  }
}
