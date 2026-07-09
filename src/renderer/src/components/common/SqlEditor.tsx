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
  // Appended to the built-in `pg-sql-editor` class, never replacing it.
  className?: string
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
//
// The `pg-sql-editor` class carries the rules that make a long document scroll
// *inside* the editor (styles.css). Without it CodeMirror sizes itself to its
// content and grows the surrounding pane, so it is applied here rather than
// left to each call site to remember. Callers must give the editor a parent of
// definite height for that to bite.
//
// Memoised: several call sites (e.g. the linked-query steps) hold every editor's
// buffer in one parent state object, so typing in one re-renders them all. Note
// that @uiw/react-codemirror reconfigures the whole extension tree whenever the
// `basicSetup` or `onChange` identity changes, so callers must keep both stable
// — an inline object or arrow function there rebuilds lang-sql on every
// keystroke, memo or not.
export const SqlEditor = React.memo(
  forwardRef<ReactCodeMirrorRef, Props>(function SqlEditor(
    {
      value,
      onChange,
      schema,
      editable = true,
      height = '100%',
      style,
      extraExtensions,
      basicSetup,
      className
    },
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
        className={className ? `pg-sql-editor ${className}` : 'pg-sql-editor'}
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
)
