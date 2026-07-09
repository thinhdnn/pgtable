// Provider adapters: turn one (system prompt, user message) pair into text,
// against whichever provider Settings has active. Main process only — every
// function here handles a raw API key.
//
// The two SDKs differ in one way that matters to us: prompt caching. Anthropic
// needs an explicit `cache_control` marker on the schema block, while OpenAI
// caches long prefixes automatically with no parameter. So the split
// `UserMessageParts` becomes two content blocks for Anthropic and one
// concatenated string for OpenAI — the model sees the same text either way.
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import {
  AI_PROVIDER_SPECS,
  checkAiConfig,
  resolveBaseUrl,
  resolveModel,
  type AiProviderConfig,
  type AiProviderId
} from '@shared/ai-providers'
import type { UserMessageParts } from './prompt'

/** The user message is either a plain string or a split prefix/tail. */
export type UserContent = string | UserMessageParts

export interface AiTarget {
  provider: AiProviderId
  config: AiProviderConfig
}

/** Thrown for a target that Settings hasn't configured well enough to call. */
export class AiConfigError extends Error {
  constructor(readonly reason: 'NO_API_KEY' | 'NO_BASE_URL' | 'NO_MODEL', message: string) {
    super(message)
  }
}

function joinParts(input: UserContent): string {
  return typeof input === 'string' ? input : `${input.schemaContext}\n\n${input.request}`
}

function toAnthropicContent(input: UserContent): Anthropic.MessageParam['content'] {
  if (typeof input === 'string') return input
  return [
    { type: 'text', text: input.schemaContext, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: input.request }
  ]
}

async function callAnthropic(
  target: AiTarget,
  systemPrompt: string,
  userMessage: UserContent,
  maxTokens: number
): Promise<string> {
  const client = new Anthropic({ apiKey: target.config.apiKey })
  const res = await client.messages.create({
    model: resolveModel(target.provider, target.config),
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: toAnthropicContent(userMessage) }]
  })
  // Claude 4+ can decline with HTTP 200, `stop_reason: "refusal"` and an empty
  // `content` — not an exception. Without this the caller would silently
  // receive an empty string and drop it into the editor as generated SQL.
  if (res.stop_reason === 'refusal') {
    throw new Error('The model declined this request.')
  }
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

async function callOpenAi(
  target: AiTarget,
  systemPrompt: string,
  userMessage: UserContent,
  maxTokens: number
): Promise<string> {
  const baseURL = resolveBaseUrl(target.provider, target.config)
  const client = new OpenAI({
    // A local runtime accepts any placeholder key but the SDK refuses an empty
    // string, so send a dummy rather than failing before the request goes out.
    apiKey: target.config.apiKey || 'not-needed',
    ...(baseURL ? { baseURL } : {}),
    // OpenRouter attributes requests to an app by this header; harmless
    // elsewhere, so it isn't worth branching on.
    defaultHeaders: { 'X-OpenRouter-Title': 'pgtable' }
  })
  const res = await client.chat.completions.create({
    model: resolveModel(target.provider, target.config),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: joinParts(userMessage) }
    ],
    // Hosted OpenAI deprecated `max_tokens` in favour of `max_completion_tokens`.
    // Everyone else on this path — OpenRouter, Ollama, older vLLM — knows only
    // the old name. Send each the one it actually understands.
    ...(target.provider === 'openai'
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens })
  })
  return res.choices[0]?.message?.content ?? ''
}

/**
 * Send one request to the active provider and return its raw text.
 *
 * Throws `AiConfigError` when the target isn't configured (the handler maps it
 * to the renderer's `NO_API_KEY`-style envelope); lets SDK/network errors
 * propagate. Never logs the key.
 */
export async function callModel(
  target: AiTarget,
  systemPrompt: string,
  userMessage: UserContent,
  maxTokens: number
): Promise<string> {
  const check = checkAiConfig(target.provider, target.config)
  if (!check.ok) throw new AiConfigError(check.reason, check.message)

  return target.provider === 'anthropic'
    ? callAnthropic(target, systemPrompt, userMessage, maxTokens)
    : callOpenAi(target, systemPrompt, userMessage, maxTokens)
}

/**
 * Smallest possible round trip, used by Settings' Test button to prove the key,
 * base URL, and model name all work together before the user relies on them.
 * Returns a message rather than throwing so the renderer can show it verbatim.
 */
export async function testProvider(
  target: AiTarget
): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
  try {
    await callModel(target, 'Reply with the single word: ok', 'ping', 16)
    return { ok: true, model: resolveModel(target.provider, target.config) }
  } catch (err) {
    if (err instanceof AiConfigError) return { ok: false, error: err.message }
    const label = AI_PROVIDER_SPECS[target.provider].label
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `${label} rejected the request: ${detail}` }
  }
}
