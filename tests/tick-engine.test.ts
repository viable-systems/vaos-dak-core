import { describe, expect, it } from 'vitest'

import { InMemoryAutonomyRepository } from '../src/in-memory-repository'
import { AutonomyLedgerService } from '../src/ledger'
import { AutonomyLeaseManager } from '../src/lease-manager'
import { AutonomyTickEngine, type TransitionExecutor } from '../src/tick-engine'

function buildEngine(
  repo: InMemoryAutonomyRepository,
  workerId: string,
  transitionExecutor?: TransitionExecutor,
  snapshotInterval: number = 25
) {
  return new AutonomyTickEngine({
    repository: repo,
    ledger: new AutonomyLedgerService(repo),
    leaseManager: new AutonomyLeaseManager(repo),
    workerId,
    leaseTtlMs: 10_000,
    tickDelayMs: 5_000,
    snapshotInterval,
    transitionExecutor
  })
}

describe('AutonomyTickEngine', () => {
  it('CAP-003: advances runnable stream by one deterministic step', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-cap003-step',
      workflow_type: 'factory',
      owner_user_id: 'user-1',
      status: 'running',
      current_state: { phase: 'queued' },
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })
    const engine = buildEngine(repo, 'worker-cap003')

    const result = await engine.runTick({
      streamId: 'stream-cap003-step',
      tickId: 'cap003-tick-1',
      now: new Date('2026-02-24T00:00:00.000Z')
    })

    const events = await repo.getEvents('stream-cap003-step')
    const stream = await repo.getStream('stream-cap003-step')

    expect(result.outcome).toBe('processed')
    expect(result.eventType).toBe('step.succeeded')
    expect(events).toHaveLength(1)
    expect(events[0].payload_json.to_phase).toBe('research')
    expect(stream?.current_state.phase).toBe('research')
    expect(stream?.status).toBe('running')
  })

  it('CAP-003: is idempotent when same tick id is replayed', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-cap003-idempotent',
      workflow_type: 'factory',
      owner_user_id: 'user-1',
      status: 'running',
      current_state: { phase: 'queued' },
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })
    const engine = buildEngine(repo, 'worker-cap003-idem')
    const now = new Date('2026-02-24T00:00:00.000Z')

    const first = await engine.runTick({
      streamId: 'stream-cap003-idempotent',
      tickId: 'cap003-idem-1',
      now
    })

    const second = await engine.runTick({
      streamId: 'stream-cap003-idempotent',
      tickId: 'cap003-idem-1',
      now
    })

    const events = await repo.getEvents('stream-cap003-idempotent')

    expect(first.outcome).toBe('processed')
    expect(second.outcome).toBe('already_processed')
    expect(events).toHaveLength(1)
  })

  it('CAP-003: enforces tick budget and schedules retry when execution times out', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-cap003-budget',
      workflow_type: 'factory',
      owner_user_id: 'user-1',
      status: 'running',
      current_state: { phase: 'queued' },
      retry_count: 0,
      max_retries: 3,
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })

    const engine = new AutonomyTickEngine({
      repository: repo,
      ledger: new AutonomyLedgerService(repo),
      leaseManager: new AutonomyLeaseManager(repo),
      workerId: 'worker-cap003-budget',
      tickBudgetMs: 10,
      transitionExecutor: async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    })

    const result = await engine.runTick({
      streamId: 'stream-cap003-budget',
      tickId: 'cap003-budget-1',
      now: new Date('2026-02-24T00:00:00.000Z')
    })

    expect(result.outcome).toBe('retry_scheduled')
    expect(result.reason).toBe('tick_budget_exceeded')
  })

  it('CAP-003: schedules next tick inside configured 5s cadence window', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-cap003-cadence',
      workflow_type: 'factory',
      owner_user_id: 'user-1',
      status: 'running',
      current_state: { phase: 'queued' },
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })
    const engine = buildEngine(repo, 'worker-cap003-cadence')

    const result = await engine.runTick({
      streamId: 'stream-cap003-cadence',
      tickId: 'cap003-cadence-1',
      now: new Date('2026-02-24T00:00:00.000Z')
    })
    const stream = await repo.getStream('stream-cap003-cadence')

    expect(result.nextTickAt).toBe('2026-02-24T00:00:05.000Z')
    expect(stream?.next_tick_at).toBe('2026-02-24T00:00:05.000Z')
  })

  it('Phase A: uses deterministic slot tick ids so cron replay is idempotent', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-slot-idempotent',
      workflow_type: 'factory',
      owner_user_id: 'user-1',
      status: 'running',
      current_state: { phase: 'queued' },
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })
    const engine = buildEngine(repo, 'worker-slot-idempotent')
    const now = new Date('2026-02-24T00:00:00.000Z')

    const first = await engine.processRunnableStreams({
      now,
      limit: 10,
      slotId: 'slot-abc123'
    })
    const second = await engine.processRunnableStreams({
      now: new Date('2026-02-24T00:00:05.000Z'),
      limit: 10,
      slotId: 'slot-abc123'
    })

    expect(first.results[0].tickId).toBe('slot:slot-abc123:stream:stream-slot-idempotent')
    expect(first.results[0].outcome).toBe('processed')
    expect(second.results[0].tickId).toBe('slot:slot-abc123:stream:stream-slot-idempotent')
    expect(second.results[0].outcome).toBe('already_processed')
  })

  it('CAP-005: schedules retry with deterministic backoff on transient failure', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-cap005-retry',
      workflow_type: 'factory',
      owner_user_id: 'user-1',
      status: 'running',
      current_state: { phase: 'queued' },
      retry_count: 0,
      max_retries: 3,
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })
    const engine = buildEngine(repo, 'worker-cap005', async () => {
      throw new Error('transient_failure')
    })

    const result = await engine.runTick({
      streamId: 'stream-cap005-retry',
      tickId: 'cap005-retry-1',
      now: new Date('2026-02-24T00:00:00.000Z')
    })

    const stream = await repo.getStream('stream-cap005-retry')
    const events = await repo.getEvents('stream-cap005-retry')
    const latest = events[events.length - 1]

    expect(result.outcome).toBe('retry_scheduled')
    expect(result.retryCount).toBe(1)
    expect(result.nextTickAt).toBe('2026-02-24T00:00:01.000Z')
    expect(stream?.status).toBe('retry_scheduled')
    expect(stream?.retry_count).toBe(1)
    expect(stream?.next_tick_at).toBe('2026-02-24T00:00:01.000Z')
    expect(latest.event_type).toBe('retry.scheduled')
    expect(latest.payload_json.backoff_ms).toBe(1000)
  })

  it('CAP-005: transitions to dead-letter after max retries are exhausted', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-cap005-dead',
      workflow_type: 'factory',
      owner_user_id: 'user-1',
      status: 'running',
      current_state: { phase: 'queued' },
      retry_count: 2,
      max_retries: 2,
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })
    const engine = buildEngine(repo, 'worker-cap005-dead', async () => {
      throw new Error('permanent_failure')
    })

    const result = await engine.runTick({
      streamId: 'stream-cap005-dead',
      tickId: 'cap005-dead-1',
      now: new Date('2026-02-24T00:00:00.000Z')
    })

    const stream = await repo.getStream('stream-cap005-dead')
    const deadLetter = await repo.getLatestDeadLetter('stream-cap005-dead')

    expect(result.outcome).toBe('failed_terminal')
    expect(result.retryCount).toBe(3)
    expect(stream?.status).toBe('failed_terminal')
    expect(deadLetter?.attempts).toBe(3)
    expect(deadLetter?.terminal_reason).toBe('max_retries_exceeded')
  })

  it('Phase A: persists snapshots for replay acceleration at configured interval', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-snapshot-persist',
      workflow_type: 'factory',
      owner_user_id: 'user-1',
      status: 'running',
      current_state: { phase: 'queued' },
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })
    const engine = buildEngine(repo, 'worker-snapshot', undefined, 1)

    const result = await engine.runTick({
      streamId: 'stream-snapshot-persist',
      tickId: 'snapshot-tick-1',
      now: new Date('2026-02-24T00:00:00.000Z')
    })
    const snapshot = await repo.getLatestSnapshot('stream-snapshot-persist')

    expect(result.outcome).toBe('processed')
    expect(snapshot).not.toBeNull()
    expect(snapshot?.last_seq_no).toBe(1)
    expect(snapshot?.state_blob.phase).toBe('research')
    expect(snapshot?.state_hash.length).toBeGreaterThan(10)
  })

  it('Phase B: supplies deterministic memory retrieval context to transition executor', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-phaseb-memory',
      workflow_type: 'factory',
      owner_user_id: 'user-phaseb-memory',
      status: 'running',
      current_state: { phase: 'queued' },
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })

    const ledger = new AutonomyLedgerService(repo)
    await ledger.appendEvent({
      streamId: 'stream-phaseb-memory',
      eventType: 'stream.started',
      payload: {
        note: 'Initialize telegram webhook flow for deployment'
      },
      idempotencyKey: 'phaseb-memory-start',
      actorType: 'system',
      actorId: 'worker-phaseb-memory'
    })

    let capturedMemoryQueryTokens: string[] = []
    let capturedMemoryItems = 0

    const engine = buildEngine(repo, 'worker-phaseb-memory', async input => {
      capturedMemoryQueryTokens = input.memoryContext?.queryTokens || []
      capturedMemoryItems = input.memoryContext?.items.length || 0
    })

    await engine.runTick({
      streamId: 'stream-phaseb-memory',
      tickId: 'phaseb-memory-tick-1',
      now: new Date('2026-02-24T00:00:00.000Z')
    })

    expect(capturedMemoryItems).toBeGreaterThan(0)
    expect(capturedMemoryQueryTokens).toContain('research')
  })

  it('Phase B: applies bounded deterministic adaptation policies on repeated failures', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-phaseb-adaptation',
      workflow_type: 'factory',
      owner_user_id: 'user-phaseb-adaptation',
      status: 'running',
      current_state: { phase: 'plan' },
      retry_count: 0,
      max_retries: 10,
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })

    const engine = buildEngine(repo, 'worker-phaseb-adaptation', async () => {
      throw new Error('persistent_transition_failure')
    })

    let now = new Date('2026-02-24T00:00:00.000Z')
    for (let i = 1; i <= 5; i++) {
      const result = await engine.runTick({
        streamId: 'stream-phaseb-adaptation',
        tickId: `phaseb-adapt-${i}`,
        now
      })

      const nextTickAt = result.nextTickAt || new Date(now.getTime() + 1000).toISOString()
      now = new Date(nextTickAt)
    }

    const events = await repo.getEvents('stream-phaseb-adaptation')
    const adaptationEvents = events.filter(event => event.event_type === 'adaptation.applied')
    const stream = await repo.getStream('stream-phaseb-adaptation')
    const adaptationState = stream?.current_state.adaptation as Record<string, unknown> | undefined

    expect(adaptationEvents).toHaveLength(3)
    expect(adaptationEvents.map(event => event.payload_json.policy_id)).toEqual([
      'scope.narrow_context',
      'execution.reduce_step_size',
      'safety.require_explicit_checks'
    ])
    expect(adaptationState?.exhausted).toBe(true)
    expect(adaptationState?.attempts_applied).toBe(3)
  })

  it('WF-001: provisioning happy path reaches ready state', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-wf001',
      workflow_type: 'provisioning',
      owner_user_id: 'user-1',
      status: 'pending',
      current_state: { phase: 'pending' },
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })
    const engine = buildEngine(repo, 'worker-wf001')

    await engine.runTick({
      streamId: 'stream-wf001',
      tickId: 'wf001-1',
      now: new Date('2026-02-24T00:00:00.000Z')
    })
    await engine.runTick({
      streamId: 'stream-wf001',
      tickId: 'wf001-2',
      now: new Date('2026-02-24T00:00:05.000Z')
    })
    await engine.runTick({
      streamId: 'stream-wf001',
      tickId: 'wf001-3',
      now: new Date('2026-02-24T00:00:10.000Z')
    })
    await engine.runTick({
      streamId: 'stream-wf001',
      tickId: 'wf001-4',
      now: new Date('2026-02-24T00:00:15.000Z')
    })

    const stream = await repo.getStream('stream-wf001')
    const deadLetter = await repo.getLatestDeadLetter('stream-wf001')

    expect(stream?.current_state.phase).toBe('ready')
    expect(stream?.status).toBe('completed')
    expect(deadLetter).toBeNull()
  })

  it('WF-002: provisioning failure path reaches failed_terminal with dead-letter', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-wf002',
      workflow_type: 'provisioning',
      owner_user_id: 'user-2',
      status: 'running',
      current_state: { phase: 'creating' },
      retry_count: 0,
      max_retries: 2,
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })
    const engine = buildEngine(repo, 'worker-wf002', async () => {
      throw new Error('install_failed')
    })

    await engine.runTick({
      streamId: 'stream-wf002',
      tickId: 'wf002-1',
      now: new Date('2026-02-24T00:00:00.000Z')
    })
    await engine.runTick({
      streamId: 'stream-wf002',
      tickId: 'wf002-2',
      now: new Date('2026-02-24T00:00:01.000Z')
    })
    const terminal = await engine.runTick({
      streamId: 'stream-wf002',
      tickId: 'wf002-3',
      now: new Date('2026-02-24T00:00:03.000Z')
    })

    const stream = await repo.getStream('stream-wf002')
    const deadLetter = await repo.getLatestDeadLetter('stream-wf002')

    expect(terminal.outcome).toBe('failed_terminal')
    expect(stream?.status).toBe('failed_terminal')
    expect(deadLetter?.attempts).toBe(3)
  })

  it('WF-003: factory happy path reaches completed stage chain', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-wf003',
      workflow_type: 'factory',
      owner_user_id: 'user-3',
      status: 'pending',
      current_state: { phase: 'queued' },
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })
    const engine = buildEngine(repo, 'worker-wf003')

    await engine.runTick({ streamId: 'stream-wf003', tickId: 'wf003-1', now: new Date('2026-02-24T00:00:00.000Z') })
    await engine.runTick({ streamId: 'stream-wf003', tickId: 'wf003-2', now: new Date('2026-02-24T00:00:05.000Z') })
    await engine.runTick({ streamId: 'stream-wf003', tickId: 'wf003-3', now: new Date('2026-02-24T00:00:10.000Z') })
    await engine.runTick({ streamId: 'stream-wf003', tickId: 'wf003-4', now: new Date('2026-02-24T00:00:15.000Z') })
    await engine.runTick({ streamId: 'stream-wf003', tickId: 'wf003-5', now: new Date('2026-02-24T00:00:20.000Z') })
    await engine.runTick({ streamId: 'stream-wf003', tickId: 'wf003-6', now: new Date('2026-02-24T00:00:25.000Z') })

    const stream = await repo.getStream('stream-wf003')
    expect(stream?.current_state.phase).toBe('completed')
    expect(stream?.status).toBe('completed')
  })

  it('WF-004: factory failure path retries then terminal-fails without duplicate stage application', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-wf004',
      workflow_type: 'factory',
      owner_user_id: 'user-4',
      status: 'running',
      current_state: { phase: 'plan' },
      retry_count: 0,
      max_retries: 1,
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })
    const engine = buildEngine(repo, 'worker-wf004', async () => {
      throw new Error('stage_execution_failed')
    })

    await engine.runTick({
      streamId: 'stream-wf004',
      tickId: 'wf004-1',
      now: new Date('2026-02-24T00:00:00.000Z')
    })
    const terminal = await engine.runTick({
      streamId: 'stream-wf004',
      tickId: 'wf004-2',
      now: new Date('2026-02-24T00:00:01.000Z')
    })

    const stream = await repo.getStream('stream-wf004')
    const events = await repo.getEvents('stream-wf004')
    const stepEvents = events.filter(event => event.event_type === 'step.succeeded')

    expect(terminal.outcome).toBe('failed_terminal')
    expect(stream?.status).toBe('failed_terminal')
    expect(stepEvents).toHaveLength(0)
  })

  it('WF-005: resumes after restart using durable stream state', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-wf005',
      workflow_type: 'factory',
      owner_user_id: 'user-5',
      status: 'running',
      current_state: { phase: 'queued' },
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })

    const firstEngine = buildEngine(repo, 'worker-wf005-a')
    await firstEngine.runTick({
      streamId: 'stream-wf005',
      tickId: 'wf005-1',
      now: new Date('2026-02-24T00:00:00.000Z')
    })

    const restartedEngine = buildEngine(repo, 'worker-wf005-b')
    await restartedEngine.runTick({
      streamId: 'stream-wf005',
      tickId: 'wf005-2',
      now: new Date('2026-02-24T00:00:05.000Z')
    })

    const stream = await repo.getStream('stream-wf005')
    const events = await repo.getEvents('stream-wf005')

    expect(stream?.current_state.phase).toBe('plan')
    expect(events).toHaveLength(2)
  })

  it('WF-006: preserves concurrency safety with exclusive lease ownership', async () => {
    const repo = new InMemoryAutonomyRepository()
    repo.createStream({
      id: 'stream-wf006',
      workflow_type: 'factory',
      owner_user_id: 'user-6',
      status: 'running',
      current_state: { phase: 'queued' },
      next_tick_at: '2026-02-24T00:00:00.000Z'
    })

    const slowExecutor: TransitionExecutor = async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const engineA = buildEngine(repo, 'worker-wf006-a', slowExecutor)
    const engineB = buildEngine(repo, 'worker-wf006-b')

    const firstTickPromise = engineA.runTick({
      streamId: 'stream-wf006',
      tickId: 'wf006-a',
      now: new Date('2026-02-24T00:00:00.000Z')
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    const secondTick = await engineB.runTick({
      streamId: 'stream-wf006',
      tickId: 'wf006-b',
      now: new Date('2026-02-24T00:00:00.000Z')
    })
    const firstTick = await firstTickPromise

    const events = await repo.getEvents('stream-wf006')

    expect(firstTick.outcome).toBe('processed')
    expect(secondTick.outcome).toBe('lease_not_acquired')
    expect(events).toHaveLength(1)
  })
})
