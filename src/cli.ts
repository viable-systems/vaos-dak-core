#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

import {
  buildDeterminismReceipt,
  reduceAutonomyStream,
  verifyDeterminismReceipt,
  verifyEventHashChain,
  type DeterminismReceipt,
  type AutonomyEvent,
  type AutonomySnapshot,
  type AutonomyStream
} from './index'

interface LedgerBundle {
  stream: AutonomyStream
  events: AutonomyEvent[]
  snapshot?: AutonomySnapshot | null
  receipt?: DeterminismReceipt
}

function readBundle(filePath: string): LedgerBundle {
  const raw = readFileSync(resolve(process.cwd(), filePath), 'utf8')
  return JSON.parse(raw) as LedgerBundle
}

function readArg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) {
    return fallback
  }
  return process.argv[index + 1]
}

function maybeWriteJson(outPath: string | undefined, payload: unknown): void {
  if (!outPath) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  writeFileSync(resolve(process.cwd(), outPath), `${JSON.stringify(payload, null, 2)}\n`)
}

function commandVerify(bundle: LedgerBundle, secret?: string) {
  const chain = verifyEventHashChain(bundle.events)
  const response: Record<string, unknown> = {
    command: 'verify',
    stream_id: bundle.stream.id,
    chain_valid: chain.valid,
    chain_issues: chain.issues,
    event_chain_root: chain.chainRoot
  }

  if (bundle.receipt) {
    const verification = verifyDeterminismReceipt(bundle.receipt, {
      stream: bundle.stream,
      events: bundle.events,
      tickId: bundle.receipt.tick_id,
      snapshot: bundle.snapshot,
      signingSecret: secret
    })
    response.receipt_valid = verification.valid
    response.receipt_issues = verification.issues
    response.expected_receipt = verification.expected
    if (!verification.valid) {
      process.exitCode = 1
    }
  } else if (!chain.valid) {
    process.exitCode = 1
  }

  return response
}

function commandReplay(bundle: LedgerBundle, secret?: string) {
  const reducedState = reduceAutonomyStream(bundle.stream, bundle.events)
  const receipt = buildDeterminismReceipt({
    stream: bundle.stream,
    events: bundle.events,
    tickId: `replay:${bundle.stream.id}`,
    reducedState,
    snapshot: bundle.snapshot,
    signingSecret: secret
  })

  return {
    command: 'replay',
    stream_id: bundle.stream.id,
    reduced_state: reducedState,
    receipt
  }
}

function commandAudit(bundle: LedgerBundle) {
  const counts = bundle.events.reduce<Record<string, number>>((acc, event) => {
    acc[event.event_type] = (acc[event.event_type] || 0) + 1
    return acc
  }, {})

  const ordered = [...bundle.events].sort((a, b) => a.seq_no - b.seq_no)
  const latest = ordered.length > 0 ? ordered[ordered.length - 1] : null

  return {
    command: 'audit',
    stream_id: bundle.stream.id,
    total_events: bundle.events.length,
    status: bundle.stream.status,
    retry_count: bundle.stream.retry_count,
    last_error: bundle.stream.last_error,
    last_event: latest ? {
      seq_no: latest.seq_no,
      event_type: latest.event_type,
      created_at: latest.created_at
    } : null,
    event_type_counts: counts
  }
}

function main() {
  const command = process.argv[2]
  if (!command || !['verify', 'replay', 'audit'].includes(command)) {
    console.error('Usage: dak <verify|replay|audit> --file <ledger.json> [--out <output.json>] [--secret <hmac-secret>]')
    process.exit(1)
  }

  const file = readArg('--file')
  if (!file) {
    console.error('Missing required --file argument')
    process.exit(1)
  }

  const outPath = readArg('--out')
  const secret = readArg('--secret')
  const bundle = readBundle(file)

  if (!bundle.stream || !Array.isArray(bundle.events)) {
    console.error('Input JSON must contain { stream, events[] }')
    process.exit(1)
  }

  if (command === 'verify') {
    maybeWriteJson(outPath, commandVerify(bundle, secret))
    return
  }
  if (command === 'replay') {
    maybeWriteJson(outPath, commandReplay(bundle, secret))
    return
  }
  maybeWriteJson(outPath, commandAudit(bundle))
}

main()
