import { defaultPhaseForWorkflow, isTerminalPhase } from './phases'
import type { AutonomyEvent, AutonomyStream, AutonomyStreamStatus } from './types'

export interface ReducedAutonomyState {
  streamId: string
  workflowType: AutonomyStream['workflow_type']
  status: AutonomyStreamStatus
  phase: string
  retryCount: number
  lastSeqNo: number
  lastError: string | null
  inconsistent: boolean
  reason?: string
}

export interface ReduceAutonomyStreamOptions {
  startSeqNo?: number
  seedState?: Partial<Pick<ReducedAutonomyState, 'status' | 'phase' | 'retryCount' | 'lastError' | 'lastSeqNo'>>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function reduceAutonomyStream(
  stream: AutonomyStream,
  events: AutonomyEvent[],
  options: ReduceAutonomyStreamOptions = {}
): ReducedAutonomyState {
  const startSeqNo = options.startSeqNo ?? 0
  const basePhase = asString(options.seedState?.phase)
    || asString(stream.current_state.phase)
    || defaultPhaseForWorkflow(stream.workflow_type)
  let status: AutonomyStreamStatus = options.seedState?.status || stream.status
  let phase = basePhase
  let retryCount = options.seedState?.retryCount ?? stream.retry_count
  let lastError: string | null = options.seedState?.lastError ?? stream.last_error
  let lastSeqNo = options.seedState?.lastSeqNo ?? startSeqNo
  const seenIdempotencyKeys = new Set<string>()

  if (events.length === 0) {
    return {
      streamId: stream.id,
      workflowType: stream.workflow_type,
      status,
      phase,
      retryCount,
      lastSeqNo,
      lastError,
      inconsistent: false
    }
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    const expectedSeq = startSeqNo + i + 1
    if (event.seq_no !== expectedSeq) {
      return {
        streamId: stream.id,
        workflowType: stream.workflow_type,
        status: 'inconsistent',
        phase,
        retryCount,
        lastSeqNo: event.seq_no,
        lastError,
        inconsistent: true,
        reason: `sequence_gap_at_${expectedSeq}`
      }
    }

    if (seenIdempotencyKeys.has(event.idempotency_key)) {
      lastSeqNo = event.seq_no
      continue
    }
    seenIdempotencyKeys.add(event.idempotency_key)

    switch (event.event_type) {
      case 'stream.started':
        status = 'running'
        break
      case 'step.succeeded': {
        const toPhase = asString(event.payload_json.to_phase)
        if (toPhase) {
          phase = toPhase
        }
        status = isTerminalPhase(stream.workflow_type, phase) ? 'completed' : 'running'
        lastError = null
        break
      }
      case 'retry.scheduled': {
        status = 'retry_scheduled'
        const retries = event.payload_json.retry_count
        if (typeof retries === 'number' && Number.isFinite(retries) && retries >= 0) {
          retryCount = retries
        }
        const errorMessage = asString(event.payload_json.error)
        lastError = errorMessage || lastError
        break
      }
      case 'stream.completed':
        status = 'completed'
        lastError = null
        break
      case 'stream.failed_terminal': {
        status = 'failed_terminal'
        const errorMessage = asString(event.payload_json.error)
        lastError = errorMessage || lastError
        const retries = event.payload_json.retry_count
        if (typeof retries === 'number' && Number.isFinite(retries) && retries >= 0) {
          retryCount = retries
        }
        break
      }
      case 'stream.marked_inconsistent':
        status = 'inconsistent'
        break
      default:
        // Unknown event types are retained in ledger but do not mutate reducer state directly.
        break
    }

    lastSeqNo = event.seq_no
  }

  return {
    streamId: stream.id,
    workflowType: stream.workflow_type,
    status,
    phase,
    retryCount,
    lastSeqNo,
    lastError,
    inconsistent: status === 'inconsistent'
  }
}
