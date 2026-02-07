import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { CreateWorkstreamInput, UpdateWorkstreamInput } from '../../shared/types'
import { workstreamsApi } from '../api/workstreams'

export const WORKSTREAMS_QUERY_KEY = ['workstreams']

export function useWorkstreams() {
  const hasElectronBridge = typeof window.electronAPI !== 'undefined'

  return useQuery({
    queryKey: WORKSTREAMS_QUERY_KEY,
    queryFn: () => workstreamsApi.list(),
    enabled: hasElectronBridge,
    retry: false,
    refetchInterval: hasElectronBridge ? 30_000 : false
  })
}

export function useWorkstreamDetail(workstreamId: number | null) {
  return useQuery({
    queryKey: ['workstream', workstreamId],
    queryFn: () => workstreamsApi.get(workstreamId as number),
    enabled: workstreamId !== null,
    refetchInterval: 30_000
  })
}

export function useCreateWorkstream() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: CreateWorkstreamInput) => workstreamsApi.create(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY })
    }
  })
}

export function useUpdateWorkstream() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateWorkstreamInput }) => workstreamsApi.update(id, data),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['workstream', variables.id] })
    }
  })
}
