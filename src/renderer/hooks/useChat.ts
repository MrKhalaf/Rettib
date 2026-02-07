import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { chatApi } from '../api/chat'
import { WORKSTREAMS_QUERY_KEY } from './useWorkstreams'

export function useConversations() {
  return useQuery({
    queryKey: ['chat', 'conversations'],
    queryFn: () => chatApi.listConversations()
  })
}

export function useLinkConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ workstreamId, conversationUuid }: { workstreamId: number; conversationUuid: string }) =>
      chatApi.link(workstreamId, conversationUuid),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['workstream', vars.workstreamId] })
    }
  })
}

export function useUnlinkConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ workstreamId, conversationUuid }: { workstreamId: number; conversationUuid: string }) =>
      chatApi.unlink(workstreamId, conversationUuid),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['workstream', vars.workstreamId] })
    }
  })
}
