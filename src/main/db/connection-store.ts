import Store from 'electron-store'
import { v4 as uuidv4 } from 'uuid'
import type { Connection, ConnectionInput } from '@shared/types'

interface StoreSchema {
  connections: Connection[]
}

const store = new Store<StoreSchema>({
  name: 'pgtable',
  defaults: { connections: [] }
})

// `databases` arrives from a free-text tag input, so strip blanks and repeats
// before it reaches the pool manager or the sidebar.
function normalize<T extends Partial<ConnectionInput>>(input: T): T {
  if (!input.databases) return input
  const cleaned = [...new Set(input.databases.map((d) => d.trim()).filter(Boolean))]
  return { ...input, databases: cleaned }
}

export function listConnections(): Connection[] {
  return store.get('connections')
}

export function getConnection(id: string): Connection | undefined {
  return store.get('connections').find((c) => c.id === id)
}

export function addConnection(input: ConnectionInput): Connection {
  const now = new Date().toISOString()
  const conn: Connection = { ...normalize(input), id: uuidv4(), created_at: now, updated_at: now }
  const connections = store.get('connections')
  store.set('connections', [...connections, conn])
  return conn
}

export function updateConnection(id: string, input: Partial<ConnectionInput>): Connection {
  const connections = store.get('connections')
  const idx = connections.findIndex((c) => c.id === id)
  if (idx === -1) throw new Error(`Connection ${id} not found`)
  const updated: Connection = {
    ...connections[idx],
    ...normalize(input),
    updated_at: new Date().toISOString()
  }
  const next = [...connections]
  next[idx] = updated
  store.set('connections', next)
  return updated
}

export function deleteConnection(id: string): void {
  const connections = store.get('connections').filter((c) => c.id !== id)
  store.set('connections', connections)
}
