# AI SQL Generation — Review (Reviewing-Lite)

**Feature slug:** ai-sql-generation
**Date:** 2026-07-01
**Mode:** Reviewing-Lite (no beads, no git — see below)
**Reviewers:** code-quality, architecture, security, test-coverage, learnings-synthesizer
  (all performed inline by the reviewing agent; beads-cli / .beads/ / .git not
  present in this repo, so findings are recorded here instead of as review beads.
  If beads are adopted later, promote each finding below to a `Resolve Review P<N>` bead
  with the same body.)

## Gate Result

**Overall verdict: READY TO CLOSE.** No P1 findings. Two P2 (test coverage + tooling
gap) and four P3 (known debt / cleanup) — none block merge or feature closeout.

## Quality Gates

| Gate | Result | Note |
|---|---|---|
| `npm run typecheck` (node + web) | ✅ PASS | Clean, no output |
| `npm run build` (electron-vite) | ✅ PASS | 3 targets built: main 38 kB, preload 0.3 kB, renderer 3.42 MB |
| `npm run lint` | ⚠️ NOT RUNNABLE | `eslint` binary missing; not a declared dep. Pre-existing repo gap (see F2 below). |

## Artifact Verification

Every artifact promised in CONTEXT.md / approach.md / validation.md verified
against real code:

| Artifact | EXISTS | SUBSTANTIVE | WIRED | Evidence |
|---|---|---|---|---|
| FK query + `SCHEMA_FOREIGN_KEYS` IPC | ✅ | ✅ composite-safe (`unnest WITH ORDINALITY`, `ORDER BY conname, k.ord`) | ✅ registered in `db-handlers.ts:660` | `src/main/ipc/db-handlers.ts:660-706` |
| Settings store (get/set/has) | ✅ | ✅ Raw key never returned across IPC | ✅ `SETTINGS_GET/SET` handlers in `ai-handlers.ts:118-127` | `src/main/db/settings-store.ts` |
| `SettingsModal` UI | ✅ | ✅ Password input, masked placeholder, success alert | ✅ mounted from `TitleBar.tsx:98` and `QueryEditor.tsx:580` | `src/renderer/src/components/settings/SettingsModal.tsx` |
| Claude client (`generateSqlFromClaude`) | ✅ | ✅ Uses `@anthropic-ai/sdk`, fence stripper, hardcoded default model per decision 0008 | ✅ called from `ai-handlers.ts:158` | `src/main/ai/client.ts` |
| Prompt builder (system + user + FK serializer) | ✅ | ✅ Pure functions, arrow-list FK format for composite keys, ILIKE guidance (US-011) | ✅ imported in `ai-handlers.ts:17` | `src/main/ai/prompt.ts` |
| `AI_GENERATE_SQL` IPC | ✅ | ✅ D1 (returns text only, no execution), D4 (schema-scoped fetch), `NO_API_KEY` sentinel, empty-request rejection, empty-schema rejection | ✅ registered in `registerAiHandlers()` and wired in `src/main/index.ts:66` | `src/main/ipc/ai-handlers.ts:130-165` |
| QueryEditor NL input + generate button + schema select | ✅ | ✅ `Input` + schema `Select` (D4) + `Generate` button with loading | ✅ `generate` callback wired to `AI_GENERATE_SQL` | `src/renderer/src/components/query/QueryEditor.tsx:313-345` |
| D6 non-SELECT warning | ✅ | ✅ `isReadOnlyStatement` reuses `stripCommentsAndStrings`, warning `Alert` shown when generated SQL is not read-only | ✅ `genWarning` state set on every generation | `src/renderer/src/components/query/QueryEditor.tsx:113-119, 578-588` |
| Decision record `0008-anthropic-sql-generation.md` | ✅ | ✅ Full context/decision/alternatives/consequences/follow-up | N/A | `docs/decisions/0008-anthropic-sql-generation.md` |
| BONUS: `AI_SUGGEST_VALUES` (US-011/US-012) — did-you-mean via pg_trgm + Dice fallback | ✅ | ✅ Trigram check, Dice fallback when extension absent, capped `LIMIT 10000` scan × 5 candidate tables × 8 terms | ✅ registered + button wired in QueryEditor `fetchSuggestions` | `src/main/ipc/ai-handlers.ts:167-247`, `QueryEditor.tsx:353-380` |

**All 9 promised artifacts pass EXISTS + SUBSTANTIVE + WIRED.**

## Findings

Severity ladder: P1 blocks merge, P2 real gap, P3 debt/cleanup.
No P1 findings.

### F1 — P2 · test-coverage · Pure functions have no automated tests

**Files:** `src/renderer/src/components/query/QueryEditor.tsx` (`stripCommentsAndStrings`,
`isReadOnlyStatement`, `applyAutoLimit`, `extractFilterTerms`);
`src/main/ai/prompt.ts` (`serializeForeignKeys`).

**Why:** These are pure functions with tricky edge cases — dollar-quoted strings,
composite FK grouping, alias-prefixed columns, `FETCH FIRST/NEXT` detection, quoted
literals with `''` escapes. `isReadOnlyStatement` in particular gates the D6 safety
warning; a false negative would allow a destructive statement to run without a warning.
Today the only coverage is manual UAT and the 2026-07-01 spike — no regression net.

**Failure scenario:** A future refactor adds a new comment style or changes the
sanitiser and silently breaks the D6 classifier. Nothing catches it until a user runs
a destructive AI-generated statement without the warning.

**Proposed fix:** When a test runner is introduced (validation V3 flagged this as
conditional), add unit tests for each pure function above. Not blocking now because
V3 explicitly accepted UAT as the proof bar in the absence of a runner.

### F2 — P2 · tooling · `npm run lint` is not runnable

