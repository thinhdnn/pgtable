# Database / Schema / Table Explorer

## Tree Hierarchy

```
Connection
  └── Database A
        ├── public
        │     ├── Tables
        │     │     ├── users
        │     │     └── orders
        │     └── Views
        │           └── vw_summary
        └── audit
```

One Connection → many Databases (each database uses a separate pg pool with that database name).
One Database → many Schemas.
One Schema → Tables and Views (listed together, distinguished by type icon).

## Lazy Loading

Each tree level loads only when the node is expanded. No pre-fetching on connect.

- Connect → load database list
- Expand database → load schema list
- Expand schema → load table + view list

## Explorer Actions

- **Refresh** — re-fetch children of any node.
- **Search tables** — client-side filter on table names within a schema (does not filter databases or schemas).
- **Double-click table** — opens the table in a new tab in the main panel (or focuses existing tab).

## SQL Used

See `history/pgtable-mvp/SPEC.md` for exact queries.
