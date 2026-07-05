import { describe, it, expect } from 'vitest'
import type { Connection } from '@shared/types'
import { buildLibpqConnString } from './connection-string'

function conn(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'c1',
    name: 'Prod DB',
    host: 'localhost',
    port: 5432,
    username: 'app',
    password: 'secret',
    ssl_mode: 'prefer',
    default_database: 'postgres',
    description: '',
    created_at: '',
    updated_at: '',
    ...overrides
  }
}

describe('buildLibpqConnString', () => {
  it('emits quoted keyword/value pairs with the given database', () => {
    const s = buildLibpqConnString(conn(), 'declarations')
    expect(s).toBe(
      "host='localhost' port='5432' dbname='declarations' user='app' password='secret' sslmode='prefer'"
    )
  })

  it('passes ssl_mode through unchanged', () => {
    for (const mode of ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'] as const) {
      expect(buildLibpqConnString(conn({ ssl_mode: mode }), 'db')).toContain(`sslmode='${mode}'`)
    }
  })

  it('escapes single quotes and backslashes in values', () => {
    const s = buildLibpqConnString(conn({ password: "p'a\\ss" }), 'db')
    expect(s).toContain("password='p\\'a\\\\ss'")
  })

  it('quotes empty values so the parser does not swallow the next key', () => {
    const s = buildLibpqConnString(conn({ password: '' }), 'db')
    expect(s).toContain("password='' sslmode=")
  })
})
