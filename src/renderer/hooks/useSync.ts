import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { syncApi } from '../api/sync'

export function useSyncSource() {
  return useQuery({
    queryKey: ['sync', 'source'],
    queryFn: () => syncApi.getOrCreateSource()
  })
}

export function useSyncRuns(sourceId: number | null) {
  return useQuery({
    queryKey: ['sync', 'runs', sourceId],
    queryFn: () => syncApi.runs(sourceId as number),
    enabled: sourceId !== null,
    refetchInterval: 15_000
  })
}

export function useSyncDiagnostics() {
  return useQuery({
    queryKey: ['sync', 'diagnostics'],
    queryFn: () => syncApi.diagnostics(),
    refetchInterval: 15_000
  })
}

export function useUpdateSyncPath() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (sourcePath: string) => syncApi.updateSourcePath(sourcePath),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sync', 'source'] })
      void queryClient.invalidateQueries({ queryKey: ['sync', 'diagnostics'] })
    }
  })
}

export function useRunSync() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (sourceId: number) => syncApi.run(sourceId),
    onSuccess: (_data, sourceId) => {
      void queryClient.invalidateQueries({ queryKey: ['sync', 'runs', sourceId] })
      void queryClient.invalidateQueries({ queryKey: ['sync', 'diagnostics'] })
    }
  })
}
