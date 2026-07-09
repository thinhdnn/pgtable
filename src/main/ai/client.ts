import type { AiCheckSqlResult, AiCheckSeverity, AiTroubleshootResult } from '@shared/types'
import { callModel, type AiTarget, type UserContent } from './providers'

export type { AiTarget, UserContent }
export { AiConfigError } from './providers'

// Strip a ``` / ```sql fence if a model wraps the SQL despite the instruction not
// to. Defensive — and more load-bearing now that non-Claude models can answer,
// since fencing habits differ across providers.
function stripFences(text: string): string {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```(?:sql)?\s*\n?([\s\S]*?)\n?```$/i)
  return (fence ? fence[1] : trimmed).trim()
}

/**
 * Output-token cap for every AI call. `max_tokens` is a ceiling, not a
 * reservation — an answer that ends early costs nothing extra — so there is no
 * reason to keep separate, tighter caps per task. What stops us going higher is
 * the transport, not the price:
 *
 * - Every call on this path is non-streaming (`messages.create` /
 *   `chat.completions.create`). Anthropic's own guidance is that a request
 *   above roughly 16K output tokens risks hitting the SDK's HTTP timeout before
 *   the response completes. The models themselves go to 64K–128K, but only over
 *   a streamed request.
 * - `max_tokens` above a model's own output ceiling is a 400, not a clamp, and
 *   that ceiling varies (Haiku 4.5 caps at 64K where Opus 4.8 reaches 128K).
 *   An OpenAI-compatible server backed by a small local model can reject an
 *   even lower value.
 *
 * 16000 is therefore the real maximum here. Raising it further means switching
 * the adapters to streaming first.
 */
const MAX_OUTPUT_TOKENS = 16000

// Every call below runs in the main process only — the API key never reaches
// the renderer.

export async function generateSql(
  target: AiTarget,
  systemPrompt: string,
  userMessage: UserContent
): Promise<string> {
  // Seed/INSERT scripts (e.g. "insert every scope") easily exceed a single
  // SELECT's length; a low cap truncates the SQL mid-statement.
  const text = await callModel(target, systemPrompt, userMessage, MAX_OUTPUT_TOKENS)
  return stripFences(text)
}

// Free-form answer about one result row. Returns the raw text (fences kept) so
// the renderer can detect and offer to insert an embedded ```sql suggestion.
// Never executes anything.
export async function askAboutRow(
  target: AiTarget,
  systemPrompt: string,
  userMessage: UserContent
): Promise<string> {
  const text = await callModel(target, systemPrompt, userMessage, MAX_OUTPUT_TOKENS)
  return text.trim()
}

const VALID_SEVERITIES: AiCheckSeverity[] = ['error', 'warning', 'info']

// Ask the model to review a query and return a structured result. Never executes
// the SQL.
export async function checkSql(
  target: AiTarget,
  systemPrompt: string,
  userMessage: string
): Promise<AiCheckSqlResult> {
  const text = await callModel(target, systemPrompt, userMessage, MAX_OUTPUT_TOKENS)
  return parseCheckResponse(text)
}

// Ask the model why a statement failed and, when the SQL itself is the cause, for
// a corrected statement. The response shape is identical to a check's, so the
// same defensive parser serves both — including the part that matters most here:
// an empty or missing `fixedSql` survives as `undefined`, which is how the
// renderer knows not to offer an Apply button. Never executes the SQL.
export async function troubleshootSql(
  target: AiTarget,
  systemPrompt: string,
  userMessage: string
): Promise<AiTroubleshootResult> {
  const text = await callModel(target, systemPrompt, userMessage, MAX_OUTPUT_TOKENS)
  return parseCheckResponse(text)
}

// Parse the model's JSON review defensively: it can still wrap the JSON in a
// fence or add stray prose, so we extract the outermost {...} block and coerce
// every field into the AiCheckSqlResult shape rather than trusting it.
//
// Exported for tests. The `fixedSql` coercion below is load-bearing for the
// troubleshoot feature: an empty string, whitespace, or a missing key all become
// `undefined`, never `''`.
export function parseCheckResponse(text: string): AiCheckSqlResult {
  const stripped = stripFences(text)
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  const json = start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(json)
  } catch {
    // Unparseable — surface the raw text as the summary so the user still sees
    // the model's opinion instead of a hard failure.
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
