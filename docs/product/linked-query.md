# Linked Query

Linked Query is a two-step SQL flow that lets you query one database, extract a
key column from the result, and feed those keys into a second query — commonly
in another database or connection. It is useful when you have foreign-key-style
relationships spread across databases with no shared query engine.

## Example

Database `auth` has:

```sql
SELECT uuid FROM users WHERE created_at > now() - interval '7 days';
```

Database `work` has a `tasks` table keyed on `user_id UUID`. You want the tasks
for those users:

```sql
SELECT id, title, user_id FROM tasks WHERE user_id IN (:step1.uuid);
```

Linked Query executes Step 1 in `auth`, extracts the `uuid` column from the
resulting rows, and rewrites `:step1.uuid` into a parameterised
`IN ($1, $2, …, $n)` before executing Step 2 in `work`.

## How it works

1. **Step 1 — Select the key values.** Choose a connection and database, write
   a read-only `SELECT` (or `WITH`), and hit Run. Only `SELECT`/`WITH` are
   accepted; DML/DDL is rejected before the query runs (validation constraint
   C1).
2. **Choose the key column.** The dropdown lists every column returned by
   Step 1. Pick the one you want to push down (decision D2: single-column
   keys only in v0).
3. **Step 2 — Query with the keys.** Pick a connection and database (may be
   the same as Step 1 or entirely different), write a second `SELECT`/`WITH`
   that references `:step1.<column>`, and hit Run. The placeholder is
   rewritten to `IN ($1, $2, …, $n)` with the extracted values bound as
   parameters — never as string concatenation.

## Rules and limits

- **Read-only.** Both Step SQLs must start with `SELECT` or `WITH`. `TABLE`,
  `VALUES`, `INSERT`, `UPDATE`, `DELETE`, and DDL are rejected (C1).
- **Single key column** in v0 (D2). Composite keys aren't supported yet.
- **NULL keys are dropped** silently before the rewrite (VQ4). If every key
  is NULL, Step 2 short-circuits as an empty keyset instead of running.
- **Empty keyset short-circuit** (D4). If Step 1 returned no rows — or the
  key column was entirely NULL — Step 2 skips the query entirely and shows
  "0 rows" without contacting the second database.
- **Hard cap: 5000 keys.** If Step 1 returns more than 5000 rows in the
  chosen key column, Step 2 refuses to run. Narrow Step 1 first.
- **Auto LIMIT.** Step 1 is capped at 5000 rows for preview. Step 2 gets a
  default `LIMIT 1000` when your SQL doesn't already include one.
- **Placeholder syntax.** `:step1.<column>` must reference the column you
  picked from the key-column dropdown. Any other name (`:step1.foo` when the
  column is `uuid`, or `:step2.…`) is a rewriter error.
- **Comment/string safety** (C2). The rewriter scans a sanitised copy of the
  SQL that blanks out comments and string literals, so a stray
  `-- :step1.uuid` in a comment or `'not :step1.uuid'` inside a literal is
  ignored — it will not be treated as a placeholder.

## Not persisted

Linked Query tabs are session-only. Closing the tab discards the Step 1
result set and both SQL editors. There is no history and no re-run of a
saved plan in v0 (documented in `history/linked-query/CONTEXT.md`).

## Errors you might see

| Error                                                          | Meaning                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Only SELECT or WITH allowed in Step SQL`                      | You wrote a DML/DDL/TABLE/VALUES statement. Rewrite as `SELECT`/`WITH`. |
| `Step 1 returned more than 5000 rows — narrow it first`        | Add a `WHERE` clause or `LIMIT` to Step 1.                              |
| `Placeholder :step1.<col> not found in Step 2 SQL`             | You picked a key column but never referenced it in Step 2.              |
| `Placeholder :step1.<col> references an unknown column`        | The referenced column isn't the one you selected in the dropdown.       |
| `Only :step1.* placeholders are supported`                     | You wrote e.g. `:step2.uuid`. Only Step 1 keys can be pushed down.      |
