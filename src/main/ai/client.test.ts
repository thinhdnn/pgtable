import { describe, it, expect } from 'vitest'
import { parseCheckResponse } from './client'

// The troubleshoot feature hides its "Apply suggested fix" button exactly when
// `fixedSql` is undefined. That decision is made here, in the parser, not in the
// renderer — so these tests are the real specification of D4's behaviour for a
// failure the AI cannot fix by rewriting SQL.

describe('parseCheckResponse', () => {
  it('keeps a corrected statement when the model returns one', () => {
    const r = parseCheckResponse(
      JSON.stringify({
        ok: false,
        summary: 'Column "emai" does not exist.',
        issues: [{ severity: 'error', message: 'Typo in column name', suggestion: 'Use email' }],
        fixedSql: 'SELECT id, email FROM users'
      })
    )
    expect(r.ok).toBe(false)
    expect(r.fixedSql).toBe('SELECT id, email FROM users')
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].severity).toBe('error')
  })

  it('drops an EMPTY fixedSql to undefined — this is what hides the Apply button', () => {
    const r = parseCheckResponse(
      JSON.stringify({ ok: false, summary: 'Connection lost.', issues: [], fixedSql: '' })
    )
    expect(r.summary).toBe('Connection lost.')
    expect(r.fixedSql).toBeUndefined()
  })

  it('drops a whitespace-only fixedSql to undefined', () => {
    const r = parseCheckResponse(
      JSON.stringify({ ok: false, summary: 'Timed out.', issues: [], fixedSql: '   \n ' })
    )
    expect(r.fixedSql).toBeUndefined()
  })

  it('leaves fixedSql undefined when the key is absent entirely', () => {
    const r = parseCheckResponse(JSON.stringify({ ok: false, summary: 'Not connected.', issues: [] }))
    expect(r.fixedSql).toBeUndefined()
  })

  it('unwraps a json code fence around the whole response', () => {
    const r = parseCheckResponse(
      '```json\n{"ok":false,"summary":"bad","issues":[],"fixedSql":"SELECT 1"}\n```'
    )
    expect(r.summary).toBe('bad')
    expect(r.fixedSql).toBe('SELECT 1')
  })

  it('unwraps a sql fence nested inside fixedSql', () => {
    const r = parseCheckResponse(
      JSON.stringify({ ok: false, summary: 'x', issues: [], fixedSql: '```sql\nSELECT 1\n```' })
    )
    expect(r.fixedSql).toBe('SELECT 1')
  })

  it('tolerates prose around the JSON object', () => {
    const r = parseCheckResponse('Sure! {"ok":true,"summary":"fine","issues":[]} Hope that helps.')
    expect(r.ok).toBe(true)
    expect(r.summary).toBe('fine')
  })

  it('degrades to a readable summary instead of throwing on unparseable prose', () => {
    const r = parseCheckResponse('I cannot help with that.')
    expect(r.ok).toBe(false)
    expect(r.summary).toBe('I cannot help with that.')
    expect(r.issues).toEqual([])
    expect(r.fixedSql).toBeUndefined()
  })

  it('coerces an unknown severity to info and drops issues with no message', () => {
    const r = parseCheckResponse(
      JSON.stringify({
        ok: false,
        summary: 's',
        issues: [
          { severity: 'catastrophe', message: 'odd severity' },
          { severity: 'error' },
          { message: '   ' },
          null
        ]
      })
    )
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0].severity).toBe('info')
    expect(r.issues[0].message).toBe('odd severity')
  })
})
