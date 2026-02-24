import { computeAutonomyEventHash } from './hash'
import { evaluateAutonomyWritePolicy } from './policy-guard'
import {
  AutonomyRepositoryError,
  type AutonomyRepository
} from './repository-types'
import type {
  AppendEventInput,
  AppendEventResult,
  NewAutonomyEvent
} from './types'

export class AutonomyPolicyViolationError extends Error {
  constructor(
    message: string,
    public readonly reason: string
  ) {
    super(message)
    this.name = 'AutonomyPolicyViolationError'
  }
}

export class AutonomyLedgerService {
  constructor(private readonly repository: AutonomyRepository) {}

  async appendEvent(input: AppendEventInput): Promise<AppendEventResult> {
    const existing = await this.repository.getEventByIdempotencyKey(input.streamId, input.idempotencyKey)
    if (existing) {
      return { event: existing, deduplicated: true }
    }

    const policy = evaluateAutonomyWritePolicy({
      eventType: input.eventType,
      actorType: input.actorType
    })
    if (!policy.allowed) {
      await this.appendPolicyViolation(input, policy.reason || 'write_denied_by_policy')
      throw new AutonomyPolicyViolationError(
        `Autonomy write denied by policy for event type ${input.eventType}`,
        policy.reason || 'write_denied_by_policy'
      )
    }

    const stream = await this.repository.getStream(input.streamId)
    if (!stream) {
      throw new Error(`Autonomy stream not found: ${input.streamId}`)
    }

    const latestEvent = await this.repository.getLatestEvent(input.streamId)
    const nextSeqNo = (latestEvent?.seq_no ?? stream.last_seq_no) + 1
    const createdAt = input.createdAt || new Date().toISOString()

    const toHash: Omit<NewAutonomyEvent, 'event_hash'> = {
      stream_id: input.streamId,
      seq_no: nextSeqNo,
      event_type: input.eventType,
      payload_json: input.payload || {},
      metadata_json: input.metadata || {},
      idempotency_key: input.idempotencyKey,
      prev_hash: latestEvent?.event_hash || null,
      actor_type: input.actorType || null,
      actor_id: input.actorId || null,
      created_at: createdAt
    }

    const newEvent: NewAutonomyEvent = {
      ...toHash,
      event_hash: computeAutonomyEventHash(toHash)
    }

    try {
      const inserted = await this.repository.insertEvent(newEvent)
      await this.repository.advanceStreamSequence(input.streamId, inserted.seq_no)
      return { event: inserted, deduplicated: false }
    } catch (error) {
      if (error instanceof AutonomyRepositoryError && error.code === 'conflict') {
        const deduplicated = await this.repository.getEventByIdempotencyKey(input.streamId, input.idempotencyKey)
        if (deduplicated) {
          return { event: deduplicated, deduplicated: true }
        }
      }
      throw error
    }
  }

  private async appendPolicyViolation(input: AppendEventInput, reason: string): Promise<void> {
    const stream = await this.repository.getStream(input.streamId)
    if (!stream) {
      return
    }
    const latestEvent = await this.repository.getLatestEvent(input.streamId)
    const nextSeqNo = (latestEvent?.seq_no ?? stream.last_seq_no) + 1
    const createdAt = input.createdAt || new Date().toISOString()
    const violationPayload = {
      denied_event_type: input.eventType,
      denied_actor_type: input.actorType || null,
      reason
    }
    const violationMeta = {
      source: 'autonomy_policy_guard',
      denied_idempotency_key: input.idempotencyKey
    }
    const idempotencyKey = `policy-violation:${input.idempotencyKey}`
    const toHash: Omit<NewAutonomyEvent, 'event_hash'> = {
      stream_id: input.streamId,
      seq_no: nextSeqNo,
      event_type: 'policy.violation',
      payload_json: violationPayload,
      metadata_json: violationMeta,
      idempotency_key: idempotencyKey,
      prev_hash: latestEvent?.event_hash || null,
      actor_type: 'system',
      actor_id: 'autonomy-policy-guard',
      created_at: createdAt
    }
    const newEvent: NewAutonomyEvent = {
      ...toHash,
      event_hash: computeAutonomyEventHash(toHash)
    }

    try {
      const inserted = await this.repository.insertEvent(newEvent)
      await this.repository.advanceStreamSequence(input.streamId, inserted.seq_no)
    } catch (error) {
      if (error instanceof AutonomyRepositoryError && error.code === 'conflict') {
        return
      }
      throw error
    }
  }
}
