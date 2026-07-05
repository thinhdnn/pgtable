# pgtable — Product Spec (Source of Truth)

Captured from user-provided spec on 2026-06-30. This is the canonical Phase 1 reference.

## Target Users

Developer, QA, DBA (basic needs)

## Phase 1 MVP Scope

1. Connection Management
2. Database / Schema / Table Browser
3. Table Data Viewer (grid + columns tab)

## Connection Fields

| Field | Notes |
|---|---|
| name | required, user-visible label |
| host | default localhost |
| port | default 5432 |
| username | required |
| password | plaintext in SQLite for MVP |
| ssl_mode | disable / allow / prefer / require / verify-ca / verify-full |
| default_database | optional, default postgres |
| description | optional |

## Connection States

`Connected` / `Disconnected` / `Failed`

## Connection Actions

Add, Edit, Delete, Test, Connect

## Tree Hierarchy

```
Connection
  └── Database
        └── Schema
              ├── Tables
              │     └── table_name
              └── Views
                    └── view_name
```

One Connection → many Databases (each database requires a new pg pool).
One Database → many Schemas.
One Schema → many Tables and Views.

## Layout Sketch

```
+--Left Sidebar--+--Main Panel (tabs)-------+
| Connections    | [Table A] [Table B] [+]   |
|  ▼ Production  |---------------------------|
|    ▼ intel     | Tabs: Data | Columns      |
|      public    |---------------------------|
|        users   | Data Grid                 |
|        orders  |                           |
+----------------+---------------------------+
```

## SQL Queries (exact)

### List Databases
```sql
SELECT datname
FROM pg_database
WHERE datistemplate = false
ORDER BY datname;
```

### List Schemas
```sql
SELECT schema_name
FROM information_schema.schemata
ORDER BY schema_name;
```

### List Tables and Views
```sql
SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name;
```

### List Columns
```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = $1
  AND table_name = $2
ORDER BY ordinal_position;
```

### Load Table Data
```sql
SELECT *
FROM <schema>.<table>
LIMIT $1
OFFSET $2;
```

## Table Viewer Behavior

- Pagination sizes: 100 / 500 / 1000 rows per page
- Default: 100 rows
- Column header click sorts (re-fetches with ORDER BY)
- Actions: Refresh, Copy Cell, Copy Row, Copy Selected Rows
- Two tabs per open table: **Data** and **Columns**

## Column Viewer Tab

Displays: column name, data type, is_nullable, column_default — in `ordinal_position` order.

## Phase 2+ (out of scope for MVP)

Export CSV/Excel, Recent/Favorite Tables, Auto-reconnect, SQL Editor, Query History, View DDL, View Indexes/Constraints, Multiple tabs, SSH Tunnel, Advanced SSL, Dark Mode, Table Statistics.
