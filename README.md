# @vaos/dak-core

Deterministic autonomy kernel primitives for event-sourced agent execution.

## What this package provides

- deterministic reducer and phase model
- idempotent ledger append semantics
- exclusive lease manager
- tick engine with retry/dead-letter behavior
- introspection and memory retrieval helpers
- proof-carrying determinism receipts
- `dak` CLI for `verify`, `replay`, and `audit`

## Install

```bash
npm install @vaos/dak-core
```

## Core commands

```bash
npm run test:determinism
npm run benchmark
npm run build
npm run dogfood:supabase
```

`dogfood:supabase` expects `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to be set, and writes `artifacts/supabase-dogfood-core.json`.

## CLI usage

```bash
dak replay --file ./ledger.json --out ./receipt.json

dak verify --file ./ledger-with-receipt.json --secret local-secret

dak audit --file ./ledger.json
```

## Docs

- `docs/ARCHITECTURE.md`
- `docs/INVARIANTS.md`
- `docs/REPRODUCIBILITY.md`
