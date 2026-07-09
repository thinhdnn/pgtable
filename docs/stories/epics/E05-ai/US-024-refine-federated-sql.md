# US-024 Refine federated SQL with AI

## Status

in_progress

## Lane

normal

Risk flags: external systems (the DuckDB generation prompt gains a block sent to
the provider), public contracts (`AiGenerateFederatedSqlPayload` gains an
optional `baseSql`), existing behavior (`prompt.test.ts` pins the current
federated prompt). Three flags — normal with stronger validation.

The external-provider hard gate was explicitly narrowed by the user. Grounds: the
new prompt block is copied verbatim from the shipped `buildUserMessageParts`
refine path, and when `baseSql` is absent the federated prompt is byte-identical
to today's — so the generate path that exists cannot regress. A test pins that
invariant rather than asserting it.

## Product Contract

`QueryEditor` has two AI generation modes on one button. With no editor
selection, "Ask AI" writes a query from scratch and replaces the buffer. With a
selection, it enters *refine* mode: the selected SQL is shown as context, sent to
the model as the query to modify, and the result replaces only that selection.

`FederatedQueryTab` has the same button but only the first mode. A user who
generated a federated query and wants one change ("also filter by region") must
re-describe the whole query from scratch, and the result flattens the buffer.

The federated editor must offer the same refine mode as the query editor: select
SQL, ask for a change, get the changed SQL back in place of the selection.

## Relevant Product Docs

- `docs/product/` — no federated-query or ai doc exists yet; behavior is defined
  here, in `docs/decisions/0010-pluggable-ai-providers.md`, and in
  `src/main/ai/prompt.ts`.
- `docs/stories/epics/E05-ai/US-018-pluggable-ai-providers/` — the provider
  abstraction this rides on.

## Acceptance Criteria

- Opening "Ask AI" in the federated tab with a non-empty editor selection enters
  refine mode: the modal titles itself "Refine selected SQL with AI", shows the
  selected SQL, and its confirm button reads "Apply changes".
- Opening it with no selection is unchanged: "Generate federated SQL with AI",
  confirm reads "Generate", and the result replaces the whole buffer.
- In refine mode the returned SQL replaces only the selected range, dispatched
  through the live `EditorView` so undo history and the cursor survive.
- The model receives the selected SQL under `Existing query to modify (return the
  FULL updated query, not a fragment)` and the ask under `Change requested:`.
- When `baseSql` is absent the federated prompt is byte-for-byte what it is
  today, and the refine block never enters `schemaContext` (it would poison the
  cacheable prefix — see `client.ts`).
- AI-authored SQL that is not a non-mutating statement still raises the existing
  `genWarning` banner, in refine mode as well as generate mode. Nothing auto-runs
  (D1).

## Design Notes

- Commands: none.
- Queries: none.
- API: `AiGenerateFederatedSqlPayload` gains optional `baseSql`. No new IPC
  channel — `AI_GENERATE_FEDERATED_SQL` carries both modes, exactly as
  `AI_GENERATE_SQL` does for the query editor.
- Tables: none.
- Domain rules: refine is selection-scoped. An empty or whitespace-only `baseSql`
  degrades to from-scratch generation rather than emitting an empty block.
- UI surfaces: `FederatedQueryTab` toolbar tooltip, AI modal title / OK text /
  base-SQL preview / textarea placeholder. All mirrored from `QueryEditor`.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | `prompt.test.ts`: federated refine emits the base block + `Change requested`; federated from-scratch emits neither; parts concatenate byte-for-byte and the base block stays out of `schemaContext`. |
| Integration | Covered by unit — the handler only threads `baseSql` through to the prompt builder. |
| E2E | None (no E2E harness in repo). |
| Platform | None. |
| Release | `npm run typecheck`, `npx vitest run`, `npm run build` all exit 0. |

## Harness Delta

`npm run lint` remains declared but uninstalled (see
`history/learnings/critical-patterns.md`); the proof bar is typecheck + test +
build, as with US-020 and US-021.

ID correction: US-020's evidence text reserves US-024 for LinkedQueryTab
troubleshoot. US-024 was free in `harness-cli query matrix` and is taken here.
LinkedQueryTab troubleshoot becomes **US-025**. `harness-cli story update`
exposes no `--notes`, so US-020's stale clause is corrected in
`.khuym/state.json` planning notes rather than by rewriting its whole evidence
string.
