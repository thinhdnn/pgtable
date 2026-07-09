# 0010 Pluggable AI providers (Anthropic, OpenAI, OpenAI-compatible)

Date: 2026-07-09

## Status

Accepted

## Context

Decision 0008 committed the app's AI features to Anthropic, and the code took
that literally: `src/main/ai/client.ts` constructed an `Anthropic` client inside
each of its three exported functions, and `settings-store.ts` held a single
`anthropicApiKey`. Users who already pay for OpenAI, or who run a local model
through Ollama / LM Studio / vLLM, had no way to use the AI features at all.

Adding a second provider touches external provider behavior and a stored
credential, so intake puts it in the high-risk lane.

Two properties had to survive the change:

- The raw API key never crosses to the renderer (decision 0008, and the reason
  `SETTINGS_GET` returns a `hasApiKey` boolean rather than the key).
- Anthropic prompt caching keeps working. The schema block is marked with
  `cache_control` so repeated calls against one database reuse it as a cached
  prefix; a naive "just send strings" abstraction would have silently dropped
  that and raised cost on every call.

## Decision

Introduce a provider abstraction with three members: `anthropic`, `openai`, and
`openai-compatible`.

`src/shared/ai-providers.ts` holds the vocabulary (ids, per-provider spec,
`resolveModel`, `checkAiConfig`) and is imported by both sides of the IPC
boundary. It never holds a key.

`src/main/ai/providers.ts` holds the two adapters and the single `callModel`
entry point. `src/main/ai/client.ts` keeps the four task-shaped functions
(generate SQL, review SQL, ask about a row) and now delegates to `callModel`.

Settings stores one config per provider — key, model, base URL — plus which one
is active, so switching back and forth doesn't lose a key. The pre-existing
`anthropicApiKey` migrates into the Anthropic slot once, at startup.

The `openai-compatible` provider is the `openai` SDK pointed at a user-supplied
`baseURL`. It requires a base URL and an explicit model name, and it does *not*
require a key, because local runtimes accept any placeholder.

## Alternatives Considered

1. **One active provider, overwriting the config on switch.** Simplest store,
   but the user re-pastes a key every time they switch. Rejected on ergonomics.
2. **A curated model dropdown with no free text.** Impossible for compatible
   endpoints, where the model name is whatever the server happens to serve. The
   field is a free-text combo box with suggestions instead.
3. **Normalise both SDKs onto a single message shape.** Would have dropped
   Anthropic's `cache_control` marker. Instead the adapter keeps the split
   `UserMessageParts` for Anthropic and concatenates them for OpenAI, which
   caches long prefixes automatically with no parameter.

## Consequences

Positive:

- AI features work against hosted OpenAI and any OpenAI-compatible endpoint,
  including fully local models where no data leaves the machine.
- The provider seam is one function (`callModel`); a fourth provider is an
  adapter, not a refactor.
- A `Test connection` action in Settings proves key + base URL + model together,
  so a typo surfaces there instead of on the user's first Ask AI.

Tradeoffs:

- Prompt caching is Anthropic-only in an explicit sense. OpenAI's automatic
  prefix caching applies but we do not control or measure it.
- `NO_API_KEY` is now a slight misnomer: the renderer uses it as the
  "route to Settings" sentinel for any unconfigured provider, including a
  missing base URL or model. Kept because all three are fixed in one place, and
  renaming it would touch three renderer call sites for no user-visible gain.
- Token caps diverge by provider: hosted OpenAI gets `max_completion_tokens`,
  compatible endpoints get the older `max_tokens` that Ollama and older vLLM
  understand. Covered by `providers.test.ts`.
- Keys remain plaintext at rest (CONTEXT D5), now three of them rather than one.
  Unchanged posture, larger surface.

## Follow-Up

- Encrypt the settings store at rest, retiring the D5 deferral. This decision
  raises the value of doing so.
- Consider surfacing which provider answered in the AI result UI, so a user
  running a small local model can tell why an answer looks weaker.
