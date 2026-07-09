# Troubleshoot SQL Error - Approach

**Date:** 2026-07-09
**Reads:** `CONTEXT.md` (D1-D4), `discovery.md`, `history/learnings/critical-patterns.md`

## Mode Gate

**Mode: `high_risk_feature`.**

Applying `docs/FEATURE_INTAKE.md` honestly, five risk flags are set:

| Flag | Why it applies |
|---|---|
| External systems | a new outbound call to a provider SDK |
| Public contracts | a new IPC channel + new payload/result types |
| Existing behavior | the error `Alert` on three shipped surfaces changes |
| Weak proof | no component tests exist for any of the three surfaces |
| Multi-domain | query, federated, and linked-query domains change together |

Four or more flags is high-risk on its own, and **External provider behavior is a
hard gate**. The precedent agrees: `US-018-pluggable-ai-providers` is the one AI
story that ships as a high-risk story *folder*
(`docs/stories/epics/E05-ai/US-018-pluggable-ai-providers/`), while lower-risk
stories like US-016 and US-019 are single files.

Why the smaller modes are insufficient:

- **`small_change`** requires ≤3 files and no API/data-model change. This touches
  ~8 files and adds an IPC contract.
- **`standard_feature`** would let implementation begin without a design +
  validation artifact, but the hard gate forbids that.
- **`spike`** does not fit: no single assumption decides the path. The path is
  clear; the risk is in the blast radius.

High-risk here means **more proof and a durable decision record**, not more
phases. The work itself is small.

## Recommended Approach

Add **one** new AI verb, `ai:troubleshoot-sql`, whose payload is a discriminated
union over the three surfaces, and whose result reuses the existing structured
review shape.

```text
renderer surface (error Alert)
  └─ Troubleshoot button
       └─ IPC ai:troubleshoot-sql  { kind, sql, errorMessage, ...context }
            └─ ai-handlers: resolveTarget() → gather context per kind
                 └─ prompt: <dialect> system prompt + error-aware user message
                      └─ client.troubleshootSql() → callModel() → parseCheckResponse()
                           └─ { ok, summary, issues[], fixedSql? }
                                └─ panel: diagnosis + optional "Apply suggested fix"
```

Three things make this cheap:

1. `parseCheckResponse()` (`client.ts:78-125`) is reused **verbatim**. It already
   coerces the exact `{ok, summary, issues[], fixedSql?}` shape D2/D4 need, and
   already treats `fixedSql` as optional — which is precisely how D4's
   "connection error ⇒ diagnosis, no Apply button" falls out for free.
2. `resolveTarget()` gives the `NO_API_KEY` sentinel with no new code.
3. The dialect difference lives in the **system prompt**, not the channel. A
   Postgres troubleshoot prompt and a DuckDB troubleshoot prompt sit next to
   `SQL_CHECK_SYSTEM_PROMPT` and `FEDERATED_SYSTEM_PROMPT`.

### Rejected Alternatives

- **Extend `ai:check-sql` with an optional `errorMessage`.** Rejected: its
  payload has no federated or linked variant, and it would make one prompt serve
  both "review before running" and "explain this failure" — two different jobs
  with different best answers.
- **Three channels, one per surface.** Rejected: the repo's convention is one
  channel per *verb*. Three handlers, three type pairs, one behavior.
- **Cap the schema context inside this feature.** Rejected as scope. Per
  `discovery.md` Q3, the federated path is already unbounded on shipped code;
  fixing that correctly means touching three other handlers at once.

## Risk Map

