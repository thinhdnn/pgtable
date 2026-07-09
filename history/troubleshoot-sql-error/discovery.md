# Troubleshoot SQL Error - Discovery

**Date:** 2026-07-09
**Source of truth:** `history/troubleshoot-sql-error/CONTEXT.md` (D1-D4 locked)
**gkg:** not available — `node .codex/khuym_status.mjs --json` returns `gkg: null`
and no `supported_languages`. Fallback used: `rg`/`grep` plus direct file reads.
Every claim below was read out of the file, not inferred.

## Architecture Snapshot

The AI path is a strict one-way street: **renderer → IPC → main → provider**.
The renderer never imports a provider SDK and never sees an API key.

| Layer | File | Role |
|---|---|---|
| Channel names | `src/shared/ipc-channels.ts` | one narrow `ai:<verb>` per feature |
| Payload/result types | `src/shared/types.ts` | `Ai*Payload` / `Ai*Result` pairs |
| Handler + context gathering | `src/main/ipc/ai-handlers.ts` | `resolveTarget()`, `fetchSchemaTables()`, `fetchForeignKeys()` |
| Prompt construction | `src/main/ai/prompt.ts` | one `*_SYSTEM_PROMPT` + one `build*Message*()` per verb |
| Provider call + parsing | `src/main/ai/client.ts` | `generateSql()`, `checkSql()`, `askAboutRow()` |
| Provider abstraction | `src/main/ai/providers.ts` | `callModel(target, system, user, maxTokens)` |

Four AI verbs exist today: `ai:generate-sql`, `ai:generate-federated-sql`,
`ai:check-sql`, `ai:ask-row`. Each is one channel, one system prompt, one
`client.ts` function.

## Answers To The Deferred Questions

### Q1 — How does `LinkedQueryTab` supply a schema name?

**It does not have one, and it does not need one.**

- `StepState` (`LinkedQueryTab.tsx:41-52`) holds `connectionId`, `database`,
  `sql`, `result`, `skipped`, `error`, `running`, `autoLimit`. No `schema`.
- But the step editor already calls `SCHEMA_INTROSPECT`
  (`LinkedQueryTab.tsx:90-107`), and that handler
  (`db-handlers.ts:661-700`) returns **every non-system schema of the whole
  database**, each table tagged with its own `schema`, bounded by `LIMIT 5000`
  columns. It excludes `pg_catalog`, `information_schema`, `pg_toast*`,
  `pg_temp_*`.
- Meanwhile `fetchSchemaTables(connectionId, database, schema)` in
  `ai-handlers.ts` is **single-schema** and has **no row cap**.

So the linked surface's real need is a *database-wide, capped* schema fetch, not
a schema picker. The shape already exists in `SCHEMA_INTROSPECT`; what it lacks
is `data_type` per column and FK edges.

**Consequence for the plan:** the linked variant needs a main-side
`fetchDatabaseSchema(connectionId, database)` that mirrors `SCHEMA_INTROSPECT`'s
filter + cap but also returns `data_type` and FK edges across all schemas. This
gives the model exactly what the user's own autocomplete sees — a property worth
having, because a user who wrote `analytics.events` in a step will get an AI that
knows `analytics.events` exists.

### Q2 — One channel, three channels, or extend `ai:check-sql`?

**One new channel, `ai:troubleshoot-sql`, with a discriminated payload.**

- Extending `ai:check-sql` is wrong: its `AiCheckSqlPayload`
  (`types.ts:261-266`) is `{connectionId, database, schema, sql}` — there is no
  variant that can carry federated attachments or a linked step's upstream
  columns, and it is semantically a *pre-run* review with no error to reason
  about. Conflating "review before you run" with "explain why this failed" makes
  one prompt serve two jobs badly.
- Three channels triples the handler, the type pair, and the channel comment for
  a single verb. The repo's convention is one channel per **verb**, not per
  **surface** — `ai:generate-sql` and `ai:generate-federated-sql` are separate
  because they are different dialects with different context shapes, but each is
  still one verb per channel.
