import { useCallback, useRef, useState } from 'react'
import type { IpcChannel } from '@shared/ipc-channels'
import type { AiGenerateSqlResult } from '@shared/types'
import { invoke } from '../api'

export interface UseAiGenerateConfig<TPayload> {
  // IPC channel that generates SQL, e.g. AI_GENERATE_SQL or AI_GENERATE_FEDERATED_SQL.
  channel: IpcChannel
  // Build the IPC payload from the trimmed request. Return `null` to abort — the
  // callback is expected to have surfaced its own error first (e.g. "attach a
  // database"). Kept in the caller so it can read live state (schema, attachments).
  buildPayload: (request: string) => TPayload | null
  // Place the generated SQL (into the editor, clear results, flag non-SELECT…).
  onResult: (sql: string) => void
  // Error surface. Kept in the caller because QueryEditor shares one error banner
  // across several AI features (generate / check / suggest); the hook only writes
  // to it at the orchestration points below.
  setError: (message: string | null) => void
  // Optional: the API key is missing. `close` shuts the AI modal; callers use it
  // to close and route to Settings.
  onNoApiKey?: (helpers: { close: () => void }) => void
}

export interface UseAiGenerate {
  // AI request modal open state.
  open: boolean
  setOpen: (v: boolean) => void
  request: string
  setRequest: (v: string) => void
  loading: boolean
  // Validates the request, builds the payload, runs the IPC call, and handles the
  // NO_API_KEY branch / errors — closing the modal only on success.
  submit: () => void
}

// Shared "Ask AI → SQL" orchestration for the Query and Federated tabs: owns the
// request modal state (open / request text / loading) and the generate call flow
// (guard, NO_API_KEY friendly message, close-on-success). Everything tab-specific
// — the payload, where the SQL lands, and the error surface — is delegated to the
// caller via config, so QueryEditor keeps its selection-refine + non-SELECT
// warning and Federated its attachment pre-check.
export function useAiGenerate<TPayload>(config: UseAiGenerateConfig<TPayload>): UseAiGenerate {
  const { channel } = config
  const [open, setOpen] = useState(false)
  const [request, setRequest] = useState('')
  const [loading, setLoading] = useState(false)

  // Config callbacks close over live caller state, so read the latest via a ref
  // to keep `submit` stable.
  const cfgRef = useRef(config)
  cfgRef.current = config

  const submit = useCallback(() => {
    void (async () => {
      const trimmed = request.trim()
      if (!trimmed || loading) return
      const payload = cfgRef.current.buildPayload(trimmed)
      if (payload === null) return
      cfgRef.current.setError(null)
      setLoading(true)
      try {
        const res = await invoke<AiGenerateSqlResult | { error: string }>(channel, payload)
        if ('error' in res) {
          if (res.error === 'NO_API_KEY') {
            cfgRef.current.setError('No AI provider configured. Add an API key in Settings.')
            cfgRef.current.onNoApiKey?.({ close: () => setOpen(false) })
          } else {
            cfgRef.current.setError(res.error)
          }
          return
        }
        cfgRef.current.onResult(res.sql)
        setOpen(false)
      } catch (err) {
        cfgRef.current.setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    })()
  }, [request, loading, channel])

  return { open, setOpen, request, setRequest, loading, submit }
}
