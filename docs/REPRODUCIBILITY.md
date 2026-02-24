# Reproducibility Guide

## Determinism Verification

```bash
npm run test:determinism
```

## Receipt Generation and Verification

```bash
npm run cli -- replay --file ./fixtures/ledger.json --out ./receipt.json --secret local-secret
npm run cli -- verify --file ./fixtures/ledger-with-receipt.json --secret local-secret
```

## Benchmark Baseline

```bash
npm run benchmark
```

The benchmark emits JSON suitable for versioned comparison.
