# Exec Plan

## Goal

A user whose query just failed in the Query tab can click one icon, read why it
failed, and put a corrected statement into the editor — without the app ever
running SQL on their behalf, and without an AI-authored `DELETE` landing
unwarned.

## Scope

In scope:

- `AI_TROUBLESHOOT_SQL` channel + `AiTroubleshootPayload` / `AiTroubleshootResult`.
- `TROUBLESHOOT_SYSTEM_PROMPT` + `buildTroubleshootUserMessage()` in `prompt.ts`.
- `troubleshootSql()` in `client.ts`, reusing `parseCheckResponse()` verbatim.
- The handler in `ai-handlers.ts`, reusing `resolveTarget()`,
  `fetchSchemaTables()`, `fetchForeignKeys()`.
- `src/shared/sql-statement.ts`: new home for `stripCommentsAndStrings` and a
  **new, distinctly named** `isNonMutatingStatement` warning classifier.
  `isReadOnlyStatement` (the narrow C1 execution guard) stays in `executor.ts`.
  See the corrected section in `design.md`.
- `export` `parseCheckResponse` from `client.ts` so its reuse can be unit-tested
  at all — it is currently module-private.
- `<TroubleshootPanel>` in `components/common/`, built for reuse by S2/S3.
- Troubleshoot icon + panel wired into `QueryEditor`'s error `Alert`.
- `docs/decisions/0012-ai-troubleshoot-sql-channel.md`.

Out of scope:

- `FederatedQueryTab` (S2 / US-023) and `LinkedQueryTab` (S3 / US-024).
- `fetchDatabaseSchema()` — S3 needs it; this story does not.
- Auto-run after apply; multi-turn troubleshooting; capping schema context.

## Risk Classification

Risk flags:

- **External systems** — a new outbound call to a provider SDK.
- **Public contracts** — a new IPC channel and new payload/result types.
- **Existing behavior** — the shipped error `Alert` changes; a duplicated
  function used by `duck-runner.ts` moves.
- **Weak proof** — no component tests exist for `QueryEditor`.
- **Multi-domain** — establishes the contract two other domains will consume.

Hard gates:

- **External provider behavior.** Five flags plus this gate ⇒ high-risk lane, per
  `docs/FEATURE_INTAKE.md`.
- **API shape change** ⇒ a durable decision record is required before
  implementation (`0012`; verified as the next free integer — `0011` is the
  highest, though `0006-*` and `0007-*` each appear twice).

## Work Phases

1. **Discovery.** Done — `history/troubleshoot-sql-error/discovery.md`.
2. **Design.** Done — `design.md` in this folder.
3. **Validation planning.** Done — `validation.md` in this folder.
4. **Feasibility proof.** `khuym:validating` must prove V1 (below) with a live
   provider call before any bead is created.
5. **Implementation.** Shared extraction first (it is the safety prerequisite),
   then main-side contract, then the renderer surface.
6. **Verification.** Proof bar green + manual UAT against a real failing query.
7. **Harness update.** `harness-cli story update` with evidence;
   `harness-cli decision add` for 0012.

Implementation order is not negotiable:

1. `src/shared/sql-statement.ts` (+ `sql-statement.test.ts`); `executor.ts` and
   `QueryEditor.tsx` re-import `stripCommentsAndStrings`; `QueryEditor`'s private
   `isReadOnlyStatement` becomes `isNonMutatingStatement` from `@shared`.
   `executor.ts`'s `isReadOnlyStatement` is left alone.
2. `src/shared/types.ts`, `src/shared/ipc-channels.ts`.
3. `src/main/ai/prompt.ts`, `src/main/ai/client.ts` (incl. exporting
   `parseCheckResponse`) + `src/main/ai/client.test.ts`.
4. `src/main/ipc/ai-handlers.ts`.
5. `src/renderer/src/components/common/TroubleshootPanel.tsx`.
6. `src/renderer/src/components/query/QueryEditor.tsx`.

Step 1 lands before step 6 because the Apply button must never exist on a surface
that cannot warn about a non-`SELECT` statement.

After step 1, `npm run test` must still show `isReadOnlyStatement('TABLE t')`
returning **false** (guard) and `isNonMutatingStatement('TABLE t')` returning
**true** (classifier). If one suite was "fixed" to agree with the other, the
extraction has silently changed behavior — stop.

## Stop Conditions

Pause for human confirmation if:

- **V1 fails**: a live provider returns unparseable prose when the user message
  carries a raw multi-line Postgres error. The prompt strategy, and possibly the
  structured-result decision, must be reconsidered. Return to `khuym:planning`.
- Moving `stripCommentsAndStrings` out of `executor.ts` perturbs `duck-runner.ts`
  or the federated read-only guard in any way beyond an import path change.
- Anyone proposes collapsing `isReadOnlyStatement` and `isNonMutatingStatement`
  into one function. They have different accept surfaces on purpose.
- The model's `fixedSql` for a failed `SELECT` comes back as a non-`SELECT`
  statement often enough that a warning is not sufficient mitigation.
- Product behavior turns out ambiguous against D1-D4.
- Validation requirements need to be weakened for any reason.
