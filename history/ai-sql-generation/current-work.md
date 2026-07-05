# AI SQL Generation - Current Work (for validating)

**Feature slug:** ai-sql-generation
**Gate status:** Gate 1 (context) approved · Gate 2 (work shape) approved
**Mode:** standard_feature + feasibility spike + decision record
**Next gate:** Gate 3 (execution) — blocked until validating accepts feasibility

Beads are intentionally NOT created yet. Validating verifies repo reality and
runs the E2 spike; only then does swarming/executing create beads.

## What validating must verify

### V1 — E1 FK introspection is buildable (repo-real check)
- Confirm `pg_constraint` + `pg_class`/`pg_namespace`/`pg_attribute` give FK edges
  (source schema.table.columns -> referenced schema.table.columns) scoped to one
  schema (D4), matching the introspection style already in `db-handlers.ts`.
- Exit state: a concrete SQL query drafted and sanity-checked against a DB with
  known FKs (or confirmed against pg docs if no such DB is reachable).

### V2 — E2 Claude integration feasibility SPIKE (the gate-critical unknown)
- Prove `@anthropic-ai/sdk` can be called from the Electron **main** process
  (bundler/externals in electron-vite don't break it).
- Prove a prompt built from scoped schema + FK edges yields runnable PostgreSQL
  from a real Claude call.
- Decide default model (Opus 4.8 / Sonnet 4.6 / Haiku 4.5) and FK serialization
  format on the cost/quality axis.
- Spike output goes to `.spikes/` per Khuym. If the spike fails, halt and return
  to planning (do not proceed to beads).

### V3 — Proof strategy resolution
- Repo has no test suite. Validating decides the accepted proof bar per story:
  manual UAT + `npm run typecheck` + `npm run lint`, vs adding minimal tests for
  the FK query and the D6 statement classifier. Record the decision.

### V4 — Decision record
- Draft `docs/decisions/NNNN-anthropic-sql-generation.md` (Anthropic provider
  adoption + plaintext-key deferral per D5) using `docs/templates/decision.md`,
  then register via `scripts/bin/harness-cli decision add`.

## After validating passes (preview, not yet actioned)

Bead-sized slices, in dependency order:
1. E1: FK introspection query + `schema:foreign-keys` IPC + FK edge type.
2. E3: settings-store key + `settings:get/set` IPC + Settings modal from TitleBar.
3. E2: Claude main module + prompt builder + `ai:generate-sql` IPC (post-spike).
4. E4: NL input in QueryEditor -> generated SQL + D6 non-SELECT warning.
