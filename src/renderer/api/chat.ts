import type { ChatStreamEvent, SendChatMessageInput } from '../../shared/types'

import { getElectronApi } from './electron-api'

export const chatApi = {
  listConversations: () => getElectronApi().chat.listConversations(),
  listLinkedConversationUuids: () => getElectronApi().chat.listLinkedConversationUuids(),
  getConversationPreview: (conversationUuid: string, limit?: number) =>
    getElectronApi().chat.getConversationPreview(conversationUuid, limit),
  link: (workstreamId: number, conversationUuid: string) =>
    getElectronApi().chat.link(workstreamId, conversationUuid),
  unlink: (workstreamId: number, conversationUuid: string) =>
    getElectronApi().chat.unlink(workstreamId, conversationUuid),
  getWorkstreamSession: (workstreamId: number) => getElectronApi().chat.getWorkstreamSession(workstreamId),
  sendMessage: (input: SendChatMessageInput) => getElectronApi().chat.sendMessage(input),
  cancelStream: (streamId: string) => getElectronApi().chat.cancelStream(streamId),
  onStreamEvent: (listener: (event: ChatStreamEvent) => void) => getElectronApi().chat.onStreamEvent(listener)
}
