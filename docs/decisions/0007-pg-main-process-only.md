# 0007 PostgreSQL Connections Live Only in the Main Process

Date: 2026-06-30

## Status

Accepted

## Context

Electron has two process types: the main process (Node.js, full OS access) and renderer processes (Chromium, sandboxed). If pg were imported in the renderer, the renderer would hold database credentials and open raw TCP sockets — defeating Electron's security model.

## Decision

The `pg` module and `better-sqlite3` module are imported exclusively in the main process. The renderer communicates via IPC channels through a typed contextBridge preload script. Credentials never appear in IPC return values.

ESLint `no-restricted-imports` is configured on the renderer tsconfig to reject `pg` and `better-sqlite3` imports at lint time.

## Alternatives Considered

1. Import pg in renderer with nodeIntegration: true — fast to develop but exposes credentials and raw sockets to the renderer; violates Electron security guidelines.
2. Separate backend process (HTTP server) — adds HTTP layer overhead and port management complexity for no gain in a single-user desktop app.

## Consequences

Positive:
- Credentials are never passed to renderer context.
- Renderer is a pure React app with no Node.js dependencies.
- Security boundary is enforced at build time (ESLint) and at runtime (contextBridge).

Tradeoffs:
- All pg queries require an IPC round trip — adds ~1ms overhead per query (acceptable for interactive use).
- IPC channel types must be kept in sync across main and renderer.

## Follow-Up

- Enforce with `no-restricted-imports` ESLint rule in renderer eslint config.
- Review when adding streaming query support (large result sets may need stream-over-IPC design).
