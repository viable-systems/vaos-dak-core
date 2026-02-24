import { createHash } from 'crypto'

import type { NewAutonomyEvent } from './types'

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null'
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `"${k}":${stableStringify(v)}`)
    return `{${entries.join(',')}}`
  }

  if (typeof value === 'string') {
    return JSON.stringify(value)
  }

  return String(value)
}

export function computeAutonomyDigest(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

export function computeAutonomyEventHash(event: Omit<NewAutonomyEvent, 'event_hash'>): string {
  const canonical = stableStringify({
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

  return createHash('sha256').update(canonical).digest('hex')
}
