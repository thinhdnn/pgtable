import { describe, it, expect } from 'vitest'
import {
  AI_PROVIDERS,
  AI_PROVIDER_SPECS,
  checkAiConfig,
  isAiProviderId,
  resolveBaseUrl,
  resolveModel,
  type AiProviderConfig
} from './ai-providers'

const cfg = (patch: Partial<AiProviderConfig> = {}): AiProviderConfig => ({
  apiKey: '',
  model: '',
  baseUrl: '',
  ...patch
})

describe('isAiProviderId', () => {
  it('accepts every declared provider', () => {
    for (const p of AI_PROVIDERS) expect(isAiProviderId(p)).toBe(true)
  })

  it('rejects anything else', () => {
    // The IPC boundary takes this straight from the renderer, so a bad value
    // must not index into AI_PROVIDER_SPECS.
    expect(isAiProviderId('gemini')).toBe(false)
    expect(isAiProviderId('')).toBe(false)
    expect(isAiProviderId(undefined)).toBe(false)
    expect(isAiProviderId(null)).toBe(false)
    expect(isAiProviderId(3)).toBe(false)
  })
})

describe('resolveModel', () => {
  it('falls back to the provider default when the field is blank', () => {
    expect(resolveModel('anthropic', cfg())).toBe(AI_PROVIDER_SPECS.anthropic.defaultModel)
    expect(resolveModel('openai', cfg())).toBe(AI_PROVIDER_SPECS.openai.defaultModel)
  })

  it('prefers the user-chosen model and trims it', () => {
    // Any id the provider serves, including one newer than our suggestions.
    expect(resolveModel('openai', cfg({ model: '  gpt-5.6-sol  ' }))).toBe('gpt-5.6-sol')
  })

  it('has no default for a compatible endpoint', () => {
    // The model name is whatever the server serves, so there is nothing to guess.
    expect(resolveModel('openai-compatible', cfg())).toBe('')
  })
})

describe('AI_PROVIDER_SPECS', () => {
  // A hosted provider's default is what a blank Model field resolves to, so a
  // default missing from its own suggestion list means the combo box opens on a
  // value it doesn't offer — the symptom of a half-done model refresh.
  it('offers each hosted provider default as a suggestion', () => {
    for (const p of ['anthropic', 'openai'] as const) {
      const spec = AI_PROVIDER_SPECS[p]
      expect(spec.defaultModel).not.toBe('')
      expect(spec.suggestedModels).toContain(spec.defaultModel)
    }
  })

  it('leaves the gateway and the compatible endpoint with no default and no suggestions', () => {
    for (const p of ['openrouter', 'openai-compatible'] as const) {
      expect(AI_PROVIDER_SPECS[p].defaultModel).toBe('')
      expect(AI_PROVIDER_SPECS[p].suggestedModels).toEqual([])
    }
  })

  it('gives every provider without a default a Model placeholder and hint', () => {
    // The Model field falls back to these when there is no default to name; a
    // provider missing them renders an empty placeholder and empty help text.
    for (const p of AI_PROVIDERS) {
      const spec = AI_PROVIDER_SPECS[p]
      if (spec.defaultModel) continue
      expect(spec.modelPlaceholder).toBeTruthy()
      expect(spec.modelHelp).toBeTruthy()
    }
  })

  it('never both pins a base URL and asks the user for one', () => {
    // resolveBaseUrl checks fixedBaseUrl first, so a provider declaring both
    // would silently ignore the field Settings renders for it.
    for (const p of AI_PROVIDERS) {
      const spec = AI_PROVIDER_SPECS[p]
      expect(spec.fixedBaseUrl && spec.requiresBaseUrl).toBeFalsy()
    }
  })
})

describe('resolveBaseUrl', () => {
  it('is undefined for hosted OpenAI — the SDK supplies its own', () => {
    expect(resolveBaseUrl('openai', cfg({ apiKey: 'sk-x' }))).toBeUndefined()
  })

  it('pins OpenRouter to its gateway, ignoring any saved baseUrl', () => {
    // A saved baseUrl left behind by another provider must never redirect a
    // gateway's traffic.
    expect(resolveBaseUrl('openrouter', cfg({ baseUrl: 'http://evil.test/v1' }))).toBe(
      'https://openrouter.ai/api/v1'
    )
  })

  it('uses the user-supplied URL for a compatible endpoint', () => {
    expect(resolveBaseUrl('openai-compatible', cfg({ baseUrl: ' http://localhost:11434/v1 ' }))).toBe(
      'http://localhost:11434/v1'
    )
  })

  it('is undefined for a compatible endpoint with a blank URL', () => {
    // checkAiConfig rejects this first; the guard here keeps a blank string from
    // reaching the SDK as a base URL if that order ever changes.
    expect(resolveBaseUrl('openai-compatible', cfg({ baseUrl: '  ' }))).toBeUndefined()
  })
})

describe('checkAiConfig', () => {
  describe('hosted providers need a key', () => {
    it('rejects a blank key', () => {
      const r = checkAiConfig('anthropic', cfg())
      expect(r.ok).toBe(false)
      expect(r).toMatchObject({ reason: 'NO_API_KEY' })
    })

    it('rejects a whitespace-only key', () => {
      expect(checkAiConfig('openai', cfg({ apiKey: '   ' }))).toMatchObject({
        reason: 'NO_API_KEY'
      })
    })

    it('accepts a key alone — the default model fills the rest', () => {
      expect(checkAiConfig('anthropic', cfg({ apiKey: 'sk-ant-x' }))).toEqual({ ok: true })
      expect(checkAiConfig('openai', cfg({ apiKey: 'sk-x' }))).toEqual({ ok: true })
    })
  })

  describe('OpenRouter needs a key and a model, but no base URL', () => {
    it('accepts a key plus a model slug', () => {
      expect(checkAiConfig('openrouter', cfg({ apiKey: 'k', model: 'vendor/model' }))).toEqual({
        ok: true
      })
    })

    it('rejects a missing model — a gateway has no default to fall back on', () => {
      expect(checkAiConfig('openrouter', cfg({ apiKey: 'k' }))).toMatchObject({
        reason: 'NO_MODEL'
      })
    })

    it('rejects a missing key', () => {
      expect(checkAiConfig('openrouter', cfg({ model: 'vendor/model' }))).toMatchObject({
        reason: 'NO_API_KEY'
      })
    })
  })

  describe('a compatible endpoint needs a base URL and a model, but no key', () => {
    it('accepts no key at all (Ollama, LM Studio)', () => {
      const r = checkAiConfig(
        'openai-compatible',
        cfg({ baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:32b' })
      )
      expect(r).toEqual({ ok: true })
    })

    it('rejects a missing base URL', () => {
      expect(checkAiConfig('openai-compatible', cfg({ model: 'llama3' }))).toMatchObject({
        reason: 'NO_BASE_URL'
      })
    })

    it('rejects a missing model, since there is no default to fall back on', () => {
      expect(
        checkAiConfig('openai-compatible', cfg({ baseUrl: 'http://localhost:11434/v1' }))
      ).toMatchObject({ reason: 'NO_MODEL' })
    })
  })
})
