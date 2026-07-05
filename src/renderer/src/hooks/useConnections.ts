import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { IPC } from '@shared/ipc-channels'
import type { Connection, ConnectionInput, IpcResult } from '@shared/types'
import { invoke } from '../api'

export function useConnections() {
  return useQuery({
    queryKey: ['connections'],
    queryFn: () => invoke<Connection[]>(IPC.CONN_LIST)
  })
}

export function useAddConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ConnectionInput) =>
      invoke<IpcResult<{ id: string }>>(IPC.CONN_ADD, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] })
  })
}

export function useUpdateConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: { id: string } & Partial<ConnectionInput>) =>
      invoke<IpcResult>(IPC.CONN_UPDATE, payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] })
  })
}

export function useDeleteConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => invoke<IpcResult>(IPC.CONN_DELETE, { id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] })
  })
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (input: ConnectionInput) =>
      invoke<IpcResult<{ latency_ms: number }>>(IPC.CONN_TEST, input)
  })
}
