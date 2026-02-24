import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createClient } from '@supabase/supabase-js'

import {
  AutonomyIntrospectionService,
  AutonomyLedgerService,
  AutonomyLeaseManager,
  AutonomyTickEngine,
  SupabaseAutonomyRepository,
  buildDeterminismReceipt,
  verifyDeterminismReceipt
} from '../../src'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function iso(offsetMs: number): string {
  return new Date(Date.UTC(2026, 1, 24, 16, 0, 0, offsetMs)).toISOString()
}

async function main() {
  const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
  assert(apiUrl, 'Missing NEXT_PUBLIC_SUPABASE_URL')
  assert(serviceRole, 'Missing SUPABASE_SERVICE_ROLE_KEY')

  const reportPath = resolve(process.cwd(), 'artifacts', 'supabase-dogfood-core.json')

  const supabase = createClient(apiUrl, serviceRole, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  })

  const repository = new SupabaseAutonomyRepository(supabase as never)
  const ledger = new AutonomyLedgerService(repository)
  const leaseManager = new AutonomyLeaseManager(repository)
  const introspection = new AutonomyIntrospectionService(repository)

  const runId = `core-${Date.now()}`
  const ownerUserId = randomUUID()
  const streamIds = {
    happy: randomUUID(),
    receipt: randomUUID(),
    failure: randomUUID(),
    lease: randomUUID()
  }

  const suites: Record<string, unknown> = {}

  try {
    {
      const { error } = await supabase.from('users').insert({
        id: ownerUserId,
        clerk_user_id: `clerk-${runId}`,
        email: `${runId}@example.test`
      })
      if (error) {
        throw new Error(`Failed to seed user: ${error.message}`)
      }
    }

    // Happy path + snapshot
    {
      const { error } = await supabase.from('autonomy_streams').insert({
        id: streamIds.happy,
        workflow_type: 'factory',
        owner_user_id: ownerUserId,
        status: 'pending',
        current_state: { phase: 'queued' },
        next_tick_at: iso(0),
        max_retries: 3
      })
      if (error) {
        throw new Error(`Failed to seed happy stream: ${error.message}`)
      }

      const engine = new AutonomyTickEngine({
        repository,
        ledger,
        leaseManager,
        workerId: `${runId}-happy-worker`,
        tickDelayMs: 0,
        snapshotInterval: 1,
        clock: () => new Date(iso(0))
      })

      const outcomes: string[] = []
      for (let i = 1; i <= 6; i += 1) {
        const result = await engine.runTick({
          streamId: streamIds.happy,
          tickId: `${runId}-happy-tick-${i}`,
          now: new Date(iso(i))
        })
        outcomes.push(result.outcome)
      }

      const stream = await repository.getStream(streamIds.happy)
      const events = await repository.getEvents(streamIds.happy)
      const snapshot = await repository.getLatestSnapshot(streamIds.happy)
      const inspect = await introspection.inspectStream(streamIds.happy)

      assert(stream, 'Happy stream missing')
      assert(stream.status === 'completed', `Happy stream expected completed, got ${stream.status}`)
      assert(events.length === 6, `Happy stream expected 6 events, got ${events.length}`)
      assert(snapshot?.last_seq_no === 6, `Happy stream expected snapshot seq 6, got ${snapshot?.last_seq_no ?? 'null'}`)
      assert(inspect.reducedState?.status === 'completed', `Introspection expected completed, got ${inspect.reducedState?.status ?? 'null'}`)

      suites.happy_path = {
        status: 'pass',
        outcomes,
        finalStatus: stream.status,
        eventCount: events.length,
        snapshotSeq: snapshot.last_seq_no
      }
    }

    // Receipt verification from core proof module
    {
      const { error } = await supabase.from('autonomy_streams').insert({
        id: streamIds.receipt,
        workflow_type: 'factory',
        owner_user_id: ownerUserId,
        status: 'pending',
        current_state: { phase: 'queued' },
        next_tick_at: iso(0),
        max_retries: 3
      })
      if (error) {
        throw new Error(`Failed to seed receipt stream: ${error.message}`)
      }

      const engine = new AutonomyTickEngine({
        repository,
        ledger,
        leaseManager,
        workerId: `${runId}-receipt-worker`,
        tickDelayMs: 0,
        snapshotInterval: 1,
        clock: () => new Date(iso(0))
      })

      const tickId = `${runId}-receipt-tick-1`
      const result = await engine.runTick({
        streamId: streamIds.receipt,
        tickId,
        now: new Date(iso(1))
      })
      assert(result.outcome === 'processed', `Receipt stream first tick expected processed, got ${result.outcome}`)

      const stream = await repository.getStream(streamIds.receipt)
      const events = await repository.getEvents(streamIds.receipt)
      const snapshot = await repository.getLatestSnapshot(streamIds.receipt)
      assert(stream, 'Receipt stream missing')

      const receipt = buildDeterminismReceipt({
        stream,
        events,
        tickId,
        snapshot,
        signingSecret: 'supabase-core-secret',
        engineVersion: 'core-supabase-dogfood-1'
      })

      const verification = verifyDeterminismReceipt(receipt, {
        stream,
        events,
        tickId,
        snapshot,
        signingSecret: 'supabase-core-secret'
      })

      assert(verification.valid, `Core receipt verification failed: ${verification.issues.join(', ')}`)

      suites.receipt_verification = {
        status: 'pass',
        outcome: result.outcome,
        receiptTick: receipt.tick_id,
        receiptValid: verification.valid
      }
    }

    // Retry/dead-letter path
    {
      const { error } = await supabase.from('autonomy_streams').insert({
        id: streamIds.failure,
        workflow_type: 'factory',
        owner_user_id: ownerUserId,
        status: 'pending',
        current_state: { phase: 'queued' },
        next_tick_at: iso(0),
        max_retries: 1
      })
      if (error) {
        throw new Error(`Failed to seed failure stream: ${error.message}`)
      }

      const engine = new AutonomyTickEngine({
        repository,
        ledger,
        leaseManager,
        workerId: `${runId}-failure-worker`,
        tickDelayMs: 0,
        transitionExecutor: async () => {
          throw new Error('forced_supabase_failure')
        },
        clock: () => new Date(iso(0))
      })

      const outcomes: string[] = []
      const times = [new Date(iso(1000)), new Date(iso(2000)), new Date(iso(4500))]
      for (let i = 0; i < times.length; i += 1) {
        const result = await engine.runTick({
          streamId: streamIds.failure,
          tickId: `${runId}-failure-tick-${i + 1}`,
          now: times[i]
        })
        outcomes.push(result.outcome)
      }

      const stream = await repository.getStream(streamIds.failure)
      const deadLetter = await repository.getLatestDeadLetter(streamIds.failure)
      const events = await repository.getEvents(streamIds.failure)

      assert(stream, 'Failure stream missing')
      assert(stream.status === 'failed_terminal', `Failure stream expected failed_terminal, got ${stream.status}`)
      assert(deadLetter, 'Expected dead letter for failed stream')
      assert(deadLetter.terminal_reason === 'max_retries_exceeded', `Unexpected dead letter reason: ${deadLetter.terminal_reason}`)

      suites.retry_dead_letter = {
        status: 'pass',
        outcomes,
        finalStatus: stream.status,
        deadLetterReason: deadLetter.terminal_reason,
        eventTypes: events.map(event => event.event_type)
      }
    }

    // Lease contention across workers
    {
      const { error } = await supabase.from('autonomy_streams').insert({
        id: streamIds.lease,
        workflow_type: 'factory',
        owner_user_id: ownerUserId,
        status: 'pending',
        current_state: { phase: 'queued' },
        next_tick_at: iso(0),
        max_retries: 3
      })
      if (error) {
        throw new Error(`Failed to seed lease stream: ${error.message}`)
      }

      const transitionExecutor = async () => {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 120))
      }

      const engineA = new AutonomyTickEngine({
        repository,
        ledger,
        leaseManager,
        workerId: `${runId}-lease-worker-a`,
        tickDelayMs: 0,
        transitionExecutor,
        clock: () => new Date(iso(0))
      })

      const engineB = new AutonomyTickEngine({
        repository,
        ledger,
        leaseManager,
        workerId: `${runId}-lease-worker-b`,
        tickDelayMs: 0,
        transitionExecutor,
        clock: () => new Date(iso(0))
      })

      const start = await engineA.runTick({
        streamId: streamIds.lease,
        tickId: `${runId}-lease-start`,
        now: new Date(iso(0))
      })

      const [raceA, raceB] = await Promise.all([
        engineA.runTick({
          streamId: streamIds.lease,
          tickId: `${runId}-lease-race-a`,
          now: new Date(iso(1500))
        }),
        engineB.runTick({
          streamId: streamIds.lease,
          tickId: `${runId}-lease-race-b`,
          now: new Date(iso(1500))
        })
      ])

      const raceOutcomes = [raceA.outcome, raceB.outcome]
      const blocked = raceOutcomes.filter(outcome => outcome === 'lease_not_acquired').length
      const progressed = raceOutcomes.filter(outcome => outcome === 'processed' || outcome === 'completed').length

      const events = await repository.getEvents(streamIds.lease)
      assert(start.outcome === 'processed', `Lease start tick expected processed, got ${start.outcome}`)
      assert(blocked === 1, `Lease race expected 1 blocked tick, got ${blocked}`)
      assert(progressed === 1, `Lease race expected 1 progressed tick, got ${progressed}`)
      assert(events.length === 2, `Lease race expected 2 events, got ${events.length}`)

      suites.lease_contention = {
        status: 'pass',
        startOutcome: start.outcome,
        raceOutcomes,
        eventCount: events.length
      }
    }

    const report = {
      status: 'pass',
      runId,
      userId: ownerUserId,
      streamIds,
      suites,
      generatedAt: new Date().toISOString()
    }

    await mkdir(resolve(process.cwd(), 'artifacts'), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await supabase.from('autonomy_streams').delete().in('id', Object.values(streamIds))
    await supabase.from('users').delete().eq('id', ownerUserId)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
