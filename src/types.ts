export type AutonomyWorkflowType = 'provisioning' | 'factory'

export type AutonomyStreamStatus =
  | 'pending'
  | 'running'
  | 'retry_scheduled'
  | 'completed'
  | 'failed_terminal'
  | 'inconsistent'

export interface AutonomyStream {
  id: string
  workflow_type: AutonomyWorkflowType
  owner_user_id: string
  status: AutonomyStreamStatus
  current_state: Record<string, unknown>
  last_seq_no: number
  retry_count: number
  max_retries: number
  next_tick_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface AutonomyStreamUpdate {
  status?: AutonomyStreamStatus
  current_state?: Record<string, unknown>
  retry_count?: number
  max_retries?: number
  next_tick_at?: string | null
  last_error?: string | null
  last_seq_no?: number
}

export interface AutonomyEvent {
  id: string
  stream_id: string
  seq_no: number
  event_type: string
  payload_json: Record<string, unknown>
  metadata_json: Record<string, unknown>
  idempotency_key: string
  prev_hash: string | null
  event_hash: string
  actor_type: string | null
  actor_id: string | null
  created_at: string
}

export interface NewAutonomyEvent {
  stream_id: string
  seq_no: number
  event_type: string
  payload_json: Record<string, unknown>
  metadata_json: Record<string, unknown>
  idempotency_key: string
  prev_hash: string | null
  event_hash: string
  actor_type: string | null
  actor_id: string | null
  created_at: string
}

export interface AutonomyLease {
  stream_id: string
  worker_id: string
  lease_expires_at: string
  heartbeat_at: string
  created_at: string
  updated_at: string
}

export interface NewAutonomyLease {
  stream_id: string
  worker_id: string
  lease_expires_at: string
  heartbeat_at: string
}

export interface AutonomyDeadLetter {
  id: string
  stream_id: string
  terminal_reason: string
  attempts: number
  last_error: string | null
  last_event_id: string | null
  created_at: string
}

export interface NewAutonomyDeadLetter {
  stream_id: string
  terminal_reason: string
  attempts: number
  last_error?: string | null
  last_event_id?: string | null
}

export interface AutonomySnapshotState {
  status: AutonomyStreamStatus
  phase: string
  retry_count: number
  last_error: string | null
  workflow_type: AutonomyWorkflowType
}

export interface AutonomySnapshot {
  id: string
  stream_id: string
  last_seq_no: number
  state_blob: AutonomySnapshotState
  state_hash: string
  created_at: string
  updated_at: string
}

export interface NewAutonomySnapshot {
  stream_id: string
  last_seq_no: number
  state_blob: AutonomySnapshotState
  state_hash: string
}

export interface AppendEventInput {
  streamId: string
  eventType: string
  payload?: Record<string, unknown>
  metadata?: Record<string, unknown>
  idempotencyKey: string
  actorType?: string | null
  actorId?: string | null
  createdAt?: string
}

export interface AppendEventResult {
  event: AutonomyEvent
  deduplicated: boolean
}

export interface AcquireLeaseInput {
  streamId: string
  workerId: string
  leaseTtlMs: number
  now?: Date
}

export interface AcquireLeaseResult {
  acquired: boolean
  lease: AutonomyLease | null
  reason?: 'held_by_other' | 'stream_not_found'
}
