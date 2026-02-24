import { randomUUID } from 'crypto'

import { computeBoundedAdaptationDecision } from './adaptation'
import { computeAutonomyDigest } from './hash'
import { retrieveAutonomyMemory, type RetrievedMemoryContext } from './memory'
import { defaultPhaseForWorkflow, isTerminalPhase, nextPhaseForWorkflow } from './phases'
import { AutonomyLedgerService } from './ledger'
import { AutonomyLeaseManager } from './lease-manager'
import type { AutonomyRepository } from './repository-types'
import { reduceAutonomyStream } from './reducer'
import { computeRetryBackoffMs } from './retry-policy'
import type { AutonomyEvent, AutonomyStream } from './types'

export interface TransitionExecutionInput {
  stream: AutonomyStream
  fromPhase: string
  toPhase: string
  tickId: string
  now: Date
  memoryContext?: RetrievedMemoryContext
}

export type TransitionExecutor = (input: TransitionExecutionInput) => Promise<void> | void

export interface RunTickInput {
  streamId: string
  tickId?: string
  now?: Date
}

export type TickOutcome =
  | 'processed'
  | 'completed'
  | 'retry_scheduled'
  | 'failed_terminal'
  | 'inconsistent_stream'
  | 'already_processed'
  | 'not_runnable'
  | 'lease_not_acquired'
  | 'not_found'

export interface RunTickResult {
  streamId: string
  tickId: string
  outcome: TickOutcome
  eventType?: string
  nextTickAt?: string | null
  retryCount?: number
  reason?: string
  durationMs: number
}

export interface ProcessRunnableStreamsInput {
  now?: Date
  limit?: number
  slotId?: string
}

export interface ProcessRunnableStreamsResult {
  workerId: string
  startedAt: string
  slotId?: string
  attempted: number
  processed: number
  results: RunTickResult[]
}

export interface AutonomyTickEngineOptions {
  repository: AutonomyRepository
  ledger: AutonomyLedgerService
  leaseManager: AutonomyLeaseManager
  workerId?: string
  leaseTtlMs?: number
  tickBudgetMs?: number
  tickDelayMs?: number
  snapshotInterval?: number
  maxAdaptationAttempts?: number
  transitionExecutor?: TransitionExecutor
  clock?: () => Date
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutErrorMessage: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutErrorMessage)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

function computeDurationMs(startedAt: number): number {
  return Date.now() - startedAt
}

export class AutonomyTickEngine {
  private readonly workerId: string
  private readonly leaseTtlMs: number
  private readonly tickBudgetMs: number
  private readonly tickDelayMs: number
  private readonly snapshotInterval: number
  private readonly maxAdaptationAttempts: number
  private readonly transitionExecutor: TransitionExecutor
  private readonly clock: () => Date

  constructor(private readonly options: AutonomyTickEngineOptions) {
    this.workerId = options.workerId || `worker-${randomUUID()}`
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000
    this.tickBudgetMs = options.tickBudgetMs ?? 30_000
    this.tickDelayMs = options.tickDelayMs ?? 5_000
    this.snapshotInterval = Math.max(1, options.snapshotInterval ?? 25)
    this.maxAdaptationAttempts = Math.max(1, options.maxAdaptationAttempts ?? 3)
    this.transitionExecutor = options.transitionExecutor || (() => {})
    this.clock = options.clock || (() => new Date())
  }

  async processRunnableStreams(input: ProcessRunnableStreamsInput = {}): Promise<ProcessRunnableStreamsResult> {
    const now = input.now || this.clock()
    const startedAt = now.toISOString()
    const limit = input.limit ?? 10
    const streams = await this.options.repository.listRunnableStreams(now, limit)
    const results: RunTickResult[] = []
    const slotId = input.slotId

    for (const stream of streams) {
      const result = await this.runTick({
        streamId: stream.id,
        tickId: slotId
          ? `slot:${slotId}:stream:${stream.id}`
          : `loop:${this.workerId}:${stream.id}:${randomUUID()}`,
        now
      })
      results.push(result)
    }

    return {
      workerId: this.workerId,
      startedAt,
      slotId,
      attempted: streams.length,
      processed: results.filter(result =>
        result.outcome === 'processed' ||
        result.outcome === 'completed' ||
        result.outcome === 'retry_scheduled' ||
        result.outcome === 'failed_terminal'
      ).length,
      results
    }
  }

