# Exec Plan

## Goal

Let the user run pgtable's AI features against Anthropic, hosted OpenAI, or any
OpenAI-compatible endpoint, chosen from Settings.

## Scope

In scope:

- A provider abstraction behind the four existing AI call sites.
- Per-provider settings (API key, model, base URL) with one active provider.
- Migration of the existing single `anthropicApiKey`.
- A `Test connection` action in Settings.
- The `openai` SDK as a main-process dependency.

Out of scope:

- Encrypting the settings store (CONTEXT D5 deferral stands; see decision 0010).
- Streaming responses.
- Per-request or per-tab provider override — one provider is active app-wide.
- Any change to the prompts themselves.

## Risk Classification

Risk flags:

- External systems — a second and third provider SDK, one at a user-supplied URL.
- Audit/security — a stored credential; three now rather than one.
- Existing behavior — all four AI call sites and the Settings screen change.
- Public contracts — the `settings:get` / `settings:set` IPC payloads change shape.

Hard gates:

- External provider behavior. High-risk lane, human confirmation before
  implementation.

## Work Phases

1. Discovery — read the four call sites, the settings store, and the renderer's
   `NO_API_KEY` handling. Done.
2. Design — confirmed with the user: keep all three configs, free-text model with
   suggestions, add Test connection.
3. Validation planning — see `validation.md`.
4. Implementation.
5. Verification.
6. Harness update — decision 0010.

## Stop Conditions

Pause for human confirmation if:

- Product behavior is ambiguous. **Hit, and resolved**: the user chose
  multi-config storage, a suggestions-plus-free-text model field, and a Test
  connection button before any code was written.
- Data migration or deletion risk appears. The legacy key migration is the only
  one; it is additive and idempotent, and never overwrites a newer key.
- Validation requirements need to be weakened.
- Architecture direction changes.
