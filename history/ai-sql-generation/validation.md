# AI SQL Generation - Validation

**Feature slug:** ai-sql-generation
**Date:** 2026-07-01
**Mode:** standard_feature + spike + decision record
**Gate status:** Gate 2 approved; this is the Gate 3 (execution) feasibility check.

## Reality Gate

- **Mode fit:** standard_feature holds. D1 (generate-and-display, no execution)
  keeps blast radius small; the external-provider hard gate is handled with a
  decision record (`docs/decisions/0008-*`) + this feasibility pass rather than
  the full high-risk story-folder process. PASS.
- **Repo truth:** app code exists and is complete-looking on disk (read directly).
  NOTE: `harness-cli query matrix` shows US-001..006 as in_progress/planned — the
  harness story bookkeeping lags the actual code. Ground truth = the code. Not a
  blocker for this feature.
- **Smaller path challenge:** no smaller path removes the two irreducible needs
  (an external LLM call + a stored key). Scope is already minimal.

## Environment — live spikes DID run (update)

Initial read said no reachable Postgres and no network. Both were worked around and
the two runtime probes were **executed live**:

- Stood up a real Postgres 15 cluster (homebrew `postgresql@15`) in the scratchpad
  and seeded simple + composite FKs -> V1 run live.
- Outbound network works (`api.anthropic.com` reachable); user supplied the key in
  `.env` -> V2b run live with `claude-sonnet-4-6`.
- No fabrication: see `.spikes/ai-sql-generation-fk-query.md` and
  `.spikes/ai-sql-generation-claude-call.md`.

## Feasibility Matrix

| Item | Verdict | Evidence |
|---|---|---|
| **V2a** Claude SDK callable from Electron main | **PROVEN** | `electron.vite.config.ts` main uses `externalizeDepsPlugin()`; `pg`, `electron-store`, `uuid` already load as Node modules in main via this exact mechanism. `@anthropic-ai/sdk` is a pure-Node package — same path. |
| **V1** FK introspection query | **PROVEN LIVE** | Ran against a real Postgres 15 cluster seeded with simple + composite FKs (schema `shop`). Returned correct paired/ordered columns incl. the composite `shipments(region,wh_code)->warehouses(region,code)`. See `.spikes/ai-sql-generation-fk-query.md`. |
| **V2b** Claude returns runnable SQL from scoped schema+FK | **PROVEN LIVE** | Real `claude-sonnet-4-6` calls (HTTP 200) against the demo schema produced correct single-join+aggregate SQL AND multi-hop + composite-FK join SQL; both ran on the live DB and returned correct rows. See `.spikes/ai-sql-generation-claude-call.md`. |
| **V3** Proof strategy | **RESOLVED** | Repo has no test runner (only `typecheck`/`lint`/`build` in package.json). Per-story proof bar = `npm run typecheck` + `npm run lint` + manual UAT. Add a minimal unit test ONLY for the D6 statement classifier (pure function, no DB needed) if a runner is introduced; otherwise cover it by UAT. |
| **V4** Decision record | **DONE** | `docs/decisions/0008-anthropic-sql-generation.md` drafted (Proposed). |

## V1 — Drafted FK introspection query (composite-FK-safe, scoped per D4)

```sql
SELECT
  con.conname            AS constraint_name,
  src_ns.nspname         AS src_schema,
  src.relname            AS src_table,
  src_att.attname        AS src_column,
  tgt_ns.nspname         AS ref_schema,
  tgt.relname            AS ref_table,
  tgt_att.attname        AS ref_column,
  k.ord                  AS key_ordinal
FROM pg_constraint con
JOIN pg_class      src    ON src.oid = con.conrelid
JOIN pg_namespace  src_ns ON src_ns.oid = src.relnamespace
JOIN pg_class      tgt    ON tgt.oid = con.confrelid
JOIN pg_namespace  tgt_ns ON tgt_ns.oid = tgt.relnamespace
JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(src_attnum, ref_attnum, ord) ON true
JOIN pg_attribute  src_att ON src_att.attrelid = con.conrelid AND src_att.attnum = k.src_attnum
JOIN pg_attribute  tgt_att ON tgt_att.attrelid = con.confrelid AND tgt_att.attnum = k.ref_attnum
WHERE con.contype = 'f'
  AND src_ns.nspname = $1
ORDER BY con.conname, k.ord;
```

Renderer/main assemble these rows into FK edges (grouped by `constraint_name`,
ordered by `key_ordinal` for composite keys) and feed them to the prompt alongside
the existing `SCHEMA_INTROSPECT` tables+columns, scoped to the selected schema.

## Integration Readiness

- New IPC channels drop into `ipc-channels.ts`; generic preload needs no change.
- New handlers register in `src/main/index.ts` next to existing `registerDbHandlers`.
- Generated SQL flows into `QueryEditor`'s existing `sqlText` state; D6 warning
  reuses its `stripCommentsAndStrings()` + statement classifier.
- Key storage reuses electron-store (`connection-store.ts` pattern).

## Verdict

Feasibility is **evidence-backed and READY**. Both gate-critical runtime probes
were run **live** this session: V1 (FK query, incl. composite keys) against a real
Postgres, and V2b (`claude-sonnet-4-6` producing correct single/multi-hop/composite
joins that ran on the live DB). No `NO` spike result; no reality-gate failure. No
runtime unknowns remain — execution is build-and-wire work.

## Bead Preview (create after execution approval)

1. **E1** FK query + `schema:foreign-keys` IPC + FK edge type — verify against real DB.
2. **E3** settings-store key + `settings:get/set` IPC + Settings modal (TitleBar gear).
3. **E2** Claude main module + prompt builder + `ai:generate-sql` IPC — verify one live call.
4. **E4** NL input in QueryEditor -> generated SQL + D6 non-SELECT warning.