**File:** `package.json` line 15 (`"lint": "eslint src --ext .ts,.tsx"`).

**Why:** The script exists and `validation.md` V3 lists lint as part of the per-story
proof bar, but `eslint` is neither a `dependency` nor a `devDependency` and is not
installed under `node_modules`. Every attempt exits with `sh: eslint: command not found`.
This is a **pre-existing repo gap**, not introduced by this feature — but it invalidates
one of the three proof-bar checks validation promised.

**Failure scenario:** Anyone (agent or human) trusting `npm run lint` as a gate
gets a silent pass because the script exits non-zero only via `sh` — CI would need
to opt in. Style regressions land unchecked.

**Proposed fix:** Either (a) add `eslint` + a config as devDependencies and land a
minimal `.eslintrc`, or (b) remove the `lint` script and update `validation.md` /
`docs/TEST_MATRIX.md` proof bar to reflect reality. Recommend (a).

### F3 — P3 · security · Claude API key stored plaintext (known debt, D5)

**File:** `src/main/db/settings-store.ts`, `docs/decisions/0008-anthropic-sql-generation.md`
"Consequences / Tradeoffs".

**Why:** The key sits in electron-store JSON in plaintext. This is **explicitly
accepted** in CONTEXT D5 and decision 0008 as consistent with the existing plaintext
connection-password posture (`pgtable-mvp` D3). Recording here so it isn't
lost when compounding synthesises learnings.

**Proposed fix:** Bundle with the future connection-password encryption work; use
Electron `safeStorage` or OS keychain. Do not fix piecemeal.

### F4 — P3 · cost · `AI_GENERATE_SQL` has no client-side throttling

**File:** `src/renderer/src/components/query/QueryEditor.tsx:313-345`.

**Why:** The Generate button re-enables as soon as `aiLoading` flips false. Nothing
prevents a user from clicking it 20 times in a row and running up Anthropic cost.
Not a security issue (user's own key/money), just a UX/cost guard.

**Proposed fix:** Add a short cooldown or debounce (e.g. 1 s) after each generate,
or disable while `aiRequest` text is unchanged since the last successful generation.
Defer unless real usage shows it's needed.

### F5 — P3 · robustness · Fence stripping only handles ``` and ```sql

**File:** `src/main/ai/client.ts:9-13`.

**Why:** `stripFences` matches ``` or ```sql. If Claude ever wraps output in
```postgres or ```psql (rare but observed with other providers), the fence stays.
`isReadOnlyStatement` and `applyAutoLimit` both sanitise input, so a stray fence
means the D6 classifier likely trips warning=true (which is safe) but the query
also won't parse. Minor.

**Proposed fix:** Loosen regex to `^```[a-z]*\n?([\s\S]*?)```$/i`. One-line change.

### F6 — P3 · cleanup · `.khuym/state.json` and harness bookkeeping lag reality

**Files:** `.khuym/state.json`, `scripts/bin/harness-cli query matrix` output.

**Why:** state.json still shows `"active_beads": []`, `"epic_id": ""` and this
feature was executed without ever using beads/epics — the ai-sql-generation work
was tracked through `history/<feature>/*.md` files, not the Khuym beads-cli chain.
The harness `query matrix` also shows US-001..006 as `in_progress/planned` even
though those tickets shipped in `pgtable-mvp`. This is drift, not a bug, but future
onboarding gets confused.

**Proposed fix:** During compounding, either (a) install beads-cli + git and
retroactively record the feature as a closed epic, or (b) delete/update the bead/epic
fields in state.json to reflect the file-based tracking model this repo actually
uses. Recommend (b) as the honest reflection.

## Recommendations for `khuym:compounding`

Candidates to promote to `history/learnings/critical-patterns.md`:

1. **Main-process-only provider SDK pattern worked cleanly.** Electron-vite
   `externalizeDepsPlugin()` in `main` handled `@anthropic-ai/sdk` with zero
   bundler ceremony (same path as `pg`, `electron-store`). Reuse for future
   provider integrations. Reference: decision 0007.
2. **Never return raw secrets across IPC.** `SETTINGS_GET` returns `{ hasApiKey }`
   only. Cheap pattern, worth codifying.
3. **Repo has no test runner today.** Validation gate must not silently promise
   `npm run lint` or unit tests as proof when the tooling isn't installed.
   Either land the tooling or shrink the proof bar to what actually runs.
4. **CONTEXT.md D-IDs stay stable through execution.** All handlers, prompt lines,
   and comments cite D1/D4/D5/D6 by name — traceability is excellent and worth
   keeping as a convention.

## UAT

Walkthrough conducted 2026-07-01. User attested that AI SQL generation had
already been exercised in prior sessions and all functionality is working as
expected — recorded as **all-pass** on U1–U7 (D1 display-only, D4 schema-scoped,
D5 key persist, D6 non-SELECT warning, US-011 ILIKE fuzzy matching, US-012
did-you-mean suggestions, no regression on the table viewer).

| # | Deliverable | Result |
|---|---|---|
| U1 | D1 — Generate & display, never auto-execute | PASS (user attest) |
| U2 | D4 — Only selected schema sent to Claude | PASS (user attest) |
| U3 | D5 — Settings modal + key persist | PASS (user attest) |
| U4 | D6 — Non-SELECT warning banner | PASS (user attest) |
| U5 | US-011 — ILIKE fuzzy matching | PASS (user attest) |
| U6 | US-012 — Did-you-mean value suggestions | PASS (user attest) |
| U7 | Regression — Table viewer/explorer intact | PASS (user attest) |

No fail. No skip. UAT gate closed.

## Verdict

Feature closed. No P1. Handoff to `khuym:compounding`.
