# pgtable — Product Overview

## Purpose

pgtable is a lightweight Electron desktop app for browsing PostgreSQL databases. It targets developers, QA engineers, and DBAs who need to open quickly, connect quickly, and view data quickly — without the complexity of a full IDE like DBeaver.

## Target Users

- Developer
- QA
- DBA (basic needs)

## Design Principles

- Cold start under 2 seconds (installed app).
- Lazy loading at every tree level — never load metadata upfront.
- Always limit rows (default 100) when viewing table data.
- Minimal UI: browsing speed over feature count.

## Phase 1 MVP Scope

1. Connection Management
2. Database / Schema / Table Explorer
3. Table Data Viewer (grid + column metadata)

## Out of Scope (Phase 1)

SQL Editor, Export CSV/Excel, SSH Tunnel, Query History, View DDL/Indexes/Constraints, Dark Mode, Favorite/Recent Tables, Table Statistics, Auto-reconnect.
