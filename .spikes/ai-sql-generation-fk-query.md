# Spike: FK introspection query (V1) — LIVE RESULT

**Feature:** ai-sql-generation · **Date:** 2026-07-01 · **Result: YES (proven live)**

## Setup

Stood up a real Postgres 15 cluster (homebrew `postgresql@15`) in the scratchpad
(`initdb --locale=C`, unix socket `/tmp/pg501`, port 55432) and seeded schema `shop`
with simple + composite foreign keys:

- `orders.customer_id -> customers.id` (simple)
- `shipments.order_id -> orders.id` (simple)
- `shipments (region, wh_code) -> warehouses (region, code)` (composite)

## Query (as validated; app binds `$1` = selected schema)

The `pg_constraint` + `unnest(conkey, confkey) WITH ORDINALITY` query from
`validation.md` was run against the live DB.

## Output (exactly as returned)

```
        constraint_name        | src_table | src_column  | ref_table  | ref_column | key_ordinal
-------------------------------+-----------+-------------+------------+------------+-------------
 orders_customer_id_fkey       | orders    | customer_id | customers  | id         |           1
 shipments_order_id_fkey       | shipments | order_id    | orders     | id         |           1
 shipments_region_wh_code_fkey | shipments | region      | warehouses | region     |           1
 shipments_region_wh_code_fkey | shipments | wh_code     | warehouses | code       |           2
(4 rows)
```

## Conclusion

- Composite FK columns come back correctly paired and ordered by `key_ordinal`.
- Scoping via `src_ns.nspname = <schema>` works (D4).
- The app will use node-postgres `$1` binding (same pattern as existing
  `db-handlers.ts`); the psql-15 `\bind` limitation is CLI-only and irrelevant.

V1 is no longer "proven by docs" — it is **proven live**.