| Component | Risk | Reason | Proof needed |
|---|---|---|---|
| Response parsing | LOW | `parseCheckResponse()` read end-to-end; `fixedSql` already optional | unit test on the reuse |
| `NO_API_KEY` routing | LOW | `resolveTarget()` unchanged | typecheck |
| Prompt returns valid JSON **when an error message is present** | **MEDIUM** | no existing prompt takes an error string; a model handed a stack trace may answer in prose and blow past the JSON contract | **live provider call** (spike precedent: `.spikes/ai-sql-generation-claude-call.md`) |
| Linked-surface schema fetch | **MEDIUM** | `fetchDatabaseSchema()` does not exist; must mirror `SCHEMA_INTROSPECT`'s system-schema filter **and** its `LIMIT 5000` cap, plus add FK edges | unit test on the filter; live call |
| DuckDB dialect fix quality | **MEDIUM** | model must return `alias.schema.table`, not bare Postgres | live federated call |
| Non-`SELECT` fix on Federated/Linked | **HIGH** | those two surfaces have **no** non-`SELECT` warning today (`discovery.md` Warnings); Apply could silently drop a `DELETE` into the editor | must ship the warning on all three surfaces in the same story that ships Apply |
| Unbounded federated context | MEDIUM (inherited) | pre-existing on `ai:generate-federated-sql`; not made worse | out of scope; recorded as deferred |
| Renderer regression | MEDIUM | no component tests exist | typecheck + build + manual UAT |

The HIGH row drives the story ordering: **no surface gets an Apply button before
that surface has a non-`SELECT` warning.**

## Likely Files And Order

Main-side capability first, then one surface at a time.

1. `src/shared/types.ts` — `AiTroubleshootPayload` (discriminated on `kind`),
   `AiTroubleshootResult`.
2. `src/shared/ipc-channels.ts` — `AI_TROUBLESHOOT_SQL` + comment block.
3. `src/shared/sql-statement.ts` *(new or existing)* — extract the non-`SELECT`
   classifier so all three surfaces share one pure, testable function.
4. `src/main/ai/prompt.ts` — troubleshoot system prompts + error-aware user
   message builders.
5. `src/main/ai/client.ts` — `troubleshootSql()` reusing `parseCheckResponse()`.
6. `src/main/ipc/ai-handlers.ts` — handler + `fetchDatabaseSchema()`.
7. `src/renderer/src/components/query/QueryEditor.tsx` — button + panel.
8. `src/renderer/src/components/federated/FederatedQueryTab.tsx` — button +
   panel + **new** non-`SELECT` warning.
9. `src/renderer/src/components/linked-query/LinkedQueryTab.tsx` — per-step
   button + panel + **new** non-`SELECT` warning.

A shared `<TroubleshootPanel>` in `src/renderer/src/components/common/` avoids
copying the panel three times.

## Relevant Learnings Applied

- *Provider SDK in Electron main via `externalizeDepsPlugin`* — no
  `electron.vite.config.ts` change is needed; `callModel()` already resolves.
- *Never return raw secrets over IPC* — this feature adds no key-shaped payload.
- *Proof bar must match actually-installed tooling* — **`npm run lint` is
  excluded from the proof bar.** `eslint` is not installed. Verified again this
  session: `ls node_modules/.bin | grep eslint` → nothing.

## Proof Bar

```bash
npm run typecheck   # node + web
npm run test        # vitest; currently 114 passing across 11 files
npm run build
```

Plus, because renderer behavior is unprovable by unit test here: a live provider
call recorded under `.spikes/`, and manual UAT against a real failing query.

## Questions For Validating

1. Does a real provider still return **parseable JSON** when the user message
   contains a raw Postgres error string (`ERROR:  column "emai" does not exist`)
   including its `HINT:`/`LINE 1:` continuation lines? Prove with one live call
   per dialect and record it under `.spikes/`.
2. Does `fetchDatabaseSchema()` reproduce `SCHEMA_INTROSPECT`'s exclusion set
   exactly (`pg_catalog`, `information_schema`, `pg_toast%`, `pg_temp_%`) and its
   `LIMIT 5000`? A mutation check should fail if either drifts — same discipline
   as US-016's `MAX_KEY_VALUES === LINKED_STEP_ROW_LIMIT` assertion.
3. Does a new `docs/decisions/NNNN-*.md` need to exist before implementation?
   Intake says a durable decision is required when API shape changes meaningfully;
   a new IPC channel plus a new class of outbound data qualifies. Confirm the
   number is `0012` (both `0006-*` and `0007-*` already collide in
   `docs/decisions/`, so the next free integer must be checked, not assumed).
