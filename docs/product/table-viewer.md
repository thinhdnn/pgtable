# Table Viewer

## Tab Model

Each opened table occupies its own closeable tab in the main panel. Tab identity: `(connectionId, database, schema, table)`. Clicking a table already open focuses its existing tab — no duplicates.

## Data Tab

- Grid shows table rows fetched with `SELECT * FROM schema.table LIMIT $1 OFFSET $2`.
- Default page size: 100 rows.
- Page size options: 100 / 500 / 1000.
- Column header click: sort ascending → sort descending → unsorted (server-side re-fetch with ORDER BY).
- Actions: Refresh (re-fetch current page), Copy Cell (plain text), Copy Row (JSON object), Copy Selected Rows (JSON array).

## Columns Tab

Shows column metadata for the open table in ordinal_position order:

| Column | Source |
|---|---|
| Name | column_name |
| Type | data_type |
| Nullable | is_nullable |
| Default | column_default |

No client-side reordering.

## SQL Used

See `history/pgtable-mvp/SPEC.md` for exact queries.
