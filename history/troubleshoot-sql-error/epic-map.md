# Epic Map: Troubleshoot SQL Error

**Mode:** `high_risk_feature`
**Date:** 2026-07-09
**Reads:** `CONTEXT.md` (D1-D4), `discovery.md`, `approach.md`

## Feature Outcome

When a SQL statement a user wrote fails on any of the three SQL surfaces, the
error alert offers a troubleshoot action. It sends the failing SQL, the raw error
message, and that surface's schema context to the active AI provider, and renders
a diagnosis plus — when the failure is a SQL authoring problem — a corrected
statement the user applies with one click. Nothing ever runs by itself, and no
surface can accept an AI-authored destructive statement without a warning.

## Architecture / Reality Basis

- One new AI verb: `ai:troubleshoot-sql`, a discriminated payload over three
  surface kinds. The repo's convention is one channel per verb.
- `parseCheckResponse()` (`client.ts:78-125`) already produces
  `{ok, summary, issues[], fixedSql?}` with `fixedSql` **optional** — D4's
  "connection error ⇒ no Apply button" is satisfied by reuse, not new code.
- `resolveTarget()` already yields the `NO_API_KEY` sentinel.
- Dialect lives in the system prompt. `FEDERATED_SYSTEM_PROMPT` already teaches
  DuckDB `alias.schema.table`.
- **`isReadOnlyStatement` exists twice under one name with two different accept
  surfaces** (corrected by validating): `executor.ts:92` is a narrow C1
  *execution guard* (`SELECT|WITH`), `QueryEditor.tsx:148` is a broad *warning
  classifier* (`SELECT|WITH|TABLE|VALUES`). They must not be unified. The
  "Copied ... and kept in sync" comment in `executor.ts` belongs to
  `applyAutoLimit`, not to this function.
  Federated and Linked have **no** non-`SELECT` warning at all.
- Proof bar is `typecheck` + `test` + `build`. **Not `lint`** — `eslint` is
  declared in `package.json` but not installed.

## Epics

| Epic | Capability / Risk Area | Why It Exists | Stories | Proof Needed |
|---|---|---|---|---|
| **E1** | The troubleshoot contract, and whether a model returns parseable JSON when handed a raw error string | This is the assumption the whole feature rests on. No existing prompt takes an error message as input; a model given `ERROR: ... LINE 1: ... HINT: ...` may answer in prose and break the JSON contract. Proving it on the simplest surface de-risks the other two. | S1 | Live provider call recorded under `.spikes/`; unit tests on the parse reuse and the shared classifier; typecheck + build |
| **E2** | Context breadth and dialect: does the model get *enough, correctly named* schema to fix a failure on a surface whose tables are not in one Postgres schema? | Two independent context shapes stress this. Federated must name tables `alias.schema.table` across attached databases. Linked has no schema at all and needs a database-wide, capped fetch that does not exist yet. Each can fail while E1 is perfectly healthy. | S2, S3 | Live call per dialect; mutation-checked test that `fetchDatabaseSchema()` keeps `SCHEMA_INTROSPECT`'s exclusion set and `LIMIT 5000`; manual UAT |

Two epics, not four phases: the risk is not sequential milestones, it is two
independent failure modes — *the contract* and *the context*.

## Story Queue

| Story | Epic | Outcome | Depends On | Feasibility |
|---|---|---|---|---|
| **S1** | E1 | A failed run in **QueryEditor** shows a troubleshoot action; clicking it returns a diagnosis and, when fixable, a corrected statement the user applies. The read-only classifier moves to `src/shared/` and both existing copies are deleted. | — | **MEDIUM** — prompt-JSON assumption unproven |
| **S2** | E2 | A failed run in **FederatedQueryTab** does the same, with per-attachment `alias` + `database` + `schema` in the prompt, and the tab gains the non-`SELECT` warning it lacks today. | S1 | **MEDIUM** — DuckDB fix quality unproven |
| **S3** | E2 | A failed run in **one LinkedQueryTab step** does the same, with that step's database-wide schema and the earlier steps' column names so `:stepN.<col>` is understood, and the tab gains the non-`SELECT` warning it lacks today. | S1 | **MEDIUM** — `fetchDatabaseSchema()` does not exist |

Ordering is forced by risk, not convenience. S1 is the surface that **already**
has `applyFix()` and the non-`SELECT` warning, so it adds the least UI and
isolates the one question that matters: does the prompt hold. S2 and S3 each
introduce exactly one new unknown on top of a proven contract.

**Safety rule binding every story:** no surface gets an Apply button in the same
story that does not also give that surface a non-`SELECT` warning. An AI-authored
`DELETE` must never land silently in an editor.

## Current Story To Prepare

**S1 — Troubleshoot a failed query in QueryEditor.**

Why now: it is the only story that can prove E1's assumption, and every other
story depends on the contract it establishes. It is also the cheapest, because
`QueryEditor` already owns `applyFix()`, the non-`SELECT` warning, and the
`Alert` + Apply rendering this feature copies.

Testable exit: with a live provider configured, running
`SELECT id, emai FROM users` against a real database produces a Postgres error;
the troubleshoot action returns a diagnosis naming the `email` column and a
corrected statement; Apply writes it to the editor **without running it**; the
editor still requires an explicit Run. Running `DROP TABLE users` through the
same path and applying its "fix" raises the non-`SELECT` warning. Proof bar
green: `npm run typecheck`, `npm run test`, `npm run build`.

## Deferred

- **Capping AI schema context.** `fetchSchemaTables()`/`fetchForeignKeys()` have
  no row cap, so `ai:generate-federated-sql` is already unbounded on shipped
  code. Troubleshoot reuses the identical gathering and adds no new exposure.
  Fixing it properly touches three other handlers and is its own change.
- **Multi-turn troubleshooting** (apply, fail again, feed the new error back with
  history). `CONTEXT.md` defers it; the panel shape does not preclude it.
- **Table data grid / row editing errors.** Excluded by D1.

## Required Before Implementation

High-risk lane obligations from `docs/FEATURE_INTAKE.md`:

- A story folder from `docs/templates/high-risk-story/` with `execplan.md`,
  `overview.md`, `design.md`, `validation.md`.
- A durable decision record for the new IPC channel and the new class of
  outbound data. **The number must be checked, not assumed** — `docs/decisions/`
  already contains two `0006-*` and two `0007-*` files, so the next free integer
  is not simply "last + 1".

## Approval Gate

Planning has chosen the smallest work shape. Approve it before current story/work
prep. Tough work uses an epic map; beads wait until feasibility passes.