  async runTick(input: RunTickInput): Promise<RunTickResult> {
    const startedAtMs = Date.now()
    const tickId = input.tickId || `tick:${randomUUID()}`
    const now = input.now || this.clock()
    const stream = await this.options.repository.getStream(input.streamId)

    if (!stream) {
      return {
        streamId: input.streamId,
        tickId,
        outcome: 'not_found',
        durationMs: computeDurationMs(startedAtMs)
      }
    }

    const lastTickId = typeof stream.current_state.last_tick_id === 'string'
      ? (stream.current_state.last_tick_id as string)
      : null

    if (lastTickId === tickId) {
      return {
        streamId: stream.id,
        tickId,
        outcome: 'already_processed',
        durationMs: computeDurationMs(startedAtMs)
      }
    }

    if (
      stream.next_tick_at &&
      new Date(stream.next_tick_at).getTime() > now.getTime()
    ) {
      return {
        streamId: stream.id,
        tickId,
        outcome: 'not_runnable',
        reason: `scheduled_for_${stream.next_tick_at}`,
        durationMs: computeDurationMs(startedAtMs)
      }
    }

    const lease = await this.options.leaseManager.acquireLease({
      streamId: stream.id,
      workerId: this.workerId,
      leaseTtlMs: this.leaseTtlMs,
      now
    })

    if (!lease.acquired) {
      return {
        streamId: stream.id,
        tickId,
        outcome: 'lease_not_acquired',
        reason: lease.reason,
        durationMs: computeDurationMs(startedAtMs)
      }
    }

    try {
      return await this.runTickWithLease(stream.id, tickId, now, startedAtMs)
    } finally {
      await this.options.leaseManager.releaseLease(stream.id, this.workerId)
    }
  }

