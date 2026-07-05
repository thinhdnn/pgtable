---
date: 2026-07-01
feature: ai-sql-generation
categories: [pattern, decision, failure]
severity: standard
tags: [electron, main-process, anthropic, ipc, secrets, tooling, khuym]
---

# Learning: AI SQL Generation — Patterns, Decisions, Gaps

## Overview

Feature added natural-language → PostgreSQL generation to the Electron pgtable
app using the Anthropic Claude API, plus FK-aware prompting, a plaintext local
API-key store, D6 non-SELECT warning, and two follow-ups (US-011 ILIKE guidance,
US-012 pg_trgm did-you-mean).

Reviewing ran in degraded "Reviewing-Lite" mode because the repo has no `.git`
and no beads-cli / `.beads/` directory. Findings recorded in
`history/ai-sql-generation/review.md` instead of review beads.

---

## Pattern — Provider SDK in Electron main via `externalizeDepsPlugin`

**Category:** pattern
**Severity:** critical
**Tags:** [electron, main-process, provider-sdk]
**Applicable-when:** Adding any external hosted-service SDK to an Electron app.

### What Happened

`@anthropic-ai/sdk` was added to `src/main/ai/client.ts` and worked with zero
bundler ceremony. `electron.vite.config.ts` already runs `externalizeDepsPlugin()`
for the main target, which keeps Node modules (`pg`, `electron-store`, `uuid`,
now `@anthropic-ai/sdk`) external at build time and lets them resolve at runtime.

### Root Cause / Key Insight

Provider SDKs are pure Node packages. If the main-process build already
externalises Node deps, adding a new provider is *just* `npm i` + `import`. No
custom Vite config, no polyfills, no worker plumbing.

### Recommendation for Future Work

When adding a new external provider SDK (LLM, storage, auth, telemetry): (1) put
the client in `src/main/<domain>/client.ts`, (2) never import it from the
renderer, (3) do not touch `electron.vite.config.ts` unless the SDK has native
addons, (4) expose a single IPC channel `<domain>:<verb>` that returns the
narrowest useful shape.

---

## Pattern — Never Return Raw Secrets Over IPC

**Category:** pattern
**Severity:** critical
**Tags:** [security, ipc, secrets]
**Applicable-when:** Any settings screen or handler exposing a stored secret.

### What Happened

`SETTINGS_GET` returns only `{ hasApiKey: boolean }`. The raw Claude API key is
read in main by `getApiKey()` right before the SDK call and never crosses the
IPC bridge. The `SettingsModal` shows a masked "•••• (a key is already saved)"
placeholder instead of the actual value; user must retype to change.

### Root Cause / Key Insight

Even in an Electron app where main and renderer are same-process, IPC calls
turn secrets into serialisable payloads that can be logged, captured by
devtools, or leaked by future refactors. Never exposing the raw value
eliminates a whole class of accidental leaks.

### Recommendation for Future Work

For every secret-holding handler: split into `<domain>:has-key`, `<domain>:set-key`,
and never a `<domain>:get-key`. Renderer only learns *whether* a secret is
configured. Update the settings UI to accept a new value or leave blank to keep
the existing one.

---

## Decision — Plaintext Key Storage Deferred (D5, decision 0008)

**Category:** decision
**Severity:** standard
**Tags:** [security, deferred-debt, encryption]
**Applicable-when:** Considering encrypting secrets at rest in pgtable.

### What Happened

The Claude API key sits in `electron-store` (`pgtable-settings.json`) in plaintext.
Decision 0008 accepted this to match the existing plaintext connection-password
posture (`pgtable-mvp` D3). Encryption was explicitly deferred.

### Root Cause / Key Insight

Piecemeal encryption creates inconsistent posture. The two secret classes
(connection passwords, API keys) should move together to `safeStorage` /
OS keychain in one dedicated decision.

### Recommendation for Future Work

When any future work touches secret storage, bundle *all* current plaintext
secrets into the same encryption migration. Do not encrypt one and leave the
other. Reference decisions 0008 (API key) and pgtable-mvp D3 (connection
passwords) when opening that follow-up.

---

