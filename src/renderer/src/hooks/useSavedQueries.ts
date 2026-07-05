import { useCallback, useMemo, useRef, useState } from 'react'
import { Modal, message } from 'antd'
import type { IpcChannel } from '@shared/ipc-channels'
import type { IpcResult } from '@shared/types'
import { invoke } from '../api'

// Minimum shape every saveable library item shares. Both SavedScript and
// SavedFederatedQuery satisfy this, which is all this hook needs to list, sort,
// filter and delete them; feature-specific fields stay in the caller's TItem.
export interface SavedQueryItem {
  id: string
  name: string
  updated_at: string
}

export interface SavedQueriesChannels {
  list: IpcChannel
  save: IpcChannel
  delete: IpcChannel
}

export interface UseSavedQueriesConfig<TSaveInput> {
  channels: SavedQueriesChannels
  // Human noun for user-facing messages, e.g. "script" or "federated query".
  noun: string
  // Build the save payload from the entered name. Return `null` to abort the
  // save because the current content is not saveable — the caller is expected to
  // have shown its own warning explaining why (empty SQL, no attachments, …).
  buildSaveInput: (name: string, overwrite: boolean) => TSaveInput | null
}

export interface UseSavedQueries<TItem> {
  items: TItem[]
  // `items` sorted newest-first and filtered by `search`.
  filtered: TItem[]
  search: string
  setSearch: (v: string) => void
  // Saved-list drawer open state.
  listOpen: boolean
  // Opens the drawer and (re)loads the list.
  openList: () => void
  closeList: () => void
  reload: () => Promise<void>
  remove: (id: string) => Promise<void>
  // Save modal state.
  saveOpen: boolean
  setSaveOpen: (v: boolean) => void
  saveName: string
  setSaveName: (v: string) => void
  saving: boolean
  // Validates the name, builds the payload, saves, and handles a NAME_EXISTS
  // collision with an Overwrite / Rename confirm — mirrors the main process's D3.
  submitSave: () => void
}

// Shared saved-query library logic for the Query and Federated tabs: list +
// search + newest-first sort, save modal with NAME_EXISTS collision handling,
// and delete — all over caller-supplied IPC channels. The JSX (drawer/modal)
// stays in each tab since they render differently; only the state and IPC flow
// live here.
export function useSavedQueries<TItem extends SavedQueryItem, TSaveInput>(
  config: UseSavedQueriesConfig<TSaveInput>
): UseSavedQueries<TItem> {
  const { list, save, delete: del } = config.channels
  const { noun } = config

  const [items, setItems] = useState<TItem[]>([])
  const [search, setSearch] = useState('')
  const [listOpen, setListOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)

  // buildSaveInput closes over live caller state (SQL text, attachments, …), so
  // keep the latest via a ref instead of a dep — that keeps submitSave stable.
  const buildSaveInputRef = useRef(config.buildSaveInput)
  buildSaveInputRef.current = config.buildSaveInput

  const reload = useCallback(async () => {
    try {
      setItems(await invoke<TItem[]>(list))
    } catch (err) {
      message.error(String(err))
    }
  }, [list])

  const openList = useCallback(() => {
    setListOpen(true)
    reload()
  }, [reload])

  const closeList = useCallback(() => setListOpen(false), [])

  const submitSave = useCallback(() => {
    const run = async (overwrite: boolean): Promise<void> => {
      const name = saveName.trim()
      if (!name) {
        message.warning(`Enter a name for the ${noun}.`)
        return
      }
      const input = buildSaveInputRef.current(name, overwrite)
      if (input === null) return
      setSaving(true)
      try {
        const res = await invoke<IpcResult<{ id: string }>>(save, input)
        if ('error' in res) {
          if (res.error === 'NAME_EXISTS') {
            Modal.confirm({
              title: `A ${noun} named "${name}" already exists`,
              content: 'Overwrite it, or cancel to rename.',
              okText: 'Overwrite',
              cancelText: 'Rename',
              onOk: () => run(true)
            })
          } else {
            message.error(res.error)
          }
          return
        }
        message.success(`Saved "${name}".`)
        setSaveOpen(false)
        setSaveName('')
        reload()
      } catch (err) {
        message.error(String(err))
      } finally {
        setSaving(false)
      }
    }
    run(false)
  }, [saveName, noun, save, reload])

  const remove = useCallback(
    async (id: string) => {
      try {
        const res = await invoke<IpcResult>(del, { id })
        if ('error' in res) {
          message.error(res.error)
          return
        }
        reload()
      } catch (err) {
        message.error(String(err))
      }
    },
    [del, reload]
  )

  const filtered = useMemo(() => {
    const sorted = [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    const q = search.trim().toLowerCase()
    if (!q) return sorted
    return sorted.filter((s) => s.name.toLowerCase().includes(q))
  }, [items, search])

  return {
    items,
    filtered,
    search,
    setSearch,
    listOpen,
    openList,
    closeList,
    reload,
    remove,
    saveOpen,
    setSaveOpen,
    saveName,
    setSaveName,
    saving,
    submitSave
  }
}