  private async runTickWithLease(
    streamId: string,
    tickId: string,
    now: Date,
    startedAtMs: number
  ): Promise<RunTickResult> {
    const stream = await this.options.repository.getStream(streamId)
    if (!stream) {
      return {
        streamId,
        tickId,
        outcome: 'not_found',
        durationMs: computeDurationMs(startedAtMs)
      }
    }

    const snapshot = await this.options.repository.getLatestSnapshot(streamId)
    const useSnapshot = !!snapshot && snapshot.last_seq_no > 0 && snapshot.last_seq_no <= stream.last_seq_no
    const events = useSnapshot
      ? await this.options.repository.getEventsAfterSequence(streamId, snapshot.last_seq_no)
      : await this.options.repository.getEvents(streamId)
    const reduced = reduceAutonomyStream(
      stream,
      events,
      useSnapshot
        ? {
            startSeqNo: snapshot.last_seq_no,
            seedState: {
              status: snapshot.state_blob.status,
              phase: snapshot.state_blob.phase,
              retryCount: snapshot.state_blob.retry_count,
              lastError: snapshot.state_blob.last_error,
              lastSeqNo: snapshot.last_seq_no
            }
          }
        : undefined
    )
    const phase = reduced.phase

    if (reduced.inconsistent) {
      await this.options.ledger.appendEvent({
        streamId,
        eventType: 'stream.marked_inconsistent',
        payload: { reason: reduced.reason || 'inconsistent_stream', tick_id: tickId },
        metadata: { worker_id: this.workerId },
        idempotencyKey: `${tickId}:inconsistent`,
        actorType: 'system',
        actorId: this.workerId,
        createdAt: now.toISOString()
      })

      await this.options.repository.updateStream(streamId, {
        status: 'inconsistent',
        current_state: {
          ...stream.current_state,
          phase,
          last_tick_id: tickId,
          inconsistent_reason: reduced.reason || 'inconsistent_stream'
        },
        next_tick_at: null,
        last_error: reduced.reason || 'inconsistent_stream'
      })
      await this.maybePersistSnapshot(streamId, true)

      return {
        streamId,
        tickId,
        outcome: 'inconsistent_stream',
        reason: reduced.reason || 'inconsistent_stream',
        durationMs: computeDurationMs(startedAtMs)
      }
    }

    if (
      reduced.status === 'completed' ||
      reduced.status === 'failed_terminal' ||
      reduced.status === 'inconsistent'
    ) {
      return {
        streamId,
        tickId,
        outcome: 'not_runnable',
        reason: `terminal_status_${reduced.status}`,
        durationMs: computeDurationMs(startedAtMs)
      }
    }

    if (isTerminalPhase(stream.workflow_type, phase)) {
      await this.options.repository.updateStream(streamId, {
        status: 'completed',
        current_state: {
          ...stream.current_state,
          phase,
          last_tick_id: tickId
        },
        retry_count: 0,
        next_tick_at: null,
        last_error: null
      })
      await this.maybePersistSnapshot(streamId, true)

      return {
        streamId,
        tickId,
        outcome: 'completed',
        reason: 'already_at_terminal_phase',
        durationMs: computeDurationMs(startedAtMs)
      }
    }

    if (reduced.status === 'pending') {
      await this.options.ledger.appendEvent({
        streamId,
        eventType: 'stream.started',
        payload: { phase, tick_id: tickId },
        metadata: { worker_id: this.workerId },
        idempotencyKey: `${tickId}:start`,
        actorType: 'system',
        actorId: this.workerId,
        createdAt: now.toISOString()
      })

      await this.options.repository.updateStream(streamId, {
        status: 'running',
        current_state: {
          ...stream.current_state,
          phase,
          last_tick_id: tickId
        },
        last_error: null,
        next_tick_at: new Date(now.getTime() + this.tickDelayMs).toISOString()
      })
      await this.maybePersistSnapshot(streamId)

      return {
        streamId,
        tickId,
        outcome: 'processed',
        eventType: 'stream.started',
        nextTickAt: new Date(now.getTime() + this.tickDelayMs).toISOString(),
        durationMs: computeDurationMs(startedAtMs)
      }
    }

    const toPhase = nextPhaseForWorkflow(stream.workflow_type, phase)
    if (!toPhase) {
      await this.options.ledger.appendEvent({
        streamId,
        eventType: 'stream.marked_inconsistent',
        payload: { reason: `phase_transition_missing:${phase}`, tick_id: tickId },
        metadata: { worker_id: this.workerId },
        idempotencyKey: `${tickId}:phase-missing`,
        actorType: 'system',
        actorId: this.workerId,
        createdAt: now.toISOString()
      })

      await this.options.repository.updateStream(streamId, {
        status: 'inconsistent',
        current_state: {
          ...stream.current_state,
          phase,
          last_tick_id: tickId,
          inconsistent_reason: `phase_transition_missing:${phase}`
        },
        next_tick_at: null,
        last_error: `phase_transition_missing:${phase}`
      })
      await this.maybePersistSnapshot(streamId, true)

      return {
        streamId,
        tickId,
        outcome: 'inconsistent_stream',
        reason: `phase_transition_missing:${phase}`,
        durationMs: computeDurationMs(startedAtMs)
      }
    }

    try {
      const memoryContext = retrieveAutonomyMemory({
        stream,
        events,
        query: `${stream.workflow_type} ${phase} ${toPhase} ${stream.last_error || ''}`.trim(),
        limit: 5
      })

      await withTimeout(
        Promise.resolve(
          this.transitionExecutor({
            stream,
            fromPhase: phase,
            toPhase,
            tickId,
            now,
            memoryContext
          })
        ),
        this.tickBudgetMs,
        'tick_budget_exceeded'
      )

      await this.options.ledger.appendEvent({
        streamId,
        eventType: 'step.succeeded',
        payload: { from_phase: phase, to_phase: toPhase, tick_id: tickId },
        metadata: { worker_id: this.workerId },
        idempotencyKey: `${tickId}:step:${phase}:${toPhase}`,
        actorType: 'system',
        actorId: this.workerId,
        createdAt: now.toISOString()
      })

      const completed = isTerminalPhase(stream.workflow_type, toPhase)
      const nextTickAt = completed
        ? null
        : new Date(now.getTime() + this.tickDelayMs).toISOString()

      await this.options.repository.updateStream(streamId, {
        status: completed ? 'completed' : 'running',
        current_state: {
          ...stream.current_state,
          phase: toPhase,
          last_tick_id: tickId
        },
        retry_count: 0,
        next_tick_at: nextTickAt,
        last_error: null
      })
      await this.maybePersistSnapshot(streamId, completed)

      return {
        streamId,
        tickId,
        outcome: completed ? 'completed' : 'processed',
        eventType: 'step.succeeded',
        nextTickAt,
        retryCount: 0,
        durationMs: computeDurationMs(startedAtMs)
      }
    } catch (error) {
      return this.handleTransitionFailure({
        stream,
        events,
        phase,
        tickId,
        now,
        error,
        startedAtMs
      })
    }
  }

