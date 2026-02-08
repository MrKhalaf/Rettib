import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { chatApi } from '../api/chat'
import { WORKSTREAMS_QUERY_KEY } from './useWorkstreams'

export function useConversations() {
  return useQuery({
    queryKey: ['chat', 'conversations'],
    queryFn: () => chatApi.listConversations(),
    refetchInterval: 30_000
  })
}

export function useLinkedConversationUuids() {
  return useQuery({
    queryKey: ['chat', 'linked-conversation-uuids'],
    queryFn: () => chatApi.listLinkedConversationUuids(),
    refetchInterval: 30_000
  })
}

export function useWorkstreamChatSession(workstreamId: number | null) {
  return useQuery({
    queryKey: ['chat', 'session', workstreamId],
    queryFn: () => chatApi.getWorkstreamSession(workstreamId as number),
    enabled: workstreamId !== null
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
      void queryClient.invalidateQueries({ queryKey: ['chat', 'linked-conversation-uuids'] })
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
      void queryClient.invalidateQueries({ queryKey: ['chat', 'linked-conversation-uuids'] })
    }
  })
}
