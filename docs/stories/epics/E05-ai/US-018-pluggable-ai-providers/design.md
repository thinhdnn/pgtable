# Design

## Domain Model

`AiProviderId` = `anthropic` | `openai` | `openai-compatible`.

`AiProviderConfig` = `{ apiKey, model, baseUrl }`, one per provider.

`AI_PROVIDER_SPECS` describes each provider declaratively: label, default model,
suggested models, whether a base URL is required, whether a key is required, and
where to get one. Two rules read off the spec rather than being hardcoded:

- `resolveModel(provider, config)` — the user's model, else the provider default.
  A compatible endpoint has no default, because the model name is whatever the
  server serves.
- `checkAiConfig(provider, config)` — is this callable? A hosted provider needs a
  key. A compatible endpoint needs a base URL and an explicit model, but not a
  key: Ollama and LM Studio accept any placeholder.

Both live in `src/shared/ai-providers.ts` so Settings greys out `Test connection`
using exactly the rule the call path enforces. That module never holds a key.

## Application Flow

`src/main/ai/providers.ts` owns the seam:

```
callModel(target, systemPrompt, userMessage, maxTokens)
  ├─ checkAiConfig  → throw AiConfigError before any request goes out
  ├─ anthropic      → messages.create, cache_control on the schema block
  └─ openai / -compatible → chat.completions.create, parts concatenated
```

`src/main/ai/client.ts` keeps the task-shaped functions — `generateSql`,
`checkSql`, `askAboutRow` — and now delegates. The four IPC handlers resolve the
active target once through `resolveTarget()`.

The one real divergence is prompt caching. Anthropic needs an explicit
`cache_control` marker on the schema block; OpenAI caches long prefixes
automatically with no parameter. So `UserMessageParts` becomes two content blocks
for Anthropic and one `schemaContext\n\nrequest` string for OpenAI. The model
sees the same text either way — pinned by `providers.test.ts`.

The second divergence is the token cap: hosted OpenAI takes
`max_completion_tokens`, while Ollama and older vLLM only know `max_tokens`. Each
gets the name it understands.

## Interface Contract

| Channel | Before | After |
| --- | --- | --- |
| `settings:get` | `{ hasApiKey }` | `{ activeProvider, providers: Record<id, { hasApiKey, model, baseUrl }> }` |
| `settings:set` | `{ apiKey }` | `{ provider, apiKey?, model?, baseUrl?, setActive? }` → refreshed status |
| `settings:test` | — | `{ provider }` → `{ ok: true, model }` \| `{ ok: false, error }` |

An **absent** `apiKey` on `settings:set` keeps the stored key; an explicit empty
string clears it. This is what lets the renderer send the field blank, which it
must, because it never receives the key to echo back.

`settings:test` tests the **saved** config, so the renderer saves first.
Otherwise a key the user just typed would go untested and a wrong one would
appear to pass.

Errors: any unconfigured provider still returns the `NO_API_KEY` sentinel, which
the renderer already routes to Settings. A missing base URL or model lands there
too — all three are fixed in the same screen. See decision 0010's tradeoffs.

`isAiProviderId()` guards the boundary: `provider` arrives from the renderer and
must never index `AI_PROVIDER_SPECS` unchecked.

## Data Model

`electron-store` file `pgtable-settings`:

```jsonc
{
  "activeAiProvider": "anthropic",
  "aiProviders": {
    "anthropic":         { "apiKey": "…", "model": "", "baseUrl": "" },
    "openai":            { "apiKey": "",  "model": "", "baseUrl": "" },
    "openai-compatible": { "apiKey": "",  "model": "", "baseUrl": "" }
  }
}
```

Migration: `migrateLegacyKey()` runs once at startup, before any handler reads
settings. It copies a legacy `anthropicApiKey` into the Anthropic slot, then
deletes it. Idempotent, and an existing Anthropic key always wins, so a re-run
can never clobber a newer one.

`readProviders()` fills gaps on read: `electron-store` merges `defaults` only for
absent *top-level* keys, so a store written by an older build can hold a partial
`aiProviders` map.

Keys stay plaintext at rest (CONTEXT D5). Three now, not one.

## UI / Platform Impact

`SettingsModal` gains a provider radio, a conditional Base URL field, a free-text
model combo box seeded with per-provider suggestions, and `Test connection`. The
key field still starts blank on every open.

`openai` is added to `dependencies`; `externalizeDepsPlugin()` keeps it out of
the main bundle automatically, same as `@anthropic-ai/sdk`.

## Observability

Unchanged. `debugLogPrompt` still prints the prompt in dev only, never in a
packaged build. No key, base URL, or provider response is ever logged.

## Alternatives Considered

1. One active provider, overwriting on switch — simpler store, worse ergonomics.
2. Curated model dropdown, no free text — impossible for compatible endpoints.
3. A single normalised message shape for both SDKs — would silently drop
   Anthropic's `cache_control` and raise cost on every call.
