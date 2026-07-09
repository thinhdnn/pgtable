# Validation

## Proof Strategy

Two things carry real risk and must be proven, not assumed:

1. **The wire contract we send a compatible endpoint.** Base URL honoured,
   system prompt and user message in the right roles, the token cap under the
   parameter name an older server understands, and a placeholder key when the
   user configured none. Guessed wrong, every one of these fails only against a
   real Ollama box.
2. **The config guards short-circuit before any request leaves the machine.** An
   unconfigured provider must throw, not call out with a half-built request.

Both are covered by a local stand-in HTTP server implementing
`/v1/chat/completions` — no network, no key, no real provider.

Prompt caching on the Anthropic path is *not* covered by a test; it is preserved
structurally (`toAnthropicContent` still emits the `cache_control` block) and
checked by reading. A regression there costs money, not correctness.

## Test Plan

| Layer | Cases |
| --- | --- |
| Unit | `checkAiConfig`: hosted needs a key; compatible needs base URL + model but no key; whitespace-only key rejected. `resolveModel`: default fallback, trimming, no default for compatible. `isAiProviderId`: rejects unknown strings, `null`, numbers. |
| Integration | `callModel` against a local fake endpoint: base URL path, message roles, split parts concatenated to one user message, `max_tokens` not `max_completion_tokens`, `Bearer not-needed` placeholder, configured key forwarded. `testProvider`: ok path, config problem without calling out, provider 404 surfaced as text. |
| E2E | Not automated. Requires a real provider key. |
| Platform | Build check that `openai` is externalized from the main bundle, not inlined. |
| Performance | None. |
| Logs/Audit | Read-through: no key, base URL, or response is logged. `debugLogPrompt` remains dev-only. |

## Fixtures

`src/main/ai/providers.test.ts` starts an `http` server on an ephemeral port that
records every request and replies with a fixed chat-completion body. A
per-test `failWith` makes it return an error status so the failure path is
exercised deterministically.

## Commands

```text
npx vitest run
npm run typecheck
npm run build
```

## Acceptance Evidence

- `npx vitest run` — 103/103 across 11 files. New: `ai-providers.test.ts` (11),
  `providers.test.ts` (12).
- `npm run typecheck` — clean, node and web projects.
- `npm run build` — clean. `out/main/index.js` contains `require("openai")` and
  no inlined SDK internals, confirming the externalize plugin covers it.

Not yet done — **manual UAT against real providers**. The fake endpoint proves
the request shape, not that a real OpenAI or Ollama server accepts it. Before
release, exercise `Test connection` against: a real Anthropic key, a real OpenAI
key, and a local Ollama at `http://localhost:11434/v1`. The legacy-key migration
also wants one manual check against a settings file written by the previous
build.
