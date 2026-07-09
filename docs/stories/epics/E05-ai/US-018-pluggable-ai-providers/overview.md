# Overview

## Current Behavior

Every AI feature calls Anthropic. `src/main/ai/client.ts` builds an `Anthropic`
client inside each exported function, and Settings holds one field, a Claude API
key. A user with an OpenAI subscription, or a local model behind Ollama, cannot
use AI SQL generation, AI review, or Ask-about-row at all.

## Target Behavior

Settings offers three AI providers:

- **Anthropic (Claude)** — the default, unchanged behavior, including the
  `cache_control` prompt caching on the schema block.
- **OpenAI** — hosted, key + optional model.
- **OpenAI-compatible endpoint** — any base URL serving the OpenAI chat
  completions API: Ollama, LM Studio, vLLM, OpenRouter. Key is optional because
  local runtimes accept any placeholder; base URL and model are required.

Each provider keeps its own key, model, and base URL, so switching back does not
lose a key. One radio picks the active provider, and every AI call in the app
uses it. A `Test connection` button does one tiny round trip so a wrong base URL
or model name surfaces in Settings rather than on the first Ask AI.

A key saved by an older build is carried into the Anthropic slot at startup; that
user sees no change.

## Affected Users

- Anyone using AI SQL generation, AI review, or Ask-about-row.
- Specifically: users who pay for OpenAI rather than Anthropic, and users who
  must keep schema and row data on-device by pointing at a local model.

## Affected Product Docs

- `docs/decisions/0008-anthropic-sql-generation.md` — narrowed, not superseded:
  Anthropic remains the default and its prompt-caching design is preserved.
- `docs/decisions/0010-pluggable-ai-providers.md` — this change.

## Non-Goals

- Encrypting keys at rest. Unchanged from CONTEXT D5, though decision 0010 notes
  the case for it is now stronger.
- Streaming, tool use, or per-request provider selection.
- Rewriting the prompts per provider. The same system prompt goes to all three;
  a weaker local model simply gives weaker answers.