- The response shape is already solved. `parseCheckResponse()`
  (`client.ts:78-125`) is dialect-agnostic: it extracts the outermost `{...}`,
  coerces `severity`, drops malformed issues, strips fences from `fixedSql`, and
  degrades to `{ok:false, summary:<raw text>}` when the JSON is unparseable. It
  already treats `fixedSql` as optional, which is exactly what D4 requires for
  connection errors. **This function is reusable verbatim.**

The dialect difference lives in the *system prompt*, not the channel:
`SQL_CHECK_SYSTEM_PROMPT` for Postgres, `FEDERATED_SYSTEM_PROMPT` already teaches
the `alias.schema.table` DuckDB dialect.

### Q3 — What input token ceiling does the federated path have?

**None. There is nothing to copy.**

`fetchSchemaTables()` and `fetchForeignKeys()` in `ai-handlers.ts` have **no
`LIMIT`** (`grep -n LIMIT src/main/ipc/ai-handlers.ts` matches only the
`ai:suggest-values` handler). `ai:generate-federated-sql` calls both once per
attachment via `Promise.all` and concatenates the results into one prompt.

So a multi-attachment federated prompt is **already unbounded today**, on a
shipped code path. Troubleshoot reuses that identical gathering and therefore
introduces **no new exposure** — it inherits an existing one.

`MAX_OUTPUT_TOKENS = 16000` (`client.ts:35`) caps *output* only, and the comment
there explains why it cannot go higher without streaming adapters.

**Consequence for the plan:** do not invent a cap inside this feature. Capping
schema context is a separate change that would alter `ai:generate-sql`,
`ai:generate-federated-sql`, and `ai:check-sql` at the same time. Record it as a
deferred risk, not scope.

## Constraints

- **`npm run lint` is a lie.** `package.json` declares
  `"lint": "eslint src --ext .ts,.tsx"` but `node_modules/.bin/eslint` does not
  exist. `history/learnings/critical-patterns.md` already records this trap.
  **The proof bar must not name lint.**
- Working proof commands: `npm run typecheck` (node + web), `npm run test`
  (vitest, currently 114 tests / 11 files), `npm run build`.
- Vitest covers **pure functions only**. There is no component test harness, so a
  renderer change is proven by typecheck + build + manual UAT, never by a unit
  test. Any pure logic this feature adds should be extracted so it *can* be
  tested.
- `@shared/*` is imported by both main and renderer; anything placed there must
  be free of Node and Electron imports.

## What Exists / What Is Missing

**Exists and is reusable as-is:** `resolveTarget()` (`NO_API_KEY` sentinel),
`fetchForeignKeys()`, `parseCheckResponse()`, `stripFences()`, `callModel()`,
`serializeForeignKeys()`, the `Alert` + `Apply suggested fix` rendering
(`QueryEditor.tsx:726-784`), the non-`SELECT` warning
(`QueryEditor.tsx:714-724`), `deriveSqlHint()`.

**Missing, must be built:** the `ai:troubleshoot-sql` channel; a
`TROUBLESHOOT_SYSTEM_PROMPT` per dialect; a `buildTroubleshootUserMessage()` that
places the **error message** next to the SQL; a database-wide capped schema fetch
for the linked surface; the troubleshoot button + result panel on three surfaces;
`FederatedQueryTab` and `LinkedQueryTab` currently have **no** `applyFix()`
equivalent (only `QueryEditor` does).

## Warnings

- `FederatedQueryTab` and `LinkedQueryTab` have **no existing non-`SELECT`
  warning**. Only `QueryEditor` does. Applying an AI-authored fix on those two
  surfaces introduces a place where an `UPDATE`/`DELETE` can land in an editor
  with no warning shown. This is a real gap the plan must close, not inherit.
- The failing SQL is sent verbatim, so **literals the user typed**
  (`WHERE email = 'a@b.com'`) leave the machine. D3 forbids sending *row values*
  from results; it does not and cannot prevent the user's own SQL text from
  containing data. `ai:check-sql` already has this property. Worth one sentence
  in the decision record, not a blocker.
