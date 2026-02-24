# Changelog

All notable changes to `@vaos/dak-core` will be documented in this file.

## Unreleased

- Added Supabase-backed CI dogfood workflow to validate DB-path behavior.
- Added `scripts/ci/supabase-dogfood.ts` for repeatable integration validation.
- Added `scripts/ci/supabase-autonomy-schema.sql` bootstrap schema for CI/local runs.
- Added `npm run dogfood:supabase` and `@supabase/supabase-js` as a dev dependency.

## 0.2.0 - 2026-02-24

- Added deterministic receipt module (`buildDeterminismReceipt`, `verifyDeterminismReceipt`).
- Added `dak` CLI with `verify`, `replay`, and `audit` commands.
- Added standalone test harness, CI workflow, benchmark script, and reproducibility docs.
- Added governance files and issue templates.
- Added domain barrel topology under `src/core`, `src/engine`, `src/storage`, and `src/crypto`.

## 0.1.0 - 2026-02-24

- Initial public package boundary extracted from VAOS monorepo autonomy core.
- Deterministic tick engine, ledger, lease management, reducer, and introspection exports.
- Memory retrieval and bounded adaptation modules included.
