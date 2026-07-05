import Store from 'electron-store'

// Local app settings. Currently just the Claude API key. Plaintext at rest for
// now (CONTEXT D5), consistent with the existing plaintext connection-password
// deferral. Kept in its own store file so secrets stay separate from the
// connection list.
interface SettingsSchema {
  anthropicApiKey: string
}

const store = new Store<SettingsSchema>({
  name: 'pgtable-settings',
  defaults: { anthropicApiKey: '' }
})

export function getApiKey(): string {
  return store.get('anthropicApiKey') ?? ''
}

export function setApiKey(key: string): void {
  store.set('anthropicApiKey', key.trim())
}

// Whether a non-empty key is configured. The renderer only ever learns this
// boolean — never the raw key.
export function hasApiKey(): boolean {
  return getApiKey().length > 0
}
