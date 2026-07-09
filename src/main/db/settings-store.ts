import Store from 'electron-store'
import {
  AI_PROVIDERS,
  DEFAULT_PROVIDER,
  isAiProviderId,
  type AiProviderConfig,
  type AiProviderId,
  type AiProviderStatus
} from '@shared/ai-providers'

// Local app settings: which AI provider is active, and one saved config per
// provider so switching back and forth doesn't lose a key. Plaintext at rest for
// now (CONTEXT D5), consistent with the existing plaintext connection-password
// deferral. Kept in its own store file so secrets stay separate from the
// connection list.
interface SettingsSchema {
  activeAiProvider: AiProviderId
  aiProviders: Record<AiProviderId, AiProviderConfig>
  /** Legacy single-key field, read once by migrateLegacyKey() then cleared. */
  anthropicApiKey?: string
}

function emptyConfig(): AiProviderConfig {
  return { apiKey: '', model: '', baseUrl: '' }
}

function emptyProviders(): Record<AiProviderId, AiProviderConfig> {
  return Object.fromEntries(AI_PROVIDERS.map((p) => [p, emptyConfig()])) as Record<
    AiProviderId,
    AiProviderConfig
  >
}

const store = new Store<SettingsSchema>({
  name: 'pgtable-settings',
  defaults: {
    activeAiProvider: DEFAULT_PROVIDER,
    aiProviders: emptyProviders()
  }
})

/**
 * Carry a key saved by the pre-multi-provider build into the Anthropic slot.
 * Idempotent: the legacy field is deleted once copied, and an existing Anthropic
 * key always wins so a re-run can't clobber a newer one. Called once at startup.
 */
export function migrateLegacyKey(): void {
  const legacy = store.get('anthropicApiKey')
  if (!legacy) return
  const providers = readProviders()
  if (!providers.anthropic.apiKey) {
    providers.anthropic = { ...providers.anthropic, apiKey: legacy }
    store.set('aiProviders', providers)
  }
  store.delete('anthropicApiKey')
}

// electron-store merges `defaults` only for absent top-level keys, so a store
// written by an older build can hold a partial `aiProviders` map. Fill the gaps
// on read rather than trusting the shape.
function readProviders(): Record<AiProviderId, AiProviderConfig> {
  const saved = store.get('aiProviders') ?? {}
  const out = emptyProviders()
  for (const p of AI_PROVIDERS) {
    out[p] = { ...out[p], ...(saved[p] ?? {}) }
  }
  return out
}

export function getActiveProvider(): AiProviderId {
  const saved = store.get('activeAiProvider')
  return isAiProviderId(saved) ? saved : DEFAULT_PROVIDER
}

export function getProviderConfig(provider: AiProviderId): AiProviderConfig {
  return readProviders()[provider]
}

/** The active provider's id + config, as the AI call sites need it. */
export function getActiveAiConfig(): { provider: AiProviderId; config: AiProviderConfig } {
  const provider = getActiveProvider()
  return { provider, config: getProviderConfig(provider) }
}

/**
 * Persist one provider's settings. An absent `apiKey` keeps the stored one —
 * the renderer never receives the raw key, so it sends the field blank unless
 * the user is deliberately replacing it. An explicit empty string clears it.
 */
export function setProviderConfig(
  provider: AiProviderId,
  patch: Partial<AiProviderConfig>
): void {
  const providers = readProviders()
  const current = providers[provider]
  providers[provider] = {
    apiKey: patch.apiKey === undefined ? current.apiKey : patch.apiKey.trim(),
    model: patch.model === undefined ? current.model : patch.model.trim(),
    baseUrl: patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl.trim()
  }
  store.set('aiProviders', providers)
}

export function setActiveProvider(provider: AiProviderId): void {
  store.set('activeAiProvider', provider)
}

/** Everything the renderer may know: never a raw key, only whether one is set. */
export function getSettingsStatus(): {
  activeProvider: AiProviderId
  providers: Record<AiProviderId, AiProviderStatus>
} {
  const providers = readProviders()
  const status = Object.fromEntries(
    AI_PROVIDERS.map((p) => [
      p,
      { hasApiKey: providers[p].apiKey.length > 0, model: providers[p].model, baseUrl: providers[p].baseUrl }
    ])
  ) as Record<AiProviderId, AiProviderStatus>
  return { activeProvider: getActiveProvider(), providers: status }
}
