# DAK Core Architecture

`@vaos/dak-core` is a deterministic autonomy kernel for event-sourced agent execution.

## Subsystems

- `core/`: deterministic reducers, retry/adaptation policy, phase model, memory retrieval.
- `engine/`: ledger append semantics, lease manager, tick loop orchestration, introspection.
- `storage/`: repository interfaces and implementations.
- `crypto/`: canonical digest/hash chain and determinism receipt generation.

## Execution Model

1. Acquire exclusive lease for stream.
2. Rebuild state from snapshot + tail events (or full replay).
3. Execute one deterministic transition.
4. Append event(s) with idempotency key and hash chaining.
5. Persist stream state + optional snapshot.
6. Release lease.

## Safety Contract

- All writes are idempotency-keyed.
- All events are hash chained.
- Reducer transitions are deterministic over ordered events.
- Policy-guarded writes prevent unsafe actor/event combinations.
