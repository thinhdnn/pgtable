# Design

## Domain Model

One new AI **verb**: *troubleshoot* — "given a statement that failed and the
error it produced, explain why and, if it is fixable by rewriting the SQL,
produce the corrected statement."

This is distinct from the existing *check* verb, which is a pre-run static review
with no error to reason about. Two verbs, two prompts, two channels.

The result is the same structured review shape the *check* verb already returns:

```text
TroubleshootResult
  ok        boolean   true when nothing needed fixing
  summary   string    one-line diagnosis, always present
  issues    Issue[]   severity: 'error' | 'warning' | 'info'
  fixedSql  string?   ABSENT when the failure is not a SQL authoring problem
```

`fixedSql` being **optional is the whole of D4**. A connection error yields a
diagnosis with no `fixedSql`, and the panel renders no Apply button. There is no
error-classification code anywhere in the renderer.

## Application Flow

```text
QueryEditor: run fails, `error` state set
  └─ user clicks Troubleshoot on the error Alert
       └─ invoke(IPC.AI_TROUBLESHOOT_SQL, { kind:'query', connectionId, database, schema, sql, errorMessage })
            └─ ai-handlers: resolveTarget()            → { error:'NO_API_KEY' } routes renderer to Settings
                            fetchSchemaTables()        → reused unchanged
                            fetchForeignKeys()         → reused unchanged
                            buildTroubleshootUserMessage()
                 └─ client.troubleshootSql()
                      └─ callModel(target, TROUBLESHOOT_SYSTEM_PROMPT, msg, MAX_OUTPUT_TOKENS)
                           └─ parseCheckResponse()     → reused VERBATIM
            └─ renderer: <TroubleshootPanel result>
                 └─ [Apply suggested fix] → setSqlText(fixedSql); setGenWarning(!isReadOnlyStatement(fixedSql))
                      └─ NEVER runs. User presses Run.
```

The handler follows the established shape of `AI_CHECK_SQL` exactly: resolve the
target, gather schema + FK, build the message, call, return
`Result | { error: string }`.

## Interface Contract

**Channel** (`src/shared/ipc-channels.ts`):

```ts
// Explain a SQL statement that FAILED at execution and, when the failure is a
// SQL authoring problem, return a corrected statement. Distinct from
// ai:check-sql, which reviews a statement BEFORE it runs and has no error to
// reason about. Main process only; never executes anything (D1/D2). The payload
// is discriminated on `kind` so the federated and linked surfaces can add their
// own context shapes without a second channel.
AI_TROUBLESHOOT_SQL: 'ai:troubleshoot-sql',
```

**Types** (`src/shared/types.ts`):

```ts
export interface AiTroubleshootQueryPayload {
  kind: 'query'
  connectionId: string
  database: string
  schema: string
  /** The statement as executed, verbatim. */
  sql: string
  /** The raw driver error, including any LINE/HINT continuation lines. */
  errorMessage: string
}

/** Discriminated on `kind`. US-023 adds 'federated', US-024 adds 'linked'. */
export type AiTroubleshootPayload = AiTroubleshootQueryPayload

export interface AiTroubleshootResult {
  ok: boolean
  summary: string
  issues: AiCheckSqlIssue[]           // reuse; severity vocabulary is identical
  /** Corrected, runnable statement. ABSENT when the failure is not a SQL
   *  authoring problem (connection lost, timeout) — the renderer keys the
   *  presence of the Apply button off exactly this. */
  fixedSql?: string
}
```

`AiTroubleshootResult` is structurally identical to `AiCheckSqlResult`. It is
declared separately rather than aliased because the two verbs are free to diverge
later, and `parseCheckResponse()` returns a shape that satisfies both.

**Errors:** the standard envelope. `{ error: 'NO_API_KEY' }` when the active
provider is unconfigured — the renderer already routes that to Settings.
`{ error: string }` for anything else. An empty `sql` or empty `errorMessage`
returns `{ error: 'Nothing to troubleshoot' }` before any provider call.

## Data Model

No schema, no migration, no persistence. The troubleshoot result is transient
renderer state, discarded when the user runs again or closes the panel.

## Shared Code Extracted

