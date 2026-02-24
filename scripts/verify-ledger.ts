import { readFileSync } from 'fs'

import { verifyEventHashChain, type AutonomyEvent } from '../src'

const file = process.argv[2]
if (!file) {
  console.error('Usage: tsx scripts/verify-ledger.ts <events.json>')
  process.exit(1)
}

const events = JSON.parse(readFileSync(file, 'utf8')) as AutonomyEvent[]
const result = verifyEventHashChain(events)
console.log(JSON.stringify(result, null, 2))
if (!result.valid) {
  process.exit(1)
}
