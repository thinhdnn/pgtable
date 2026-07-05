# 0008 Anthropic Claude for AI SQL Generation

Date: 2026-07-01

## Status

Proposed

## Context

pgtable is adding a feature (`ai-sql-generation`) that turns a natural-language
request into PostgreSQL, using the selected schema's tables, columns, and foreign
keys so the model can auto-join related tables. This introduces two durable
concerns that outlive the feature branch:

1. An **external provider** dependency (a hosted LLM API) — a `docs/FEATURE_INTAKE.md`
   hard-gate item.
2. A **secret at rest** — the provider API key must be stored locally.

CONTEXT.md decisions D1–D6 constrain the feature: generate-and-display only (no
auto-execute), Claude API, scoped-schema context, key entered in Settings, and a
non-SELECT warning.

## Decision

- Use the **Anthropic Claude API** via `@anthropic-ai/sdk` as the SQL-generation
  provider (CONTEXT D2). Default model: **`claude-sonnet-4-6`** (confirmed by the
  2026-07-01 live spike — correct single/multi-hop/composite-FK joins at ~278/59
  tokens). FK context is serialized as an **arrow list** (`src.col -> ref.col`,
  composite keys grouped). Opus 4.8 remains available as a quality upgrade.
- All Claude calls run in the **Electron main process only**, never the renderer —
  consistent with `0007-pg-main-process-only.md`. The API key never enters renderer
  memory; the renderer only learns whether a key "is set."
- The API key is stored **plaintext** in the local `electron-store` for now
  (CONTEXT D5), consistent with the existing plaintext connection-password deferral
  (`pgtable-mvp` D3). Encryption is explicitly deferred.
- The AI **only generates and displays** SQL (CONTEXT D1). It never executes against
  the database. Non-SELECT generated statements get a UI warning (CONTEXT D6).

## Alternatives Considered

1. **OpenAI / other hosted LLM** — rejected per D2; Claude chosen for SQL/code quality.
2. **Local/self-hosted model (Ollama, etc.)** — keeps schema on-device, but adds
   heavy setup and lower quality for MVP; deferred (CONTEXT deferred ideas).
3. **Encrypt the key now (safeStorage/AES)** — deferred to match the app-wide
   plaintext-secret posture; revisit with connection-password encryption.
4. **Call Claude from the renderer** — rejected; leaks the key into renderer memory
   and complicates secret handling.

## Consequences

Positive:

- Reuses the established main-process-only boundary and IPC pattern.
- No new persistence engine; the key rides the existing electron-store.
- D1 (no auto-execute) keeps blast radius small despite the external dependency.

Tradeoffs:

- Network dependency, provider errors, rate limits, and per-call cost.
- The selected schema's table/column/FK names leave the machine to Anthropic
  (accepted privacy boundary, CONTEXT D4).
- Plaintext key at rest is a known deferral, not a solved problem.

## Follow-Up

- Record the chosen model id and FK-serialization format here after the E2 spike.
- Revisit key + connection-password encryption together in a future decision.
- Add a schema-size guard if token cost on large schemas proves material.
- 2026-07-01: system prompt now instructs case-insensitive `ILIKE` matching for
  vague text labels (US-011), so unknown spelling/case/separators no longer yield
  empty results. Rejected sending real column *values* to the model (would cross
  the D4 privacy boundary and inflate tokens); a local `pg_trgm` "did-you-mean"
  on zero results is the planned next step instead.
