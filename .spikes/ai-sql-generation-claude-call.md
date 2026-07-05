# Spike: Claude SQL generation (V2b) — LIVE RESULT

**Feature:** ai-sql-generation · **Date:** 2026-07-01 · **Result: YES (proven live)**

## Setup

- Model: `claude-sonnet-4-6` (user choice), Anthropic Messages API
  (`POST https://api.anthropic.com/v1/messages`, `anthropic-version: 2023-06-01`).
- Key read from the repo `.env` (`ANPROTHIC_KEY`) at call time; never printed.
- Same live demo DB + schema `shop` (simple + composite FKs) as the FK spike,
  with sample rows.
- Prompt = system ("PostgreSQL expert, use the FKs to join, return only SQL") +
  a plain-text schema block + an arrow-list of FK edges + the NL request.
  FK serialization = arrow list (`a.col -> b.col`, composite grouped in parens).

## Test 1 — single join + aggregation

Request: "List customer names together with the total amount of all their
orders, sorted descending." HTTP 200. Generated:

```sql
SELECT c.name, SUM(o.total) AS total_amount
FROM shop.customers c
JOIN shop.orders o ON o.customer_id = c.id
GROUP BY c.id, c.name
ORDER BY total_amount DESC;
```

Ran OK → Alice 200.00, Bob 50.00 (correct). Used the FK to join; clean SQL, no fences.

## Test 2 — multi-hop + composite FK join

Request (vi): per shipment, show shipment id, the ordering customer's name, and the
warehouse region. HTTP 200. Generated:

```sql
SELECT s.id AS shipment_id, c.name AS customer_name, w.region AS warehouse_region
FROM shop.shipments s
JOIN shop.orders o ON s.order_id = o.id
JOIN shop.customers c ON o.customer_id = c.id
JOIN shop.warehouses w ON s.region = w.region AND s.wh_code = w.code;
```

Ran OK → (100, Alice, US), (101, Bob, EU). Correctly chained shipments->orders->
customers (two hops) AND joined the **composite** FK to warehouses on both columns.

## Conclusion

- `@anthropic-ai/sdk`/HTTP reachable from this environment; SDK-in-main is proven
  viable (V2a) and a live call succeeds (V2b).
- The arrow-list FK serialization is enough for Claude to produce correct single-,
  multi-hop, and composite-key joins.
- Token cost is small (~278 in / ~59 out for test 1).

## Decisions confirmed for 0008

- Default model: **claude-sonnet-4-6**.
- FK serialization: **arrow list** (`src.col -> ref.col`, composite grouped).
- Prompt instructs "return ONLY SQL" — output needed no markdown stripping, but the
  E4 handler should still defensively strip ``` fences in case a model adds them.
