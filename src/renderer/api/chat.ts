import { getElectronApi } from './electron-api'

export const chatApi = {
  listConversations: () => getElectronApi().chat.listConversations(),
  link: (workstreamId: number, conversationUuid: string) =>
    getElectronApi().chat.link(workstreamId, conversationUuid),
  unlink: (workstreamId: number, conversationUuid: string) =>
    getElectronApi().chat.unlink(workstreamId, conversationUuid)
}