## Failure — `npm run lint` Was Never Runnable

**Category:** failure
**Severity:** critical
**Tags:** [tooling, proof-bar, ci]
**Applicable-when:** Setting the proof bar for any feature in this repo.

### What Happened

`package.json` line 15 declares `"lint": "eslint src --ext .ts,.tsx"`, but
`eslint` is not a `dependency`, not a `devDependency`, and not installed under
`node_modules`. Every attempt exits with `sh: eslint: command not found`.
Validation.md V3 promised `npm run lint` as part of the per-story proof bar
without ever running it once.

### Root Cause / Key Insight

Planning and validation set proof bars from convention ("all TS projects lint")
rather than from what is actually installed. The gate looked satisfied because
nobody executed the script during the feature.

### Recommendation for Future Work

Before locking a proof bar in `validation.md`, run every command it names once
against a clean tree. If a script fails to find its binary, either land the
tooling in the same feature or shrink the bar to what runs. Never promise a
check the repo can't perform.

---

## Failure — Khuym Bookkeeping Drifted From Reality

**Category:** failure
**Severity:** standard
**Tags:** [khuym, state-drift, tooling]
**Applicable-when:** Bootstrapping any Khuym feature in a repo without beads or git.

### What Happened

`.khuym/state.json` claimed `"active_beads": []`, `"epic_id": ""`, but the
reviewing skill assumed both would exist for `br close`. The pgtable repo has
never had `.git init`'d and never installed beads-cli. Reviewing had to run in
degraded "Reviewing-Lite" mode with findings written to `review.md`.

`scripts/bin/harness-cli query matrix` also reported US-001..006 as
`in_progress/planned` even though those stories shipped in `pgtable-mvp`.

### Root Cause / Key Insight

Khuym skills declare beads and git as dependencies but don't hard-check them at
onboarding. A repo can appear "onboarded" and still be missing the substrate
several skills silently rely on.

### Recommendation for Future Work

At the start of any Khuym feature, explicitly verify: (1) `.git` present and
git installed, (2) `br`/`bv` in PATH, (3) `.beads/` exists. If any is missing,
either bootstrap it (git init, install beads) or plan the feature knowing which
skills will need to run degraded, and note the mode in state.json's `mode`
field ("degraded-no-beads", "degraded-no-git", etc.).

---

## Pattern — Cite CONTEXT.md Decision IDs In Code Comments

**Category:** pattern
**Severity:** standard
**Tags:** [traceability, docs, khuym]
**Applicable-when:** Implementing any Khuym feature after exploring.

### What Happened

Handlers, prompt lines, and even a UI banner cite CONTEXT.md decision IDs by
name: `// D1: returns SQL text only, never executes`, `// scoped per D4`,
`// D5 posture`, `// D6 non-SELECT warning`. Traceability from feature intent
→ implementation is instant.

### Root Cause / Key Insight

Comments that reference stable IDs age better than comments that restate the
"why" in prose. Because CONTEXT.md is the source of truth, a grep for `D4`
across `src/` finds every place the schema-scope decision affects behavior.

### Recommendation for Future Work

When implementing a Khuym feature, prefix any comment that exists *because of
a locked decision* with the D-ID: `// D4 …`. Adopt this as convention.

---

## Meta — Reviewing-Lite Degraded Mode Worked

**Category:** pattern
**Severity:** standard
**Tags:** [khuym, reviewing, degraded]
**Applicable-when:** Running reviewing in any repo without git or beads.

### What Happened

Reviewing-Lite substituted: (a) full source read + artifact verification for
git diff, (b) inline findings in `history/<feature>/review.md` for review
beads, (c) user attest UAT for interactive walkthrough. The gate still closed
cleanly with a clear P1/P2/P3 count and a state-final snapshot.

### Recommendation for Future Work

Document the degraded reviewing pattern above as a first-class Khuym option,
not a workaround. When degraded, always: (1) verify artifacts EXISTS +
SUBSTANTIVE + WIRED via source read, (2) write findings as a table with
severity + file/line evidence into `review.md`, (3) archive
`history/<feature>/state-final.json` capturing the mode + counts.
