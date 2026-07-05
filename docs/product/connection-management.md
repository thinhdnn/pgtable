# Connection Management

## Fields

| Field | Type | Required | Default |
|---|---|---|---|
| id | uuid | auto | — |
| name | text | yes | — |
| host | text | yes | localhost |
| port | integer | yes | 5432 |
| username | text | yes | — |
| password | text | yes | plaintext (MVP) |
| ssl_mode | enum | yes | prefer |
| default_database | text | no | postgres |
| description | text | no | — |

SSL modes: disable, allow, prefer, require, verify-ca, verify-full.

## Actions

- **Add** — open form, fill fields, save.
- **Edit** — open existing connection in form, update, save.
- **Delete** — remove connection and destroy its pg pool if active.
- **Test** — create a transient connection, verify reachability, return latency or error message. Does not persist a pool.
- **Connect** — create a pg pool for this connection, mark state as Connected.
- **Disconnect** — drain and destroy the pool, mark state as Disconnected.

## Connection States

- `Connected` — pool is active.
- `Disconnected` — no pool. Default state on every app launch.
- `Failed` — last connect attempt returned an error.

## Password Storage

Passwords are stored as plaintext in SQLite for Phase 1 MVP. Encryption (Electron safeStorage or AES-256) is deferred to Phase 2.

## Session Behavior

All connections start as Disconnected on every app launch. No auto-reconnect. No session state restoration.
