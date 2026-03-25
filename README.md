# @vaos/dak-core

Deterministic autonomy kernel for event-sourced agent execution. Provides the primitives that VAOS uses to run, verify, and replay agent workflows.

Version: 0.2.0 | License: MIT | Runtime: Node.js (ESM)

## What it does

DAK (Deterministic Autonomy Kernel) manages agent execution as ordered event streams. Each tick advances a stream through a phase graph, appends hash-chained events, and produces a cryptographic receipt that proves the execution was deterministic.

This is the core library. It has zero runtime dependencies.

## Architecture

```
Stream (event-sourced state)
  |
  v
Tick Engine --- acquires lease ---> Lease Manager
  |                                    |
  |--- rebuilds state from ---------> Reducer (deterministic)
  |    snapshot + tail events
  |
  |--- appends event(s) -----------> Ledger (hash-chained, idempotent)
  |
  |--- optionally snapshots --------> Repository
  |
  v
Receipt (cryptographic proof of deterministic execution)
```

## Subsystems

| Module | Responsibility |
|--------|---------------|
| `reducer` | Deterministic state reconstruction from ordered events |
| `ledger` | Hash-chained, idempotent event append |
| `lease-manager` | Exclusive stream locking (1 worker per stream) |
| `tick-engine` | Orchestrates lease/reduce/transition/append cycle |
| `phases` | Defines workflow phase graphs |
| `adaptation` | Bounded retry with backoff before dead-lettering |
| `introspection` | Stream inspection and memory retrieval |
| `proof/receipt` | Determinism receipt generation and verification |
| `crypto` | Canonical digest and hash-chain computation |

## Workflow phases

| Workflow | Phases |
|----------|--------|
| `provisioning` | pending -> creating -> installing -> ready |
| `factory` | queued -> research -> plan -> implement -> critique -> completed |

## Invariants

1. Hash chain continuity: `prev_hash(event_n) == event_hash(event_{n-1})`
2. Monotonic sequence: seq_no values are contiguous and strictly increasing
3. Idempotent append: duplicate idempotency keys return the existing event
4. Replay equivalence: reducing the same event list always yields the same state hash
5. Snapshot equivalence: full replay and snapshot+tail replay produce identical state
6. Lease exclusivity: at most 1 worker holds an active lease per stream
7. Bounded adaptation: retry attempts cannot exceed the configured maximum

## Install

```bash
npm install @vaos/dak-core
```

## CLI

The package ships a `dak` binary for offline verification:

```bash
dak replay --file ./ledger.json --out ./receipt.json
dak verify --file ./ledger-with-receipt.json --secret local-secret
dak audit  --file ./ledger.json
```

## Development

```bash
npm install
npm run typecheck
npm run test              # all tests
npm run test:determinism  # reducer, ledger, tick-engine, proof-receipt
npm run benchmark         # tick replay benchmark (emits JSON)
```

## Test coverage

10 test files covering: adaptation, introspection, lease-manager, ledger, memory, proof-receipt, reducer, retry-policy, slot-supervisor, tick-engine.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) -- subsystem overview
- [docs/INVARIANTS.md](docs/INVARIANTS.md) -- determinism invariants
- [docs/REPRODUCIBILITY.md](docs/REPRODUCIBILITY.md) -- verification guide

## Limitations

- No persistent repository implementation ships in this package (bring your own, e.g. Supabase)
- CLI commands require pre-exported ledger JSON files
- No WebSocket or HTTP transport; this is a library, not a server

## Related packages

- [@vaos/sdk](https://github.com/viable-systems/vaos-sdk) -- runtime factory that wires dak-core into applications
- [vaos](https://github.com/viable-systems/vaos) -- the hosted platform that uses both packages