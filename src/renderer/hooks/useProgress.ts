import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { progressApi } from '../api/progress'
import { WORKSTREAMS_QUERY_KEY } from './useWorkstreams'

export function useProgress(workstreamId: number | null) {
  return useQuery({
    queryKey: ['progress', workstreamId],
    queryFn: () => progressApi.list(workstreamId as number),
    enabled: workstreamId !== null,
    refetchInterval: 30_000
  })
}

export function useLogProgress() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ workstreamId, note }: { workstreamId: number; note: string }) =>
      progressApi.log(workstreamId, note),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['progress', vars.workstreamId] })
      void queryClient.invalidateQueries({ queryKey: ['workstream', vars.workstreamId] })
    }
  })
}
