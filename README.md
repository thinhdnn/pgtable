# pgtable

A lightweight PostgreSQL desktop browser with two things a normal table viewer
doesn't give you:

1. **Ask AI** — describe what you want in plain language and get a runnable SQL
   query, with joins inferred from your schema's foreign keys.
2. **Federated queries via DuckDB** — run a single SQL statement across several
   Postgres databases at once, **without installing any extension on the
   database servers**.

Built as an Electron app (React + Ant Design). It aims for a cold start under
two seconds, lazy loading at every tree level, and a minimal UI that favours
browsing speed over feature count.

---

## Federated queries — join across databases, no server-side extension

The usual way to query across Postgres databases is `postgres_fdw` or `dblink`,
which a DBA has to install and configure **on the database server**. Often you
don't have that access, or the databases live on different hosts entirely.

pgtable sidesteps that. It embeds an **in-process DuckDB engine** with DuckDB's
`postgres` extension, and treats your existing connections as attachable
catalogs:

```
   ┌─────────────┐     ATTACH (READ_ONLY)     ┌──────────────┐
   │  pgtable    │ ─────────────────────────▶ │  auth  (pg)  │
   │             │                            └──────────────┘
   │  DuckDB     │ ─────────────────────────▶ ┌──────────────┐
   │  (in-app)   │                            │  billing (pg)│
   └─────────────┘                            └──────────────┘
        one SQL statement spanning both
```

For each run pgtable:

1. Spins up a **fresh in-memory DuckDB** instance.
2. `INSTALL postgres` + `LOAD postgres` (the extension lives in the app, not on
   your servers; downloaded once to DuckDB's local cache, then reused).
3. `ATTACH`es each selected connection **`READ_ONLY`** under a catalog alias
   derived from the connection name.
4. Sets a `search_path` from every `alias.schema` so unqualified table names
   resolve, then runs your statement and tears the instance down.

What this means for you:

- **Nothing to install on the database side.** No `postgres_fdw`, no `dblink`,
  no superuser. If pgtable can connect to a database, it can join it.
- **Cross-host, cross-database.** Attach databases from different servers in the
  same query.
- **Read-only by construction.** Only `SELECT` / `WITH` statements are accepted;
  every attach is `READ_ONLY`, so a federated query can never mutate your data.
- **Qualify to disambiguate.** When the same table name exists in two attached
  databases, reference it as `alias.schema.table`.

Saved federated queries persist locally (attachments + SQL + row-limit flag) so
you can reopen and re-run them.

> First federated run needs network access once so DuckDB can fetch the
> `postgres` extension into its local cache. After that it works from cache.

### Linked Query (an alternative for the no-shared-engine case)

There's also a simpler **two-step Linked Query**: run a read-only `SELECT` in
one database, pick a key column from the result, and push those keys into a
second query (`:step1.<column>` is rewritten into a parameterised
`IN ($1, …, $n)`) — commonly against a different connection. Useful for
foreign-key-style relationships spread across databases.

---

## Ask AI — natural language to SQL

Type a request in plain language; pgtable sends the relevant **schema** — tables,
columns, and foreign keys — to Anthropic's Claude and drops a runnable query
into the editor. It uses the foreign keys to auto-join related tables, including
multi-hop and composite-key joins, and reasons about ambiguous join paths rather
than guessing.

Three entry points:

| Where | What it does | What leaves your machine |
| --- | --- | --- |
| **Query tab** | Natural language → PostgreSQL for the selected schema | Schema only (table/column/FK names) — **no row data** |
| **Federated tab** | Natural language → DuckDB SQL across the attached databases | Schema of the attached databases — **no row data** |
| **Ask about this row** | Ask a question about one specific row | The row's values (shown to you first, with a warning) |

Design choices (see [docs/decisions/0008-anthropic-sql-generation.md](docs/decisions/0008-anthropic-sql-generation.md)):

- **Generate-and-display only.** The AI never executes anything. You review the
  SQL and run it yourself. Non-`SELECT` output gets a warning.
- **Key stays in the main process.** All Claude calls run in Electron's main
  process. Your API key never enters the renderer; the UI only learns whether a
  key "is set."
- **Schema, not data.** The SQL-generation paths send only schema metadata. The
  only path that sends actual row values is "Ask about this row," and it shows
  you the payload before sending.
- Default model `claude-sonnet-4-6` (Opus available as a quality upgrade).

### Setup

1. Get an Anthropic API key from <https://console.anthropic.com/>.
2. Open **Settings** in pgtable and paste the key. It's stored locally via
   `electron-store` (plaintext at rest for now, consistent with the app's
   current connection-password handling — encryption is a tracked follow-up).

The AI features are optional; connecting, browsing, and manual SQL all work
without a key.

---

## Other features

- **Connection management** — save multiple Postgres connections.
- **Explorer** — lazy database / schema / table tree; nothing is loaded upfront.
- **Table viewer** — paginated grid (`SELECT * … LIMIT/OFFSET`, default 100
  rows), server-side sort, a columns/metadata tab, and copy cell / row / rows.
- **SQL editor** — CodeMirror with SQL highlighting, autocompletion, and
  formatting.
- **Saved scripts & saved federated queries** — kept locally.

---

## Tech stack

- **Electron** + **electron-vite** — desktop shell and build.
- **React 18** + **Ant Design** + **TanStack Query/Table** — UI.
- **CodeMirror** — SQL editing.
- **[`pg`](https://node-postgres.com/)** — Postgres access (main process only).
- **[`@duckdb/node-api`](https://duckdb.org/)** — in-process federation engine.
- **[`@anthropic-ai/sdk`](https://docs.claude.com/)** — Ask AI.
- **electron-store** — local settings, connections, and saved queries.

The database drivers and all secrets live in the Electron **main process**; the
renderer talks to them only over IPC and never sees connection strings or the
API key.

---

## Development

```bash
npm install       # native modules (pg, duckdb) are rebuilt for Electron
npm run dev       # start in dev mode
npm run build     # type-check + build
npm run package   # build a distributable via electron-builder

npm test          # vitest
npm run typecheck # tsc for node + web
npm run lint       # eslint
```

Requires Node.js and, for the AI features, an Anthropic API key entered in
Settings.

---

## Security notes

- Federated attaches are always `READ_ONLY`; only `SELECT` / `WITH` statements
  run through DuckDB and Linked Query.
- Connection strings carry passwords and are never logged.
- API key and connection passwords are stored locally in plaintext for now
  (encryption is a tracked follow-up); they never leave your machine except that
  Claude calls send **schema metadata only** (and, for "Ask about this row," the
  row you explicitly choose to send).
