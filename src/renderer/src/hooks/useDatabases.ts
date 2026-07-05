import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { IPC } from '@shared/ipc-channels'
import type { TableMeta, ColumnMeta, TableDataPayload, TableDataResult } from '@shared/types'
import { invoke } from '../api'

export function useDatabases(connectionId: string | null) {
  return useQuery({
    queryKey: ['databases', connectionId],
    queryFn: () => invoke<string[]>(IPC.DB_LIST, { connectionId }),
    enabled: !!connectionId
  })
}

export function useSchemas(connectionId: string | null, database: string | null) {
  return useQuery({
    queryKey: ['schemas', connectionId, database],
    queryFn: () => invoke<string[]>(IPC.SCHEMA_LIST, { connectionId, database }),
    enabled: !!(connectionId && database)
  })
}

export function useTables(
  connectionId: string | null,
  database: string | null,
  schema: string | null
) {
  return useQuery({
    queryKey: ['tables', connectionId, database, schema],
    queryFn: () => invoke<TableMeta[]>(IPC.TABLE_LIST, { connectionId, database, schema }),
    enabled: !!(connectionId && database && schema)
  })
}

export function useColumns(
  connectionId: string | null,
  database: string | null,
  schema: string | null,
  table: string | null
) {
  return useQuery({
    queryKey: ['columns', connectionId, database, schema, table],
    queryFn: () => invoke<ColumnMeta[]>(IPC.COLUMN_LIST, { connectionId, database, schema, table }),
    enabled: !!(connectionId && database && schema && table)
  })
}

export function usePrimaryKeys(
  connectionId: string,
  database: string,
  schema: string,
  table: string
) {
  return useQuery({
    queryKey: ['primaryKeys', connectionId, database, schema, table],
    queryFn: () => invoke<string[]>(IPC.PRIMARY_KEYS, { connectionId, database, schema, table }),
    enabled: !!(connectionId && database && schema && table),
    staleTime: 5 * 60_000
  })
}

// Distinct values for one column, capped server-side. Only fetched when
// `enabled` is true so we don't hammer the DB until the filter popover opens.
export function useColumnDistinct(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
  column: string,
  enabled: boolean
) {
  return useQuery({
    queryKey: ['columnDistinct', connectionId, database, schema, table, column],
    queryFn: () =>
      invoke<unknown[]>(IPC.COLUMN_DISTINCT, { connectionId, database, schema, table, column }),
    enabled: enabled && !!(connectionId && database && schema && table && column),
    staleTime: 60_000
  })
}

export function useTableData(params: TableDataPayload | null) {
  return useQuery({
    queryKey: ['tableData', params],
    queryFn: () => invoke<TableDataResult>(IPC.TABLE_DATA, params!),
    enabled: !!params,
    // Keep the previous page/sort's rows on screen while the next query runs,
    // so changing sort or paging doesn't unmount the grid and flicker.
    placeholderData: keepPreviousData
  })
}
