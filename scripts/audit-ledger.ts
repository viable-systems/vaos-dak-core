import { readFileSync } from 'fs'

import { type AutonomyEvent } from '../src'

const file = process.argv[2]
if (!file) {
  console.error('Usage: tsx scripts/audit-ledger.ts <events.json>')
  process.exit(1)
}

const events = JSON.parse(readFileSync(file, 'utf8')) as AutonomyEvent[]
const counts = events.reduce<Record<string, number>>((acc, event) => {
  acc[event.event_type] = (acc[event.event_type] || 0) + 1
  return acc
}, {})

console.log(JSON.stringify({ total_events: events.length, event_type_counts: counts }, null, 2))
