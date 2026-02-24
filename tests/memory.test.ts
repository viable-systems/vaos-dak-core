import { describe, expect, it } from 'vitest'

import { buildConceptThreadGraph, extractConceptTokens, retrieveAutonomyMemory } from '../src/memory'
import type { AutonomyEvent, AutonomyStream } from '../src/types'

function event(overrides: Partial<AutonomyEvent>): AutonomyEvent {
  return {
    id: overrides.id || `evt-${overrides.seq_no || 1}`,
    stream_id: overrides.stream_id || 'stream-memory',
    seq_no: overrides.seq_no || 1,
    event_type: overrides.event_type || 'step.succeeded',
    payload_json: overrides.payload_json || {},
    metadata_json: overrides.metadata_json || {},
    idempotency_key: overrides.idempotency_key || `idem-${overrides.seq_no || 1}`,
    prev_hash: overrides.prev_hash || null,
    event_hash: overrides.event_hash || `hash-${overrides.seq_no || 1}`,
    actor_type: overrides.actor_type || 'system',
    actor_id: overrides.actor_id || 'worker',
    created_at: overrides.created_at || '2026-02-24T00:00:00.000Z'
  }
}

const stream: AutonomyStream = {
  id: 'stream-memory',
  workflow_type: 'factory',
  owner_user_id: 'user-memory',
  status: 'running',
  current_state: { phase: 'plan' },
  last_seq_no: 3,
  retry_count: 0,
  max_retries: 3,
  next_tick_at: '2026-02-24T00:00:00.000Z',
  last_error: null,
  created_at: '2026-02-24T00:00:00.000Z',
  updated_at: '2026-02-24T00:00:00.000Z'
}

describe('autonomy memory layer', () => {
  it('extracts stable concept tokens', () => {
    const tokens = extractConceptTokens('Deploy OpenClaw agent and verify Telegram webhook webhook')
    expect(tokens).toEqual([
      'deploy',
      'openclaw',
      'agent',
      'verify',
      'telegram',
      'webhook'
    ])
  })

  it('builds deterministic concept-thread graph from events', () => {
    const events = [
      event({
        seq_no: 1,
        event_type: 'stream.started',
        payload_json: { detail: 'Start provisioning OpenClaw workspace' }
      }),
      event({
        seq_no: 2,
        event_type: 'step.succeeded',
        payload_json: { detail: 'Configure telegram bot token' }
      }),
      event({
        seq_no: 3,
        event_type: 'step.succeeded',
        payload_json: { detail: 'Verify telegram webhook and deploy agent' }
      })
    ]

    const first = buildConceptThreadGraph(events)
    const second = buildConceptThreadGraph([...events].reverse())

    expect(first).toEqual(second)
    expect(first.events).toHaveLength(3)
    expect(first.concepts[0].concept).toBe('telegram')
    expect(first.edges.length).toBeGreaterThan(0)
  })

  it('retrieves relevant history using concept overlap and thread edges', () => {
    const events = [
      event({
        seq_no: 1,
        event_type: 'stream.started',
        payload_json: { detail: 'Initialize factory run for checkout flow' }
      }),
      event({
        seq_no: 2,
        event_type: 'step.succeeded',
        payload_json: { detail: 'Add telegram token validation and webhook setup' }
      }),
      event({
        seq_no: 3,
        event_type: 'retry.scheduled',
        payload_json: { error: 'telegram webhook timeout while deploying agent' }
      })
    ]

    const memory = retrieveAutonomyMemory({
      stream,
      events,
      query: 'telegram webhook deploy timeout',
      limit: 2
    })

    expect(memory.queryTokens).toEqual(['telegram', 'webhook', 'deploy', 'timeout'])
    expect(memory.items).toHaveLength(2)
    expect(memory.items[0].overlapConcepts).toContain('telegram')
    expect(memory.graph.conceptCount).toBeGreaterThan(3)
    expect(memory.threadEdges.length).toBeGreaterThan(0)
  })
})
