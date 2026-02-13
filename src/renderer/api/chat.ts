import type {
  ChatStreamEvent,
  ChatSessionPreference,
  ContextDocInput,
  SendChatMessageInput,
  StartTerminalSessionInput,
  TerminalEvent
} from '../../shared/types'

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
  getWorkstreamContext: (workstreamId: number) => getElectronApi().chat.getWorkstreamContext(workstreamId),
  setWorkstreamContext: (workstreamId: number, docs: ContextDocInput[]) =>
    getElectronApi().chat.setWorkstreamContext(workstreamId, docs),
  getSessionContext: (workstreamId: number, conversationUuid: string) =>
    getElectronApi().chat.getSessionContext(workstreamId, conversationUuid),
  setSessionContext: (workstreamId: number, conversationUuid: string, docs: ContextDocInput[]) =>
    getElectronApi().chat.setSessionContext(workstreamId, conversationUuid, docs),
  getSessionPreference: (conversationUuid: string) => getElectronApi().chat.getSessionPreference(conversationUuid),
  setSessionPreference: (
    conversationUuid: string,
    patch: {
      command_mode?: ChatSessionPreference['command_mode']
      view_mode?: ChatSessionPreference['view_mode']
    }
  ) => getElectronApi().chat.setSessionPreference(conversationUuid, patch),
  startTerminalSession: (input: StartTerminalSessionInput) => getElectronApi().chat.startTerminalSession(input),
  stopTerminalSession: () => getElectronApi().chat.stopTerminalSession(),
  sendTerminalInput: (data: string) => getElectronApi().chat.sendTerminalInput(data),
  resizeTerminal: (cols: number, rows: number) => getElectronApi().chat.resizeTerminal(cols, rows),
  getTerminalSessionState: () => getElectronApi().chat.getTerminalSessionState(),
  resolveContextDocs: (docs: ContextDocInput[]) => getElectronApi().chat.resolveContextDocs(docs),
  sendMessage: (input: SendChatMessageInput) => getElectronApi().chat.sendMessage(input),
  cancelStream: (streamId: string) => getElectronApi().chat.cancelStream(streamId),
  onStreamEvent: (listener: (event: ChatStreamEvent) => void) => getElectronApi().chat.onStreamEvent(listener),
  onTerminalEvent: (listener: (event: TerminalEvent) => void) => getElectronApi().chat.onTerminalEvent(listener)
}
