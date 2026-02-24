import { readFileSync } from 'fs'

import { buildDeterminismReceipt, reduceAutonomyStream, type AutonomyEvent, type AutonomyStream } from '../src'

const file = process.argv[2]
if (!file) {
  console.error('Usage: tsx scripts/replay-ledger.ts <bundle.json>')
  process.exit(1)
}

const bundle = JSON.parse(readFileSync(file, 'utf8')) as {
  stream: AutonomyStream
  events: AutonomyEvent[]
}

const reduced = reduceAutonomyStream(bundle.stream, bundle.events)
const receipt = buildDeterminismReceipt({
  stream: bundle.stream,
  events: bundle.events,
  tickId: `script:${bundle.stream.id}`,
  reducedState: reduced
})

console.log(JSON.stringify({ reduced, receipt }, null, 2))
