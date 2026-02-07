import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { UpdateTaskInput } from '../../shared/types'
import { tasksApi } from '../api/tasks'

export function useTasks(workstreamId: number | null) {
  return useQuery({
    queryKey: ['tasks', workstreamId],
    queryFn: () => tasksApi.list(workstreamId as number),
    enabled: workstreamId !== null,
    refetchInterval: 30_000
  })
}

export function useCreateTask(workstreamId: number) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (title: string) => tasksApi.create(workstreamId, title),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', workstreamId] })
      void queryClient.invalidateQueries({ queryKey: ['workstream', workstreamId] })
    }
  })
}

export function useUpdateTask(workstreamId: number) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateTaskInput }) => tasksApi.update(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks', workstreamId] })
      void queryClient.invalidateQueries({ queryKey: ['workstream', workstreamId] })
    }
  })
}
