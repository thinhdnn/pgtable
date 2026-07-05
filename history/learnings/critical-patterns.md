# Critical Patterns

High-signal reusable lessons promoted from feature-level learnings. Each entry
here must save future agents meaningful time on more than one future feature.
When in doubt, keep it out — noise here dilutes value.

---

## [20260701] Provider SDK in Electron Main via `externalizeDepsPlugin`
**Category:** pattern
**Feature:** ai-sql-generation
**Tags:** [electron, main-process, provider-sdk]

When adding any external hosted-service SDK to this Electron app (LLM,
storage, auth, telemetry): put the client in `src/main/<domain>/client.ts`,
never import it from the renderer, do not modify `electron.vite.config.ts`
unless the SDK has native addons (the existing `externalizeDepsPlugin()` in
the main target already resolves Node modules at runtime), and expose one
narrow IPC channel `<domain>:<verb>`. Reference: `src/main/ai/client.ts` +
`decision 0008`.

**Full entry:** history/learnings/20260701-ai-sql-generation.md

---

## [20260701] Never Return Raw Secrets Over IPC
**Category:** pattern
**Feature:** ai-sql-generation
**Tags:** [security, ipc, secrets]

For any handler backed by a stored secret, split into `<domain>:has-key` and
`<domain>:set-key`. Never a `<domain>:get-key`. The renderer only learns
*whether* a secret is configured, not its value. The Settings UI shows a
masked placeholder and treats "leave blank" as "keep the existing value".
Even inside the same Electron process, sending secrets over IPC turns them
into serialisable payloads that logs, devtools, and future refactors can
leak. Reference: `src/main/ipc/ai-handlers.ts` `SETTINGS_GET/SET`.

**Full entry:** history/learnings/20260701-ai-sql-generation.md

---

## [20260701] Proof Bar Must Match Actually-Installed Tooling
**Category:** failure
**Feature:** ai-sql-generation
**Tags:** [tooling, proof-bar, validating]

Before locking a proof bar in `validation.md`, run every command it names
once against a clean tree. `npm run lint` was in the proof bar the whole
feature but `eslint` was never installed — the gate looked satisfied
because nobody executed the script. If a proof-bar command fails to find
its binary, either land the tooling in the same feature or shrink the bar
to what runs. Never promise a check the repo can't perform.

**Full entry:** history/learnings/20260701-ai-sql-generation.md
