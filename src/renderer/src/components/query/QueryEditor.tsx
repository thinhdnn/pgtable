import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Typography,
  Alert,
  Tooltip,
  theme,
  Input,
  Select,
  Tag,
  Space,
  message,
  Drawer,
  List,
  Modal,
  Empty,
  Popconfirm
} from 'antd'
import {
  PlayCircleOutlined,
  ThunderboltOutlined,
  BulbOutlined,
  BugOutlined,
  AlignLeftOutlined,
  SaveOutlined,
  FolderOpenOutlined,
  DeleteOutlined,
  SearchOutlined
} from '@ant-design/icons'
import { formatSqlInView } from '../../utils/format-sql'
import { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { acceptCompletion, completionStatus } from '@codemirror/autocomplete'
import type {
  QueryTab,
  QueryRunResult,
  IpcResult,
  AiSuggestValuesResult,
  AiCheckSqlResult,
  AiTroubleshootResult,
  FuzzyValueGroup,
  FuzzyValueQuery,
  SavedScript,
  SavedScriptInput
} from '@shared/types'
import { IPC } from '@shared/ipc-channels'
import { isNonMutatingStatement, stripCommentsAndStrings } from '@shared/sql-statement'
import { invoke } from '../../api'
import { deriveSqlHint } from '../../utils/sql-hints'
import { TroubleshootButton, TroubleshootPanel } from '../common/TroubleshootPanel'
import { type SchemaPayload } from '../../utils/sql-completion'
import { buildSelectSql } from '../../utils/sql-builders'
import { useSavedQueries } from '../../hooks/useSavedQueries'
import { useAiGenerate } from '../../hooks/useAiGenerate'
import { SqlEditor } from '../common/SqlEditor'
import { QueryResultTable } from '../common/QueryResultTable'
import { AskRowModal } from '../common/AskRowModal'
import { SettingsModal } from '../settings/SettingsModal'

const { Text } = Typography

interface Props {
  tab: QueryTab
}

const DEFAULT_SQL = 'SELECT 1 AS hello;'
const AUTO_LIMIT = 500

// Pick the database's "first" table: the first table in the `public` schema if
// any exists, otherwise the first table overall. The introspection payload is
// already ordered by schema then name, so array order gives alphabetical-first
// within each group.
function pickFirstTable(
  tables: Array<{ schema: string; name: string }>
): { schema: string; name: string } | null {
  const pub = tables.find((t) => t.schema === 'public')
  if (pub) return pub
  return tables[0] ?? null
}


// Detects SELECT-style queries with no row cap and appends one. Returns the
// original sql unchanged if it's a write/DDL statement, already has LIMIT, or
// already uses FETCH FIRST/NEXT.
function applyAutoLimit(raw: string, limit: number): { sql: string; appended: boolean } {
  const trimmed = raw.replace(/;\s*$/, '').replace(/\s+$/, '')
  if (!trimmed) return { sql: raw, appended: false }
  const sanitized = stripCommentsAndStrings(trimmed).trim()
  const lead = sanitized.slice(0, 16).toUpperCase()
  const isSelect = /^(SELECT|WITH|TABLE|VALUES)\b/.test(lead)
  if (!isSelect) return { sql: raw, appended: false }
  if (/\blimit\b/i.test(sanitized)) return { sql: raw, appended: false }
  if (/\bfetch\s+(first|next)\b/i.test(sanitized)) return { sql: raw, appended: false }
  return { sql: `${trimmed}\nLIMIT ${limit};`, appended: true }
}


// Pull `column (= | LIKE | ILIKE) 'literal'` filters out of a query so, when it
// returns no rows, we can look up close real values for each. The captured
// column is the identifier right before the operator (alias prefix dropped by the
// regex naturally); the value has wildcards/quote-escapes normalised to a plain
// search term.
function extractFilterTerms(sql: string): FuzzyValueQuery[] {
  const re = /([A-Za-z_][\w$]*)\s*(?:=|I?LIKE)\s*'((?:[^']|'')*)'/gi
  const out: FuzzyValueQuery[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    const column = m[1]
    const raw = `'${m[2]}'`
    const value = m[2]
      .replace(/''/g, "'")
      .replace(/[%_]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!value) continue
    const key = `${column}|${raw}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ column, value, raw })
    if (out.length >= 8) break
  }
  return out
}

export function QueryEditor({ tab }: Props): React.ReactElement {
  const { token } = theme.useToken()
  const [sqlText, setSqlText] = useState(() =>
    tab.initialSql != null
      ? tab.initialSql
      : tab.suggest
        ? buildSelectSql(tab.suggest.schema, tab.suggest.table)
        : DEFAULT_SQL
  )
  const [result, setResult] = useState<QueryRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [limitNote, setLimitNote] = useState<number | null>(null)
  // When true, bare SELECTs get an auto LIMIT (safety net). Defaults off — queries
  // run with no row cap unless the user turns it on from the toolbar.
  const [autoLimit, setAutoLimit] = useState(false)
  // Editor pane height in pixels. Persisted per session so opening another
  // query tab keeps your last-chosen ratio.
  const [editorHeight, setEditorHeight] = useState<number>(() => {
    const stored = Number(sessionStorage.getItem('pg-sql-editor-h'))
    return stored && stored > 0 ? stored : 220
  })
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const [schema, setSchema] = useState<SchemaPayload | null>(null)
  // Guards the first-table seed so it fires at most once per tab, even if
  // introspection re-runs.
  const seededFirstTableRef = useRef(false)

  // AI SQL generation state (CONTEXT D1/D4/D6). aiError is a shared surface across
  // the AI features (generate / check / suggest), so it stays local; the generate
  // modal state + call flow live in the shared useAiGenerate hook (wired below).
  const [aiError, setAiError] = useState<string | null>(null)
  // Set when generated SQL is NOT a read-only SELECT (D6 warning banner).
  const [genWarning, setGenWarning] = useState(false)
  // Refine mode: when the popup is opened with a non-empty editor selection, that
  // SQL becomes the base the AI edits, and `aiSelRef` remembers the range so the
  // result replaces just the selection instead of the whole buffer. Null = a
  // from-scratch generation replacing the buffer.
  const [aiBaseSql, setAiBaseSql] = useState<string | null>(null)
  const aiSelRef = useRef<{ from: number; to: number } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // AI "check SQL" state: reviews the current editor content for errors.
  const [checkLoading, setCheckLoading] = useState(false)
  const [checkResult, setCheckResult] = useState<AiCheckSqlResult | null>(null)
  // AI "troubleshoot" state: explains the error the last run produced. Distinct
  // from check — this one only exists once a run has actually failed.
  const [tsLoading, setTsLoading] = useState(false)
  const [tsResult, setTsResult] = useState<AiTroubleshootResult | null>(null)
  // "Ask AI about this row" popup target (the confirm/send flow lives in the
  // shared AskRowModal). Null row = closed.
  const [askRow, setAskRow] = useState<Record<string, unknown> | null>(null)

  // "Did you mean" value suggestions for a zero-row result.
  const [suggestGroups, setSuggestGroups] = useState<FuzzyValueGroup[] | null>(null)
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestTrigram, setSuggestTrigram] = useState(true)

  // Saved-script library (history/save-sql-script/CONTEXT.md). Global list (D2),
  // flat + searchable (D4), Save/Open/Delete only (D6). State + IPC live in the
  // shared useSavedQueries hook; only openScript (below) stays local since it
  // hydrates this tab's editor buffer.
  const saved = useSavedQueries<SavedScript, SavedScriptInput>({
    channels: { list: IPC.SCRIPT_LIST, save: IPC.SCRIPT_SAVE, delete: IPC.SCRIPT_DELETE },
    noun: 'script',
    buildSaveInput: (name, overwrite) => {
      if (!sqlText.trim()) {
        message.warning('There is no SQL to save.')
        return null
      }
      return { name, sql: sqlText, connectionId: tab.connectionId, overwrite }
    }
  })

  // Schemas available in this database (from introspection), for the AI scope
  // selector. The AI only sees the chosen schema's tables + FKs (D4).
  const schemaOptions = useMemo(() => {
    const set = new Set<string>()
    for (const t of schema?.tables ?? []) set.add(t.schema)
    return [...set].sort()
  }, [schema])
  const [aiSchema, setAiSchema] = useState<string>(tab.suggest?.schema ?? 'public')
  // Once schemas are known, make sure the selection points at a real one.
  useEffect(() => {
    if (schemaOptions.length === 0) return
    setAiSchema((prev) => (schemaOptions.includes(prev) ? prev : schemaOptions[0]))
  }, [schemaOptions])

  // Pull table/column metadata once per (connection, database) and feed it to
  // the SQL language extension so completions know real names. When the tab was
  // opened from a database node, also seed a starter query for the first table
  // once names are known — but never clobber text the user already edited.
  useEffect(() => {
    let cancelled = false
    setSchema(null)
    invoke<SchemaPayload | { error: string }>(IPC.SCHEMA_INTROSPECT, {
      connectionId: tab.connectionId,
      database: tab.database
    }).then((res) => {
      if (cancelled) return
      if (!('tables' in res)) return
      setSchema(res)
      if (tab.suggestFirstTable && !seededFirstTableRef.current) {
        seededFirstTableRef.current = true
        const first = pickFirstTable(res.tables)
        if (first) {
          const seed = buildSelectSql(first.schema, first.name)
          setSqlText((prev) => (prev === DEFAULT_SQL ? seed : prev))
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [tab.connectionId, tab.database, tab.suggestFirstTable])

  // Latest values for the keymap so its handler always sees fresh state.
  const runRef = useRef<() => void>(() => {})

  // Guards against re-entry (double Cmd+Enter, accidental double-click) and a
  // raw rejection from the IPC bridge keeping the spinner stuck on.
  const runningRef = useRef(false)

  const run = useCallback(async () => {
    if (runningRef.current) return
    const view = editorRef.current?.view
    let toRun = sqlText
    if (view) {
      const { from, to } = view.state.selection.main
      if (from !== to) toRun = view.state.sliceDoc(from, to)
    }
    if (!toRun.trim()) return
    // Safety net: stick a LIMIT on bare SELECTs so a user can't accidentally
    // ask Postgres for ten million rows. Only mutates the version we send to
    // the server — the editor buffer stays as the user wrote it.
    const { sql: finalSql, appended } = autoLimit
      ? applyAutoLimit(toRun, AUTO_LIMIT)
      : { sql: toRun, appended: false }
    setLimitNote(appended ? AUTO_LIMIT : null)
    runningRef.current = true
    setRunning(true)
    setError(null)
    setSuggestGroups(null)
    try {
      const res = await invoke<IpcResult<QueryRunResult>>(IPC.QUERY_RUN, {
        connectionId: tab.connectionId,
        database: tab.database,
        sql: finalSql
      })
      if ('error' in res) {
        setError(res.error)
        setResult(null)
      } else {
        setResult(res as unknown as QueryRunResult)
      }
    } catch (err) {
      setError(String(err))
      setResult(null)
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }, [sqlText, tab.connectionId, tab.database, autoLimit])

  useEffect(() => {
    runRef.current = run
  }, [run])

  // Pretty-print the SQL, formatting the selection when there is one. Invalid
  // SQL the formatter can't parse surfaces a soft message rather than throwing.
  const format = useCallback(() => {
    const view = editorRef.current?.view
    if (!view) return
    if (formatSqlInView(view) === 'invalid') {
      message.warning("Couldn't format — the SQL may be incomplete or invalid.")
    }
  }, [])

  // Latest format handler for the keymap (Shift-Alt-F, matching editors' norm).
  const formatRef = useRef<() => void>(() => {})
  useEffect(() => {
    formatRef.current = format
  }, [format])

  // Ask the AI provider to generate SQL from the natural-language request, scoped to the
  // selected schema (D4). Modal state (open/request/loading) + the call flow come
  // from useAiGenerate; the payload, selection-aware placement, and non-SELECT
  // warning (D6) stay here. Generated SQL is placed for review, never auto-run (D1).
  const ai = useAiGenerate<{
    connectionId: string
    database: string
    schema: string
    request: string
    baseSql?: string
  }>({
    channel: IPC.AI_GENERATE_SQL,
    setError: setAiError,
    // NO_API_KEY: close the popup and route to Settings.
    onNoApiKey: ({ close }) => {
      close()
      setSettingsOpen(true)
    },
    buildPayload: (request) => {
      setGenWarning(false)
      return {
        connectionId: tab.connectionId,
        database: tab.database,
        schema: aiSchema,
        request,
        baseSql: aiBaseSql ?? undefined
      }
    },
    onResult: (sql) => {
      // Refine mode replaces only the selected range (dispatched through the live
      // view so undo history stays intact; onChange syncs sqlText). From-scratch
      // mode replaces the whole buffer.
      const sel = aiSelRef.current
      const view = editorRef.current?.view
      if (sel && view) {
        const docLen = view.state.doc.length
        const from = Math.min(sel.from, docLen)
        const to = Math.min(sel.to, docLen)
        view.dispatch({
          changes: { from, to, insert: sql },
          selection: { anchor: from, head: from + sql.length }
        })
      } else {
        setSqlText(sql)
      }
      setResult(null)
      setError(null)
      setGenWarning(!isNonMutatingStatement(sql))
    }
  })

  // Open the AI popup. If the editor has a selection, enter "refine" mode: the
  // selected SQL is shown as context and its range is remembered so the result
  // replaces just that selection. Otherwise it's a from-scratch generation.
  const openAiModal = useCallback(() => {
    setAiError(null)
    ai.setRequest('')
    const view = editorRef.current?.view
    let base: string | null = null
    aiSelRef.current = null
    if (view) {
      const { from, to } = view.state.selection.main
      if (from !== to) {
        base = view.state.sliceDoc(from, to)
        aiSelRef.current = { from, to }
      }
    }
    setAiBaseSql(base)
    ai.setOpen(true)
  }, [ai])

  // Ask the AI provider to review the current editor SQL for errors, scoped to the
  // selected schema (D4). Reports issues and, when there are errors, offers a
  // corrected query for the user to apply — it never runs anything (D1).
  const checkSql = useCallback(async () => {
    const sql = sqlText.trim()
    if (!sql || checkLoading) return
    setCheckLoading(true)
    setAiError(null)
    setCheckResult(null)
    try {
      const res = await invoke<AiCheckSqlResult | { error: string }>(IPC.AI_CHECK_SQL, {
        connectionId: tab.connectionId,
        database: tab.database,
        schema: aiSchema,
        sql
      })
      if ('error' in res) {
        if (res.error === 'NO_API_KEY') {
          setAiError('No AI provider configured. Add an API key in Settings.')
          setSettingsOpen(true)
        } else {
          setAiError(res.error)
        }
        return
      }
      setCheckResult(res)
    } catch (err) {
      setAiError(String(err))
    } finally {
      setCheckLoading(false)
    }
  }, [sqlText, checkLoading, aiSchema, tab.connectionId, tab.database])

  // Put a suggested corrected query into the editor and clear the review.
  const applyFix = useCallback((fixed: string) => {
    setSqlText(fixed)
    setCheckResult(null)
    setResult(null)
    setError(null)
  }, [])

  // Ask the AI provider why the last run failed. Sends the statement, the raw
  // driver error, and the selected schema (D3) — never any row values. Returns a
  // diagnosis and, only when the SQL itself is at fault, a corrected statement.
  const troubleshoot = useCallback(async () => {
    if (!error || tsLoading) return
    setTsLoading(true)
    setAiError(null)
    setTsResult(null)
    try {
      const res = await invoke<AiTroubleshootResult | { error: string }>(IPC.AI_TROUBLESHOOT_SQL, {
        kind: 'query',
        connectionId: tab.connectionId,
        database: tab.database,
        schema: aiSchema,
        sql: sqlText,
        errorMessage: error
      })
      if ('error' in res) {
        if (res.error === 'NO_API_KEY') {
          setAiError('No AI provider configured. Add an API key in Settings.')
          setSettingsOpen(true)
        } else {
          setAiError(res.error)
        }
        return
      }
      setTsResult(res)
    } catch (err) {
      setAiError(String(err))
    } finally {
      setTsLoading(false)
    }
  }, [error, tsLoading, sqlText, aiSchema, tab.connectionId, tab.database])

  // Apply a troubleshoot fix. The statement is AI-authored, so it gets the same
  // non-SELECT warning generated SQL gets (D6) — a "fix" can be a DELETE. It is
  // written to the editor and nothing else: the user presses Run.
  const applyTroubleshootFix = useCallback((fixed: string) => {
    setSqlText(fixed)
    setGenWarning(!isNonMutatingStatement(fixed))
    setTsResult(null)
    setResult(null)
    setError(null)
  }, [])

  // Look up close real values for each filter literal in the current query. Used
  // when a query returns no rows and the value likely just doesn't match how the
  // data is stored. Runs locally — values are never sent to the AI.
  const fetchSuggestions = useCallback(async () => {
    const terms = extractFilterTerms(sqlText)
    if (terms.length === 0 || suggestLoading) return
    setSuggestLoading(true)
    setAiError(null)
    try {
      const res = await invoke<AiSuggestValuesResult | { error: string }>(IPC.AI_SUGGEST_VALUES, {
        connectionId: tab.connectionId,
        database: tab.database,
        schema: aiSchema,
        terms
      })
      if ('error' in res) {
        setAiError(res.error)
        return
      }
      setSuggestGroups(res.groups)
      setSuggestTrigram(res.trigram)
    } catch (err) {
      setAiError(String(err))
    } finally {
      setSuggestLoading(false)
    }
  }, [sqlText, suggestLoading, aiSchema, tab.connectionId, tab.database])

  // Replace a filter literal in the editor with a suggested real value, then
  // clear the suggestions so the user can re-run.
  const applySuggestion = useCallback((raw: string, value: string) => {
    const replacement = `'${value.replace(/'/g, "''")}'`
    setSqlText((prev) => prev.replace(raw, replacement))
    setSuggestGroups(null)
  }, [])

  // Whether the current query has any literal filters we could suggest values for.
  const hasFilterTerms = useMemo(() => extractFilterTerms(sqlText).length > 0, [sqlText])

  // Load a saved script's SQL into the editor, replacing the current buffer (D6).
  const openScript = useCallback(
    (s: SavedScript) => {
      setSqlText(s.sql)
      setResult(null)
      setError(null)
      saved.closeList()
      message.success(`Opened "${s.name}".`)
    },
    [saved]
  )

  // Keymap is added at Prec.highest so Cmd/Ctrl+Enter beats CodeMirror's
  // default Enter binding, and Tab accepts a visible completion before falling
  // back to indenting.
  const keymapExtension = useMemo(
    () => [
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              runRef.current()
              return true
            }
          },
          {
            key: 'Shift-Alt-f',
            run: () => {
              formatRef.current()
              return true
            }
          },
          {
            key: 'Tab',
            run: (view) => {
              if (completionStatus(view.state) === 'active') return acceptCompletion(view)
              return false
            }
          }
        ])
      )
    ],
    []
  )

  const barBorder = `1px solid ${token.colorBorderSecondary}`

  // Drag handler for the editor/results splitter. Pointer events on the
  // splitter element handle capture so the drag survives moving over the
  // CodeMirror surface or the result table.
  const beginResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const handle = e.currentTarget
      handle.setPointerCapture(e.pointerId)
      const container = splitContainerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      const minTop = 80
      const minBottom = 80
      const move = (ev: PointerEvent): void => {
        let next = ev.clientY - rect.top
        if (next < minTop) next = minTop
        if (next > rect.height - minBottom) next = rect.height - minBottom
        setEditorHeight(next)
      }
      const up = (): void => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        handle.removeEventListener('pointercancel', up)
        document.body.style.cursor = ''
        try {
          sessionStorage.setItem('pg-sql-editor-h', String(editorHeight))
        } catch {
          /* sessionStorage can fail in private mode; persistence is best-effort */
        }
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
      document.body.style.cursor = 'row-resize'
    },
    [editorHeight]
  )

  return (
    <div
      ref={splitContainerRef}
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div className="pg-toolbar">
        <Tooltip title="Run (⌘/Ctrl + Enter). Selection runs only the selected text.">
          <Button
            type="primary"
            size="small"
            icon={<PlayCircleOutlined />}
            loading={running}
            onClick={run}
          >
            Run
          </Button>
        </Tooltip>
        <Tooltip title="Format SQL (⇧ + Alt + F). Formats the selection if there is one.">
          <Button
            size="small"
            icon={<AlignLeftOutlined />}
            onClick={format}
            disabled={!sqlText.trim()}
          >
            Format
          </Button>
        </Tooltip>
        <Tooltip title="Save the current SQL as a named script">
          <Button
            size="small"
            icon={<SaveOutlined />}
            onClick={() => {
              saved.setSaveName('')
              saved.setSaveOpen(true)
            }}
            disabled={!sqlText.trim()}
          >
            Save
          </Button>
        </Tooltip>
        <Tooltip title="Open a saved script">
          <Button
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={saved.openList}
          >
            Scripts
          </Button>
        </Tooltip>
        <Tooltip title="Generate SQL from words — or select SQL first to have the AI refine it">
          <Button size="small" icon={<ThunderboltOutlined />} onClick={openAiModal}>
            Ask AI
          </Button>
        </Tooltip>
        <Tooltip title="Check the SQL in the editor for errors with AI (does not run it)">
          <Button
            size="small"
            icon={<BugOutlined />}
            loading={checkLoading}
            onClick={checkSql}
            disabled={!sqlText.trim()}
          >
            Check
          </Button>
        </Tooltip>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {tab.database}
        </Text>
        <Tooltip
          title={
            autoLimit
              ? `Bare SELECTs run with LIMIT ${AUTO_LIMIT}. Click to run with no row cap.`
              : 'Queries run with no row cap. Click to re-enable the auto LIMIT safety net.'
          }
        >
          <Tag
            color={autoLimit ? 'processing' : 'warning'}
            style={{ cursor: 'pointer', userSelect: 'none', margin: 0 }}
            onClick={() => setAutoLimit((v) => !v)}
          >
            {autoLimit ? `Limit ${AUTO_LIMIT}` : 'No limit'}
          </Tag>
        </Tooltip>
        <div className="pg-toolbar-meta">
          {limitNote != null && (
            <Tooltip
              title={`No LIMIT in your query — pgtable auto-appended LIMIT ${limitNote} so you don't load millions of rows. Add an explicit LIMIT to override.`}
            >
              <Text
                type="warning"
                className="tabular"
                style={{ fontSize: 12, cursor: 'help' }}
              >
                + LIMIT {limitNote}
              </Text>
            </Tooltip>
          )}
          {result && (
            <Text type="secondary" className="tabular" style={{ fontSize: 12 }}>
              {result.command || 'OK'} · {result.rowCount} row{result.rowCount === 1 ? '' : 's'} ·{' '}
              {result.durationMs} ms
            </Text>
          )}
        </div>
      </div>

      {aiError && !ai.open && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setAiError(null)}
          message={aiError}
          style={{ margin: '8px 12px 0' }}
        />
      )}
      {genWarning && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => setGenWarning(false)}
          message="This generated statement is not a read-only SELECT"
          description="It may modify or delete data. Review it carefully before you run it."
          style={{ margin: '8px 12px 0' }}
        />
      )}

      {checkResult && (
        <Alert
          type={
            checkResult.ok
              ? 'success'
              : checkResult.issues.some((i) => i.severity === 'error')
                ? 'error'
                : 'warning'
          }
          showIcon
          closable
          onClose={() => setCheckResult(null)}
          message={
            checkResult.summary || (checkResult.ok ? 'No issues found.' : 'Issues found')
          }
          description={
            checkResult.issues.length > 0 || checkResult.fixedSql ? (
              <div>
                {checkResult.issues.length > 0 && (
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {checkResult.issues.map((iss, idx) => (
                      <li key={idx} style={{ marginBottom: 4 }}>
                        <Tag
                          color={
                            iss.severity === 'error'
                              ? 'error'
                              : iss.severity === 'warning'
                                ? 'warning'
                                : 'processing'
                          }
                          style={{ marginRight: 6 }}
                        >
                          {iss.severity}
                        </Tag>
                        {iss.message}
                        {iss.suggestion && (
                          <div style={{ opacity: 0.75, marginTop: 2 }}>→ {iss.suggestion}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {checkResult.fixedSql && (
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    style={{ marginTop: 8 }}
                    onClick={() => applyFix(checkResult.fixedSql as string)}
                  >
                    Apply suggested fix
                  </Button>
                )}
              </div>
            ) : undefined
          }
          style={{ margin: '8px 12px 0' }}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => setAiError(null)}
      />

      <Modal
        title={aiBaseSql != null ? 'Refine selected SQL with AI' : 'Generate SQL with AI'}
        open={ai.open}
        onCancel={() => ai.setOpen(false)}
        onOk={ai.submit}
        okText={aiBaseSql != null ? 'Apply changes' : 'Generate'}
        okButtonProps={{ icon: <ThunderboltOutlined />, disabled: !ai.request.trim() }}
        confirmLoading={ai.loading}
        width={560}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Schema
            </Text>
            <Select
              size="small"
              value={aiSchema}
              onChange={setAiSchema}
              style={{ minWidth: 140 }}
              options={(schemaOptions.length ? schemaOptions : [aiSchema]).map((s) => ({
                value: s,
                label: s
              }))}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              The AI only sees this schema&apos;s tables + foreign keys.
            </Text>
          </div>
          {aiBaseSql != null && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Modifying your selected SQL — the result replaces the selection:
              </Text>
              <pre
                style={{
                  margin: '4px 0 0',
                  padding: 8,
                  maxHeight: 140,
                  overflow: 'auto',
                  fontSize: 12,
                  borderRadius: 6,
                  background: token.colorFillTertiary,
                  border: barBorder,
                  whiteSpace: 'pre-wrap'
                }}
              >
                {aiBaseSql}
              </pre>
            </div>
          )}
          <Input.TextArea
            autoFocus
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder={
              aiBaseSql != null
                ? 'Describe the change — e.g. “only active users”, “add created_at in the last 30 days”, “group by role”. ⌘/Ctrl + Enter to apply.'
                : 'Describe the query in words — e.g. “find users with role Admin”. ⌘/Ctrl + Enter to generate.'
            }
            value={ai.request}
            onChange={(e) => ai.setRequest(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                ai.submit()
              }
            }}
            disabled={ai.loading}
          />
          {aiError && <Alert type="error" showIcon message={aiError} />}
        </div>
      </Modal>

      <AskRowModal
        open={askRow != null}
        onClose={() => setAskRow(null)}
        row={askRow}
        columns={result?.fields ?? []}
        connectionId={tab.connectionId}
        database={tab.database}
        schema={aiSchema}
        onNeedApiKey={() => setSettingsOpen(true)}
        onInsertSql={(sql) => {
          setSqlText(sql)
          setResult(null)
          setError(null)
        }}
      />

      <Modal
        title="Save script"
        open={saved.saveOpen}
        onCancel={() => saved.setSaveOpen(false)}
        onOk={saved.submitSave}
        okText="Save"
        confirmLoading={saved.saving}
        destroyOnClose
      >
        <Input
          autoFocus
          placeholder="Script name"
          value={saved.saveName}
          onChange={(e) => saved.setSaveName(e.target.value)}
          onPressEnter={saved.submitSave}
        />
      </Modal>

      <Drawer
        title="Saved scripts"
        placement="right"
        width={340}
        open={saved.listOpen}
        onClose={saved.closeList}
      >
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Search scripts…"
          value={saved.search}
          onChange={(e) => saved.setSearch(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        {saved.filtered.length === 0 ? (
          <Empty description={saved.items.length === 0 ? 'No saved scripts yet' : 'No matches'} />
        ) : (
          <List
            size="small"
            dataSource={saved.filtered}
            renderItem={(s) => (
              <List.Item
                actions={[
                  <Button key="open" type="link" size="small" onClick={() => openScript(s)}>
                    Open
                  </Button>,
                  <Popconfirm
                    key="del"
                    title="Delete this script?"
                    okText="Delete"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => saved.remove(s.id)}
                  >
                    <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                ]}
              >
                <List.Item.Meta
                  title={
                    <span style={{ cursor: 'pointer' }} onClick={() => openScript(s)}>
                      {s.name}
                    </span>
                  }
                  description={
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {new Date(s.updated_at).toLocaleString()}
                    </Text>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Drawer>

      <div
        style={{
          height: editorHeight,
          minHeight: 80,
          overflow: 'hidden',
          flexShrink: 0
        }}
      >
        <SqlEditor
          ref={editorRef}
          value={sqlText}
          onChange={setSqlText}
          schema={schema}
          extraExtensions={keymapExtension}
        />
      </div>

      <div
        className="pg-row-resizer"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={beginResize}
        title="Drag to resize editor"
      />

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}>
        {error && (
          <Alert
            type="error"
            message="Query failed"
            action={<TroubleshootButton loading={tsLoading} onClick={troubleshoot} />}
            description={
              <>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{error}</pre>
                {deriveSqlHint(sqlText, error) && (
                  <div style={{ marginTop: 8, opacity: 0.85 }}>
                    💡 {deriveSqlHint(sqlText, error)}
                  </div>
                )}
              </>
            }
            style={{ margin: 12 }}
          />
        )}
        {tsResult && (
          <TroubleshootPanel
            result={tsResult}
            onApply={applyTroubleshootFix}
            onClose={() => setTsResult(null)}
          />
        )}
        {!error && result && result.rows.length > 0 && (
          <QueryResultTable rows={result.rows} fields={result.fields} onAskRow={setAskRow} />
        )}
        {!error && result && result.rows.length === 0 && (
          <div style={{ padding: 16, fontSize: 13 }}>
            <div style={{ opacity: 0.65 }}>
              {['INSERT', 'UPDATE', 'DELETE'].includes(result.command || '')
                ? `${result.command} · ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} affected.`
                : `${result.command || 'OK'} — no rows returned.`}
            </div>
            {hasFilterTerms && (
              <div style={{ marginTop: 10 }}>
                <Button
                  size="small"
                  icon={<BulbOutlined />}
                  loading={suggestLoading}
                  onClick={fetchSuggestions}
                >
                  Suggest matching values
                </Button>
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                  A filter value may not match how the data is stored.
                </Text>
              </div>
            )}
            {suggestGroups && suggestGroups.length === 0 && (
              <div style={{ marginTop: 10, opacity: 0.6 }}>
                No similar values found in schema <code>{aiSchema}</code>.
              </div>
            )}
            {suggestGroups && suggestGroups.length > 0 && (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {!suggestTrigram && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    pg_trgm not installed — ranking by substring match instead.
                  </Text>
                )}
                {suggestGroups.map((g) => (
                  <div key={`${g.column}|${g.raw}`}>
                    <Text style={{ fontSize: 12 }}>
                      <code>{g.column}</code> — did you mean{' '}
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        (in {g.source})
                      </Text>
                      :
                    </Text>
                    <div style={{ marginTop: 6 }}>
                      <Space size={[6, 6]} wrap>
                        {g.suggestions.map((s) => (
                          <Tag
                            key={s.value}
                            color="processing"
                            style={{ cursor: 'pointer', margin: 0 }}
                            onClick={() => applySuggestion(g.raw, s.value)}
                          >
                            {s.value}
                            <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                              {Math.round(s.similarity * 100)}%
                            </Text>
                          </Tag>
                        ))}
                      </Space>
                    </div>
                  </div>
                ))}
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Click a value to put it into the query, then run again.
                </Text>
              </div>
            )}
          </div>
        )}
        {!error && !result && (
          <div style={{ padding: 16, opacity: 0.55, fontSize: 13 }}>
            Press <kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd> or click <strong>Run</strong> to execute.
          </div>
        )}
      </div>
    </div>
  )
}

