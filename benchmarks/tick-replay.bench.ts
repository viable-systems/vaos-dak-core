import { performance } from 'perf_hooks'

import {
  AutonomyLedgerService,
  AutonomyLeaseManager,
  AutonomyTickEngine,
  InMemoryAutonomyRepository
} from '../src'

async function run(iterations: number): Promise<void> {
  const repo = new InMemoryAutonomyRepository()
  const stream = repo.createStream({
    id: 'bench-stream',
    workflow_type: 'factory',
    owner_user_id: 'bench-user',
    status: 'pending',
    current_state: { phase: 'ideas' },
    next_tick_at: new Date('2026-02-24T00:00:00.000Z').toISOString()
  })

  const engine = new AutonomyTickEngine({
    repository: repo,
    ledger: new AutonomyLedgerService(repo),
    leaseManager: new AutonomyLeaseManager(repo),
    workerId: 'bench-worker',
    tickDelayMs: 0,
    clock: () => new Date('2026-02-24T00:00:00.000Z')
  })

  const start = performance.now()
  for (let i = 0; i < iterations; i += 1) {
    // unique tick IDs avoid idempotency short-circuiting
    // and force full reducer/ledger path execution.
    await engine.runTick({ streamId: stream.id, tickId: `bench:${i}` })
  }
  const end = performance.now()

  const totalMs = end - start
  const result = {
    iterations,
    total_ms: Number(totalMs.toFixed(3)),
    ticks_per_second: Number(((iterations / totalMs) * 1000).toFixed(2))
  }

  console.log(JSON.stringify(result, null, 2))
}

const iterations = Number(process.argv[2] || 1000)
run(iterations).catch(error => {
  console.error(error)
  process.exit(1)
})