> **Corrected by validating (2026-07-09).** The original design said "extract
> `isReadOnlyStatement` and delete both copies." That is wrong and unsafe. The
> two same-named functions have **deliberately different semantics**:
>
> | Location | Regex | `TABLE t` / `VALUES (1)` |
> |---|---|---|
> | `executor.ts:92` | `^(SELECT\|WITH)\b` | **rejected** — narrowed per linked-query constraint C1 |
> | `QueryEditor.tsx:148` | `^(SELECT\|WITH\|TABLE\|VALUES)\b` | accepted |
>
> `executor.test.ts` asserts `isReadOnlyStatement('TABLE t') === false` with the
> comment *"narrowed per C1"*. Unifying them on the broad regex would widen the
> read-only **execution guard** used by `duck-runner.ts` and the linked-query
> runner to accept `TABLE` and `VALUES`. Unifying on the narrow regex would make
> `QueryEditor` warn about statements that do not mutate anything.
>
> They are two different jobs that happen to share a name.

`src/shared/sql-statement.ts` (pure; no Node, no Electron — `@shared/*` is
already imported for runtime values by six main-process modules) exports:

| Export | Regex | Job | Callers |
|---|---|---|---|
| `stripCommentsAndStrings` | — | shared sanitiser both jobs depend on | moved out of `executor.ts:39` |
| `isNonMutatingStatement` | `^(SELECT\|WITH\|TABLE\|VALUES)\b` | **warning classifier**: "would applying this AI statement change data?" | `QueryEditor`, and S2/S3 |

**`isReadOnlyStatement` does not move and is not renamed.** It stays in
`executor.ts` as the **execution guard** (narrow, C1), and re-imports
`stripCommentsAndStrings` from `@shared/sql-statement`. `duck-runner.ts` and
`linked-query-handlers.ts` are untouched beyond that transitive import.

Deleted: `QueryEditor.tsx`'s private `isReadOnlyStatement` (replaced by
`isNonMutatingStatement`) and its private `stripCommentsAndStrings` (replaced by
the shared one). `QueryEditor`'s `applyAutoLimit` copy stays — it is byte-identical
to `executor.ts`'s, but deduplicating it is unrelated scope.

The two regexes must remain different, and the test suites must pin that:
`sql-statement.test.ts` asserts `isNonMutatingStatement('TABLE t') === true`
while `executor.test.ts` keeps asserting `isReadOnlyStatement('TABLE t') === false`.
Anyone who later "simplifies" the two into one breaks a suite.

## UI / Platform Impact

Desktop (Electron renderer) only.

- A `<Tooltip>`-wrapped icon button on the existing error `Alert` in
  `QueryEditor`. Label: "Troubleshoot this error with AI (does not run it)",
  matching the phrasing already used by the Check SQL button
  (`QueryEditor.tsx:652`).
- A new `<TroubleshootPanel>` in `src/renderer/src/components/common/` so S2 and
  S3 do not copy it. It renders the `Alert` + issue list + conditional
  `Apply suggested fix` button, mirroring `QueryEditor.tsx:726-784`.
- Per D4 the icon is shown whenever an error is shown. No error filtering.

## Observability

`debugLogPrompt('troubleshoot-sql', message)` in the handler, matching the three
existing AI handlers. It is a **no-op when `app.isPackaged`**, so the schema and
the user's SQL never reach an end user's console.

No new logs, metrics, or audit records. The user's SQL text is sent to the
provider — see `validation.md` for the disclosure this obliges.

## Alternatives Considered

1. **Extend `ai:check-sql` with an optional `errorMessage`.** Rejected. Its
   payload `{connectionId, database, schema, sql}` has no variant that can carry
   federated attachments or a linked step's upstream columns, so S2 and S3 would
   be blocked. It also makes one system prompt serve two different jobs.
2. **Three channels, one per surface.** Rejected. The repo's convention is one
   channel per verb. Three handlers and three type pairs for one behavior.
3. **Client-side classification of "AI-fixable" errors** to hide the icon.
   Rejected in D4 — a hardcoded list of connection-error string patterns is a
   maintenance trap that will misclassify. Making `fixedSql` optional achieves
   the same UX with no classifier.
4. **Auto-run the corrected statement.** Rejected in D2. A "corrected" statement
   can be an `UPDATE` or a `DELETE`.
