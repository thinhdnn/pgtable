# AI SQL Generation - Approach

**Feature slug:** ai-sql-generation
**Date:** 2026-07-01
**Depends on:** `history/ai-sql-generation/CONTEXT.md` (D1–D6), `discovery.md`

## Intake Lane Recommendation

Risk flags that apply (per `docs/FEATURE_INTAKE.md`):

| Flag | Applies? | Note |
|---|---|---|
| External systems | **YES (hard gate)** | Anthropic Claude API — network provider dependency |
| Audit/security | Partial | A secret (API key) is stored at rest |
| Data model | Minor | One new key in electron-store; no schema/migration/deletion |
| Public contracts | No | New internal IPC channels only, no external contract |
| Existing behavior | Low | Additive; QueryEditor gains an input, existing paths untouched |
| Weak proof | **YES** | No automated test suite in repo |

Raw count + the External-System hard gate would push toward **high-risk**. But
**D1 removes the dangerous blast radius**: the AI only generates text that the user
reviews and runs manually — it never touches the database itself, and the "secret"
is the user's own local key (no auth/authorization/multi-tenant surface).

**Recommendation: `standard_feature` mode with two high-risk safeguards bolted on:**
1. A **feasibility spike** for the Claude integration before full build (validating gate).
2. A **decision record** in `docs/decisions/` for adopting the Anthropic provider
   and the plaintext-key deferral (external-provider + secret changes are durable).

This is the "least workflow that protects the work." If you'd rather run the full
high-risk story-folder process, say so at the approval gate and I'll switch.

## Path (smallest believable route)

The four gaps form a natural dependency chain. Build backend context first, prove
the AI call, then wire UI.

```
E1 FK introspection  ──┐
                       ├──> E2 Claude integration (spike-gated) ──> E4 Generate UI
E3 Settings/API key  ──┘                                              (D1, D6)
```

## Epic Map (capability/risk areas)

### E1 — Foreign-key introspection
- New pg_catalog query over `pg_constraint (contype='f')` returning FK edges
  (source table/columns -> referenced table/columns) for the **selected schema** (D4).
- New IPC channel (e.g. `schema:foreign-keys`), handler in `db-handlers.ts`,
  shared type for an FK edge.
- Risk: low — mirrors existing introspection. Proof: run against a DB with known FKs.

### E2 — Claude integration (feasibility-gated)
- Add `@anthropic-ai/sdk`. New main-process module (`src/main/ai/`) that builds the
  prompt from scoped schema + FK edges and calls Claude; returns generated SQL.
- New IPC channel `ai:generate-sql`. Model id + token budget chosen here, recorded
  in `docs/decisions/`.
- **Highest-risk area — requires a spike** (real API call from main, real SQL back)
  before its beads are created.
- Risk: external provider, secret in main only.

### E3 — Settings / API key (D5)
- API key stored in electron-store; `settings:get` / `settings:set` IPC pair.
- Settings modal opened from the TitleBar gear (antd Modal + Form).
- Risk: secret at rest (plaintext, accepted per D5). Key never sent to renderer
  except as a masked "is set" flag.

### E4 — Generate UI into QueryEditor (D1, D6)
- Natural-language input (in/near QueryEditor header) -> calls `ai:generate-sql`
  with the active connection/database/selected schema -> sets `sqlText`.
- **Non-SELECT warning (D6):** reuse QueryEditor's existing
  `stripCommentsAndStrings()` + statement classification to detect non-SELECT
  generated SQL and show a clear antd warning banner before the user runs it.
- Empty/missing-key state routes the user to E3's settings modal.
- Risk: UX only; no execution added (D1).

## Files In Play

- `src/shared/ipc-channels.ts` — add `schema:foreign-keys`, `ai:generate-sql`,
  `settings:get`, `settings:set`.
- `src/shared/types.ts` — FK edge type, generate request/response types.
- `src/main/ipc/db-handlers.ts` (FK) + new `src/main/ipc/ai-handlers.ts` +
  `src/main/ai/*` (Claude client, prompt builder).
- `src/main/db/settings-store.ts` (or extend connection-store's store) — API key.
- `src/main/index.ts` — register new handlers.
- `src/renderer/src/components/query/QueryEditor.tsx` — generate input + D6 warning.
- `src/renderer/src/components/TitleBar.tsx` + new settings modal component.
- `package.json` — `@anthropic-ai/sdk`.
- `docs/decisions/NNNN-anthropic-sql-generation.md` — provider + key-deferral decision.
- `docs/stories/epics/` — story packets per confirmed lane.

## Open Questions For Validating

1. **Spike scope:** confirm `@anthropic-ai/sdk` works from Electron main (no bundler
   externals issue) and that a scoped schema+FK prompt yields runnable SQL. Which
   model to default to (Opus 4.8 vs Sonnet 4.6 vs Haiku 4.5) on the cost/quality axis?
2. **Proof strategy:** with no test suite, is manual UAT + `npm run typecheck` +
   `npm run lint` the accepted proof bar per story, or should this feature introduce
   a minimal test setup for the FK query and statement classification?
3. **FK serialization format** for the prompt (DDL-like text vs structured JSON list)
   — decide during the spike using whichever the model handles more reliably.
4. **Schema size guard:** should the prompt cap the number of tables/columns sent
   (large schemas -> token cost), and what happens past the cap?

## Do NOT (locked exclusions)

- No auto-execution of generated SQL (D1).
- No whole-database context; selected schema only (D4).
- No key encryption this iteration (D5 deferral).
- No multi-turn refine / query-explain / result-feedback (deferred ideas).
