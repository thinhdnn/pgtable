# 0006 Electron + React + TypeScript Stack for pgtable

Date: 2026-06-30

## Status

Accepted

## Context

pgtable is a desktop app targeting macOS, Windows, and Linux. It needs native OS integration (file system for SQLite, OS keychain for future password encryption) and a fast, component-rich UI. The team is JavaScript/TypeScript-first.

## Decision

Use Electron as the desktop shell with React + TypeScript for the renderer process, scaffolded via electron-vite for fast Vite-based builds. UI components from Ant Design. Data grid from TanStack Table. Data fetching from TanStack React Query.

## Alternatives Considered

1. Tauri + React — smaller binary, Rust backend. Rejected: node-postgres requires Node.js; rewriting in Rust adds significant scope.
2. NW.js — older, less maintained, worse TypeScript story.
3. Native app (Swift/Kotlin) — no code reuse, far outside team skill set.

## Consequences

Positive:
- Full Node.js ecosystem available in main process (pg, better-sqlite3).
- electron-vite gives HMR in development and fast production builds.
- Ant Design's Tree, Table, and Form components directly match the sidebar, grid, and connection form use cases.

Tradeoffs:
- Electron binary is large (~150 MB unpacked).
- Native module rebuild (electron-rebuild) required for better-sqlite3 on each Electron ABI version bump.

## Follow-Up

- Record password encryption decision separately when Phase 2 encryption is added.
