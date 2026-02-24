# Determinism Invariants

These invariants must hold for every stream.

1. **Hash chain continuity**
: For event `n>1`, `prev_hash(event_n) == event_hash(event_{n-1})`.

2. **Monotonic sequence**
: Event sequence numbers are contiguous and strictly increasing.

3. **Idempotent append**
: Reusing an idempotency key must return the same event without duplicating writes.

4. **Replay equivalence**
: Reducing the same ordered event list yields identical reduced state hash.

5. **Snapshot equivalence**
: Replay from full log and replay from snapshot+tail converge to same reduced state.

6. **Lease exclusivity**
: At most one worker can hold active lease for a stream at any time.

7. **Bounded adaptation**
: Adaptation attempts cannot exceed configured max attempts.
