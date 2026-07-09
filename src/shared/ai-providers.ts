// Shared AI-provider vocabulary: which providers exist, what each needs
// configured, and the model names we suggest. Imported by the main process (to
// dispatch a call) and the renderer (to render Settings). Dependency-free so it
// stays importable on both sides of the IPC boundary. Never holds a key.

export const AI_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'openai-compatible'] as const
export type AiProviderId = (typeof AI_PROVIDERS)[number]

export const DEFAULT_PROVIDER: AiProviderId = 'anthropic'

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value)
}

/** One provider's saved settings. `apiKey` never leaves the main process — the
 * renderer sees `hasApiKey` instead (see AiProviderStatus). */
export interface AiProviderConfig {
  apiKey: string
  /** Model id sent to the provider. Empty means "use the provider's default". */
  model: string
  /** Only meaningful for `openai-compatible`; ignored otherwise. */
  baseUrl: string
}

/** What the renderer is allowed to know about a provider's config. */
export interface AiProviderStatus {
  hasApiKey: boolean
  model: string
  baseUrl: string
}

interface ProviderSpec {
  label: string
  /** Default model when the user leaves the field blank. Empty means the user
   * must name one, because we can't guess what the endpoint serves. */
  defaultModel: string
  /** Suggestions for the model combo-box; the field stays free-text because an
   * endpoint can serve any name it likes, and providers ship new ids faster
   * than we can list them. */
  suggestedModels: string[]
  /** True when the *user* must supply the base URL. Mutually exclusive with
   * `fixedBaseUrl`. */
  requiresBaseUrl: boolean
  /** Set for a provider that speaks the OpenAI API at a known, constant
   * endpoint — the user never types it. */
  fixedBaseUrl?: string
  /** Local runtimes (Ollama, LM Studio) accept any placeholder key, so an empty
   * key must not block a call to a compatible endpoint. */
  requiresApiKey: boolean
  keyPlaceholder: string
  keysUrl?: string
  /** Shown in the Model field when there is no default to name. */
  modelPlaceholder?: string
  /** Replaces the "leave blank to use <default>" hint when there is no default. */
  modelHelp?: string
}

// Model suggestions are a convenience, not a whitelist — the field stays free
// text so a newly released id works the day it ships. Checked 2026-07-09; the
// `defaultModel` of each hosted provider is that provider's own recommendation.
export const AI_PROVIDER_SPECS: Record<AiProviderId, ProviderSpec> = {
  anthropic: {
    // Labels are short: four of them share one radio row.
    label: 'Anthropic',
    // Opus 4.8 stays the default (docs/decisions/0008). Sonnet 5 and Haiku 4.5
    // are the cheaper steps down. Claude Fable 5 is deliberately absent: it is
    // more capable but costs 2x and requires 30-day data retention, so an org
    // on zero-data-retention gets a 400 on every request.
    defaultModel: 'claude-opus-4-8',
    suggestedModels: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
    requiresBaseUrl: false,
    requiresApiKey: true,
    keyPlaceholder: 'sk-ant-...',
    keysUrl: 'https://console.anthropic.com/settings/keys'
  },
  openai: {
    label: 'OpenAI',
    // gpt-5.6 (Sol/Terra/Luna) is limited-preview as of 2026-07-09 and its
    // variant ids aren't published yet — omitted rather than guessed. Preview
    // users can type the id in; the field is free text.
    defaultModel: 'gpt-5.5',
    suggestedModels: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
    requiresBaseUrl: false,
    requiresApiKey: true,
    keyPlaceholder: 'sk-...',
    keysUrl: 'https://platform.openai.com/api-keys'
  },
  openrouter: {
    label: 'OpenRouter',
    // A gateway, not a model vendor: it fronts hundreds of models from many
    // vendors behind the OpenAI chat-completions API. So the base URL is
    // constant and the model is whatever slug the user picks from the catalog —
    // no default and no suggestions we could keep honest.
    defaultModel: '',
    suggestedModels: [],
    requiresBaseUrl: false,
    fixedBaseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    // OpenRouter's docs don't publish a key prefix, so don't imply one.
    keyPlaceholder: 'your OpenRouter API key',
    keysUrl: 'https://openrouter.ai/keys',
    modelPlaceholder: 'provider/model-name',
    modelHelp: 'Required — a model slug from openrouter.ai/models, e.g. vendor/model-name.'
  },
  'openai-compatible': {
    label: 'OpenAI-compatible',
    // No sensible default: the model name is whatever the server serves.
    defaultModel: '',
    suggestedModels: [],
    requiresBaseUrl: true,
    requiresApiKey: false,
    keyPlaceholder: 'optional for local runtimes',
    modelPlaceholder: 'qwen2.5-coder:32b',
    modelHelp: 'Required — whichever model name the endpoint serves.'
  }
}

/** Model actually sent for a provider: the user's choice, else the default. */
export function resolveModel(provider: AiProviderId, config: AiProviderConfig): string {
  const chosen = config.model.trim()
  return chosen || AI_PROVIDER_SPECS[provider].defaultModel
}

/**
 * Base URL the OpenAI SDK should be pointed at, or `undefined` to let it use
 * its own default (hosted OpenAI).
 *
 * Three cases, and conflating them is the easy bug: a gateway pins the endpoint
 * (`fixedBaseUrl`), a compatible endpoint takes the user's (`requiresBaseUrl`),
 * and hosted OpenAI has neither. A saved `baseUrl` on a provider that doesn't
 * ask for one is ignored rather than honoured — otherwise switching a provider
 * could silently redirect its traffic.
 */
export function resolveBaseUrl(
  provider: AiProviderId,
  config: AiProviderConfig
): string | undefined {
  const spec = AI_PROVIDER_SPECS[provider]
  if (spec.fixedBaseUrl) return spec.fixedBaseUrl
  if (spec.requiresBaseUrl) return config.baseUrl.trim() || undefined
  return undefined
}

export type AiConfigProblem =
  | { ok: true }
  | { ok: false; reason: 'NO_API_KEY' | 'NO_BASE_URL' | 'NO_MODEL'; message: string }

/**
 * Whether a provider is configured well enough to call. Kept here (not in the
 * handler) so Settings can grey out Test with the same rule the call path uses.
 *
 * A compatible endpoint needs a base URL and an explicit model but may have no
 * key — Ollama and LM Studio accept any placeholder. The hosted providers need
 * a key and always have a default model.
 */
export function checkAiConfig(
  provider: AiProviderId,
  config: AiProviderConfig
): AiConfigProblem {
  const spec = AI_PROVIDER_SPECS[provider]
  if (spec.requiresApiKey && !config.apiKey.trim()) {
    return { ok: false, reason: 'NO_API_KEY', message: `Add an API key for ${spec.label}.` }
  }
  if (spec.requiresBaseUrl && !config.baseUrl.trim()) {
    return {
      ok: false,
      reason: 'NO_BASE_URL',
      message: 'Add the endpoint base URL (for example http://localhost:11434/v1).'
    }
  }
  if (!resolveModel(provider, config)) {
    return { ok: false, reason: 'NO_MODEL', message: 'Add the model name the endpoint serves.' }
  }
  return { ok: true }
}