  private async handleTransitionFailure(input: {
    stream: AutonomyStream
    events: AutonomyEvent[]
    phase: string
    tickId: string
    now: Date
    error: unknown
    startedAtMs: number
  }): Promise<RunTickResult> {
    const errorMessage = getErrorMessage(input.error)
    const attempt = input.stream.retry_count + 1
    const streamId = input.stream.id
    const adaptation = computeBoundedAdaptationDecision({
      events: input.events,
      errorMessage,
      maxAttempts: this.maxAdaptationAttempts
    })

    if (adaptation.applied && adaptation.policyId) {
      await this.options.ledger.appendEvent({
        streamId,
        eventType: 'adaptation.applied',
        payload: {
          attempt: adaptation.attempt,
          max_attempts: adaptation.maxAttempts,
          policy_id: adaptation.policyId,
          error_digest: adaptation.errorDigest,
          tick_id: input.tickId
        },
        metadata: { worker_id: this.workerId },
        idempotencyKey: `${input.tickId}:adapt:${adaptation.attempt}`,
        actorType: 'system',
        actorId: this.workerId,
        createdAt: input.now.toISOString()
      })
    }

    const baseState = {
      ...input.stream.current_state,
      phase: input.phase,
      last_tick_id: input.tickId,
      adaptation: {
        attempts_applied: adaptation.applied ? adaptation.attempt : adaptation.priorAttempts,
        max_attempts: adaptation.maxAttempts,
        last_policy_id: adaptation.policyId,
        exhausted: adaptation.exhausted,
        last_error_digest: adaptation.errorDigest,
        updated_at: input.now.toISOString()
      }
    }

    if (attempt > input.stream.max_retries) {
      const failedEvent = await this.options.ledger.appendEvent({
        streamId,
        eventType: 'stream.failed_terminal',
        payload: {
          error: errorMessage,
          retry_count: attempt,
          terminal_reason: 'max_retries_exceeded',
          tick_id: input.tickId
        },
        metadata: { worker_id: this.workerId },
        idempotencyKey: `${input.tickId}:failed_terminal:${attempt}`,
        actorType: 'system',
        actorId: this.workerId,
        createdAt: input.now.toISOString()
      })

      await this.options.repository.updateStream(streamId, {
        status: 'failed_terminal',
        current_state: baseState,
        retry_count: attempt,
        next_tick_at: null,
        last_error: errorMessage
      })
      await this.maybePersistSnapshot(streamId, true)

      await this.options.repository.insertDeadLetter({
        stream_id: streamId,
        terminal_reason: 'max_retries_exceeded',
        attempts: attempt,
        last_error: errorMessage,
        last_event_id: failedEvent.event.id
      })

      return {
        streamId,
        tickId: input.tickId,
        outcome: 'failed_terminal',
        eventType: 'stream.failed_terminal',
        retryCount: attempt,
        reason: errorMessage,
        durationMs: computeDurationMs(input.startedAtMs)
      }
    }

    const backoffMs = computeRetryBackoffMs(attempt)
    const nextTickAt = new Date(input.now.getTime() + backoffMs).toISOString()

    await this.options.ledger.appendEvent({
      streamId,
      eventType: 'retry.scheduled',
      payload: {
        error: errorMessage,
        retry_count: attempt,
        backoff_ms: backoffMs,
        tick_id: input.tickId
      },
      metadata: { worker_id: this.workerId },
      idempotencyKey: `${input.tickId}:retry:${attempt}`,
      actorType: 'system',
      actorId: this.workerId,
      createdAt: input.now.toISOString()
    })

    await this.options.repository.updateStream(streamId, {
      status: 'retry_scheduled',
      current_state: baseState,
      retry_count: attempt,
      next_tick_at: nextTickAt,
      last_error: errorMessage
    })
    await this.maybePersistSnapshot(streamId)

    return {
      streamId,
      tickId: input.tickId,
      outcome: 'retry_scheduled',
      eventType: 'retry.scheduled',
      retryCount: attempt,
      nextTickAt,
      reason: errorMessage,
      durationMs: computeDurationMs(input.startedAtMs)
    }
  }

  private async maybePersistSnapshot(streamId: string, force: boolean = false): Promise<void> {
    const stream = await this.options.repository.getStream(streamId)
    if (!stream || stream.last_seq_no <= 0) {
      return
    }

    if (!force && (stream.last_seq_no % this.snapshotInterval !== 0)) {
      return
    }

    const phase = typeof stream.current_state.phase === 'string' && stream.current_state.phase.length > 0
      ? stream.current_state.phase
      : defaultPhaseForWorkflow(stream.workflow_type)
    const stateBlob = {
      status: stream.status,
      phase,
      retry_count: stream.retry_count,
      last_error: stream.last_error,
      workflow_type: stream.workflow_type
    }
    const stateHash = computeAutonomyDigest({
      stream_id: stream.id,
      last_seq_no: stream.last_seq_no,
      state_blob: stateBlob
    })

    await this.options.repository.upsertSnapshot({
      stream_id: stream.id,
      last_seq_no: stream.last_seq_no,
      state_blob: stateBlob,
      state_hash: stateHash
    })
  }
}
