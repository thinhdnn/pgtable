import React, { forwardRef, useMemo } from 'react'
import CodeMirror, {
  type ReactCodeMirrorRef,
  type ReactCodeMirrorProps
} from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { useThemeMode } from '../../theme'
import { buildSqlExtension, type SchemaPayload } from '../../utils/sql-completion'

interface Props {
  value: string
  onChange: (value: string) => void
  // Introspected schema for autocomplete. Pass null before it resolves — the
  // editor still works with plain keyword completion until it arrives.
  schema: SchemaPayload | null
  editable?: boolean
  height?: string
  style?: React.CSSProperties
  // Extra editor extensions (e.g. a keymap). Kept out of the memo key by
  // reference, so pass a stable array.
  extraExtensions?: Extension[]
  // Merged over the default basicSetup (e.g. `{ foldGutter: true }`).
  basicSetup?: ReactCodeMirrorProps['basicSetup']
}

// Sensible defaults shared by every SQL editor in the app.
const DEFAULT_BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: true,
  autocompletion: true,
  bracketMatching: true,
  closeBrackets: true,
  indentOnInput: true
} as const

// Shared CodeMirror-based SQL editor: resolves the app theme, wires
// schema-aware completion (table/column names + FROM-aware columns) and line
// wrapping, and applies a consistent basicSetup. Callers layer on their own
// keymaps / ref handling via props. Forwards the CodeMirror ref so callers that
// need the live EditorView (e.g. run-selection) can reach it.
export const SqlEditor = forwardRef<ReactCodeMirrorRef, Props>(function SqlEditor(
  { value, onChange, schema, editable = true, height = '100%', style, extraExtensions, basicSetup },
  ref
) {
  const { mode } = useThemeMode()

  const extensions = useMemo<Extension[]>(
    () => [buildSqlExtension(schema), EditorView.lineWrapping, ...(extraExtensions ?? [])],
    [schema, extraExtensions]
  )

  const setup = useMemo(
    () =>
      typeof basicSetup === 'boolean'
        ? basicSetup
        : { ...DEFAULT_BASIC_SETUP, ...(basicSetup ?? {}) },
    [basicSetup]
  )

  return (
    <CodeMirror
      ref={ref}
      value={value}
      onChange={onChange}
      editable={editable}
      height={height}
      theme={mode === 'dark' ? 'dark' : 'light'}
      extensions={extensions}
      basicSetup={setup}
      style={style}
    />
  )
})
