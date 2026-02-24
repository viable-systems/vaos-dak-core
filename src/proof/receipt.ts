import { createHmac } from 'crypto'

import { computeAutonomyDigest, computeAutonomyEventHash } from '../hash'
import { reduceAutonomyStream, type ReducedAutonomyState } from '../reducer'
import type {
  AutonomyEvent,
  AutonomySnapshot,
  AutonomySnapshotState,
  AutonomyStream
} from '../types'

const RECEIPT_SCHEMA_VERSION = '1.0.0'
const DEFAULT_ENGINE_VERSION = 'dak-core@0.1.0'

export interface DeterminismReceipt {
  schema_version: string
  engine_version: string
  stream_id: string
  tick_id: string
  event_count: number
  first_seq_no: number | null
  last_seq_no: number | null
  event_chain_root: string
  replay_state_hash: string
  policy_decision_hash: string
  snapshot_state_hash: string | null
  generated_at: string
  signature: string | null
}

export interface BuildDeterminismReceiptInput {
  stream: AutonomyStream
  events: AutonomyEvent[]
  tickId: string
  reducedState?: ReducedAutonomyState
  snapshot?: Pick<AutonomySnapshot, 'state_blob'> | null
  generatedAt?: string
  engineVersion?: string
  signingSecret?: string
}

export interface EventHashChainResult {
  valid: boolean
  chainRoot: string
  issues: string[]
}

export interface VerifyDeterminismReceiptResult {
  valid: boolean
  issues: string[]
  expected: DeterminismReceipt
}

function digestPolicyEvents(events: AutonomyEvent[]): string {
  const policyEvents = events
    .filter(event =>
      event.event_type === 'policy.violation'
      || event.event_type === 'adaptation.applied'
      || event.event_type === 'retry.scheduled'
      || event.event_type === 'stream.failed_terminal'
      || event.event_type === 'stream.marked_inconsistent'
    )
    .map(event => ({
      seq_no: event.seq_no,
      event_type: event.event_type,
      payload_json: event.payload_json,
      metadata_json: event.metadata_json
    }))

  return computeAutonomyDigest(policyEvents)
}

function signaturePayload(receipt: Omit<DeterminismReceipt, 'signature'>): string {
  return JSON.stringify(receipt)
}

function signReceipt(receipt: Omit<DeterminismReceipt, 'signature'>, secret?: string): string | null {
  if (!secret) {
    return null
  }
  return createHmac('sha256', secret).update(signaturePayload(receipt)).digest('hex')
}

export function verifyEventHashChain(events: AutonomyEvent[]): EventHashChainResult {
  const issues: string[] = []

  if (events.length === 0) {
    return {
      valid: true,
      issues,
      chainRoot: computeAutonomyDigest([])
    }
  }

  const sorted = [...events].sort((a, b) => a.seq_no - b.seq_no)
  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index]
    const previous = sorted[index - 1]

    const expectedHash = computeAutonomyEventHash({
      stream_id: event.stream_id,
      seq_no: event.seq_no,
      event_type: event.event_type,
      payload_json: event.payload_json,
      metadata_json: event.metadata_json,
      idempotency_key: event.idempotency_key,
      prev_hash: event.prev_hash,
      actor_type: event.actor_type,
      actor_id: event.actor_id,
      created_at: event.created_at
    })

    if (expectedHash !== event.event_hash) {
      issues.push(`event_hash_mismatch_at_seq_${event.seq_no}`)
    }

    if (index === 0) {
      if (event.prev_hash !== null) {
        issues.push(`first_event_prev_hash_not_null_at_seq_${event.seq_no}`)
      }
    } else {
      if (event.prev_hash !== previous.event_hash) {
        issues.push(`prev_hash_mismatch_at_seq_${event.seq_no}`)
      }
      if (event.seq_no !== previous.seq_no + 1) {
        issues.push(`sequence_gap_between_${previous.seq_no}_and_${event.seq_no}`)
      }
      if (event.stream_id !== previous.stream_id) {
        issues.push(`mixed_stream_ids_at_seq_${event.seq_no}`)
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    chainRoot: computeAutonomyDigest(sorted.map(event => event.event_hash))
  }
}

function snapshotStateHash(snapshotState?: AutonomySnapshotState | null): string | null {
  if (!snapshotState) {
    return null
  }
  return computeAutonomyDigest(snapshotState)
}

export function buildDeterminismReceipt(input: BuildDeterminismReceiptInput): DeterminismReceipt {
  const chain = verifyEventHashChain(input.events)
  const reduced = input.reducedState || reduceAutonomyStream(input.stream, input.events)
  const generatedAt = input.generatedAt || new Date().toISOString()
  const sorted = [...input.events].sort((a, b) => a.seq_no - b.seq_no)

  const base: Omit<DeterminismReceipt, 'signature'> = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    engine_version: input.engineVersion || DEFAULT_ENGINE_VERSION,
    stream_id: input.stream.id,
    tick_id: input.tickId,
    event_count: sorted.length,
    first_seq_no: sorted.length > 0 ? sorted[0].seq_no : null,
    last_seq_no: sorted.length > 0 ? sorted[sorted.length - 1].seq_no : null,
    event_chain_root: chain.chainRoot,
    replay_state_hash: computeAutonomyDigest(reduced),
    policy_decision_hash: digestPolicyEvents(sorted),
    snapshot_state_hash: snapshotStateHash(input.snapshot?.state_blob),
    generated_at: generatedAt
  }

  return {
    ...base,
    signature: signReceipt(base, input.signingSecret)
  }
}

export function verifyDeterminismReceipt(
  receipt: DeterminismReceipt,
  input: Omit<BuildDeterminismReceiptInput, 'generatedAt'>
): VerifyDeterminismReceiptResult {
  const expected = buildDeterminismReceipt({
    ...input,
    generatedAt: receipt.generated_at,
    engineVersion: receipt.engine_version,
    signingSecret: input.signingSecret
  })

  const issues: string[] = []

  if (expected.schema_version !== receipt.schema_version) {
    issues.push('schema_version_mismatch')
  }
  if (expected.stream_id !== receipt.stream_id) {
    issues.push('stream_id_mismatch')
  }
  if (expected.tick_id !== receipt.tick_id) {
    issues.push('tick_id_mismatch')
  }
  if (expected.event_chain_root !== receipt.event_chain_root) {
    issues.push('event_chain_root_mismatch')
  }
  if (expected.replay_state_hash !== receipt.replay_state_hash) {
    issues.push('replay_state_hash_mismatch')
  }
  if (expected.policy_decision_hash !== receipt.policy_decision_hash) {
    issues.push('policy_decision_hash_mismatch')
  }
  if (expected.snapshot_state_hash !== receipt.snapshot_state_hash) {
    issues.push('snapshot_state_hash_mismatch')
  }
  if (expected.signature !== receipt.signature) {
    issues.push('signature_mismatch')
  }

  return {
    valid: issues.length === 0,
    issues,
    expected
  }
}
