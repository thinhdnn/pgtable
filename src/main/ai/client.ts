import Anthropic from '@anthropic-ai/sdk'
import type { AiCheckSqlResult, AiCheckSeverity } from '@shared/types'
import type { UserMessageParts } from './prompt'

// Default model confirmed by the 2026-07-01 spike (docs/decisions/0008).
// Upgraded from claude-sonnet-4-6 to Opus 4.8 for stronger intent-reading on
// ambiguous / DML (insert-and-link) requests where Sonnet misinterpreted the
// task. Sonnet remains a drop-in downgrade for lower cost/latency if needed.
export const DEFAULT_MODEL = 'claude-opus-4-8'

// The user message is either a plain string (no caching) or a split prefix/tail.
// For the split form we mark the schema context with cache_control so repeated
// calls against the same database reuse it as a cached prefix. Prompt caching is
// prefix-match: the schema block only caches when it clears the model's minimum
// cacheable prefix (~2048 tokens for Sonnet 4.6); smaller schemas silently pay
// nothing and behave exactly as before. Concatenated, the two blocks are the
// same content the model saw as one string.
type UserContent = string | UserMessageParts

function toMessageContent(input: UserContent): Anthropic.MessageParam['content'] {
  if (typeof input === 'string') return input
  return [
    { type: 'text', text: input.schemaContext, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: input.request }
  ]
}

// Strip a ``` / ```sql fence if a model wraps the SQL despite the instruction not
// to. Defensive — the spike output was already fence-free.
function stripFences(text: string): string {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```(?:sql)?\s*\n?([\s\S]*?)\n?```$/i)
  return (fence ? fence[1] : trimmed).trim()
}

// Call Claude in the main process only (the API key never reaches the renderer).
export async function generateSqlFromClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: UserContent,
  model: string = DEFAULT_MODEL
): Promise<string> {
  const client = new Anthropic({ apiKey })
  const res = await client.messages.create({
    model,
    // Seed/INSERT scripts (e.g. "insert every scope") easily exceed a single
    // SELECT's length; a low cap truncates the SQL mid-statement. Keep this
    // generous so full multi-row statements come back intact.
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: toMessageContent(userMessage) }]
  })
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return stripFences(text)
}

// Free-form answer about one result row. Main process only (holds the API key).
// Returns the raw text (fences kept) so the renderer can detect and offer to
// insert an embedded ```sql suggestion. Never executes anything.
export async function askAboutRowFromClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: UserContent,
  model: string = DEFAULT_MODEL
): Promise<string> {
  const client = new Anthropic({ apiKey })
  const res = await client.messages.create({
    model,
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: toMessageContent(userMessage) }]
  })
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
}

const VALID_SEVERITIES: AiCheckSeverity[] = ['error', 'warning', 'info']

// Ask Claude to review a query and return a structured result. Main process only
// (the API key never reaches the renderer). Never executes the SQL.
export async function checkSqlWithClaude(
  apiKey: string,
  systemPrompt: string,
  userMessage: string,
  model: string = DEFAULT_MODEL
): Promise<AiCheckSqlResult> {
  const client = new Anthropic({ apiKey })
  const res = await client.messages.create({
    model,
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  })
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return parseCheckResponse(text)
}

// Parse Claude's JSON review defensively: a model can still wrap it in a fence or
// add stray prose, so we extract the outermost {...} block and coerce every field
// into the AiCheckSqlResult shape rather than trusting it.
function parseCheckResponse(text: string): AiCheckSqlResult {
  const stripped = stripFences(text)
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  const json = start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(json)
  } catch {
    // Unparseable — surface the raw text as the summary so the user still sees
    // Claude's opinion instead of a hard failure.
    return {
      ok: false,
      summary: text.trim().slice(0, 300) || 'Could not parse the review.',
      issues: []
    }
  }
  const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : []
  const issues = rawIssues
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .filter((i) => typeof i.message === 'string' && (i.message as string).trim())
    .map((i) => ({
      severity: VALID_SEVERITIES.includes(i.severity as AiCheckSeverity)
        ? (i.severity as AiCheckSeverity)
        : ('info' as AiCheckSeverity),
      message: String(i.message),
      suggestion:
        typeof i.suggestion === 'string' && i.suggestion.trim() ? i.suggestion : undefined
    }))
  const fixedSql =
    typeof parsed.fixedSql === 'string' && parsed.fixedSql.trim()
      ? stripFences(parsed.fixedSql)
      : undefined
  return {
    ok: parsed.ok === true,
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    issues,
    fixedSql
  }
}
