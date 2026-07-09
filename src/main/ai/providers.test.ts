import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { callModel, testProvider, AiConfigError } from './providers'

// Exercises the openai-compatible path against a local stand-in for Ollama /
// LM Studio / vLLM. No network, no key, no real provider — the point is to pin
// the wire contract we send: the base URL is honoured, the system prompt and
// user message land in the right roles, and the token cap uses the parameter
// name an older compatible server understands (`max_tokens`, not
// `max_completion_tokens`).

interface CapturedRequest {
  url: string
  authorization?: string
  body: Record<string, unknown>
}

let server: Server
let baseUrl: string
let captured: CapturedRequest[] = []
/** Set per-test to make the fake endpoint fail. */
let failWith: { status: number; message: string } | null = null

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      captured.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body: raw ? JSON.parse(raw) : {}
      })
      if (failWith) {
        res.writeHead(failWith.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: failWith.message } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'local-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'SELECT 1' }, finish_reason: 'stop' }
          ]
        })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  )
})

function reset(): void {
  captured = []
  failWith = null
}

function compatTarget(overrides: Partial<{ apiKey: string; model: string; baseUrl: string }> = {}) {
  return {
    provider: 'openai-compatible' as const,
    config: { apiKey: '', model: 'local-model', baseUrl, ...overrides }
  }
}

describe('callModel — openai-compatible', () => {
  it('reaches the configured base URL and returns the assistant text', async () => {
    reset()
    const text = await callModel(compatTarget(), 'you are a sql writer', 'give me one row', 512)
    expect(text).toBe('SELECT 1')
    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('/v1/chat/completions')
  })

  it('sends the system prompt and user message in their own roles', async () => {
    reset()
    await callModel(compatTarget(), 'SYSTEM TEXT', 'USER TEXT', 512)
    expect(captured[0].body.messages).toEqual([
      { role: 'system', content: 'SYSTEM TEXT' },
      { role: 'user', content: 'USER TEXT' }
    ])
    expect(captured[0].body.model).toBe('local-model')
  })

  it('concatenates split schema/request parts into one user message', async () => {
    reset()
    await callModel(compatTarget(), 'sys', { schemaContext: 'SCHEMA', request: 'REQUEST' }, 512)
    const messages = captured[0].body.messages as { role: string; content: string }[]
    // Anthropic gets these as two cache-marked blocks; OpenAI has no
    // cache_control, so the model must still see the same text as one string.
    expect(messages[1].content).toBe('SCHEMA\n\nREQUEST')
  })

  it('uses max_tokens, which older compatible servers understand', async () => {
    reset()
    await callModel(compatTarget(), 'sys', 'user', 777)
    expect(captured[0].body.max_tokens).toBe(777)
    expect(captured[0].body.max_completion_tokens).toBeUndefined()
  })

  it('sends a placeholder key when none is configured, rather than failing early', async () => {
    reset()
    await callModel(compatTarget({ apiKey: '' }), 'sys', 'user', 16)
    // A local runtime ignores the value, but the SDK refuses to send none.
    expect(captured[0].authorization).toBe('Bearer not-needed')
  })

  it('forwards a configured key', async () => {
    reset()
    await callModel(compatTarget({ apiKey: 'secret-key' }), 'sys', 'user', 16)
    expect(captured[0].authorization).toBe('Bearer secret-key')
  })
})

describe('callModel — config guards', () => {
  it('throws AiConfigError before any request when the base URL is missing', async () => {
    reset()
    await expect(
      callModel(compatTarget({ baseUrl: '' }), 'sys', 'user', 16)
    ).rejects.toBeInstanceOf(AiConfigError)
    expect(captured).toHaveLength(0)
  })

  it('throws AiConfigError before any request when the model is missing', async () => {
    reset()
    await expect(callModel(compatTarget({ model: '' }), 'sys', 'user', 16)).rejects.toMatchObject({
      reason: 'NO_MODEL'
    })
    expect(captured).toHaveLength(0)
  })

  it('throws AiConfigError for a hosted provider with no key, without calling out', async () => {
    reset()
    await expect(
      callModel(
        { provider: 'openai', config: { apiKey: '', model: '', baseUrl: '' } },
        'sys',
        'user',
        16
      )
    ).rejects.toMatchObject({ reason: 'NO_API_KEY' })
  })
})

describe('testProvider', () => {
  it('reports ok with the resolved model on a successful round trip', async () => {
    reset()
    await expect(testProvider(compatTarget())).resolves.toEqual({ ok: true, model: 'local-model' })
  })

  it('reports the config problem instead of calling out', async () => {
    reset()
    const res = await testProvider(compatTarget({ baseUrl: '' }))
    expect(res.ok).toBe(false)
    expect(captured).toHaveLength(0)
  })

  it('surfaces a provider error rather than throwing', async () => {
    reset()
    failWith = { status: 404, message: 'model "local-model" not found' }
    const res = await testProvider(compatTarget())
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('not found')
  })
})
