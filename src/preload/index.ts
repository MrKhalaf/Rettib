import { contextBridge, ipcRenderer } from 'electron'

import type { ElectronApi } from '../shared/types'

const api: ElectronApi = {
  workstreams: {
    list: () => ipcRenderer.invoke('workstreams:list'),
    get: (id) => ipcRenderer.invoke('workstreams:get', id),
    create: (data) => ipcRenderer.invoke('workstreams:create', data),
    update: (id, data) => ipcRenderer.invoke('workstreams:update', id, data)
  },
  progress: {
    log: (workstreamId, note) => ipcRenderer.invoke('progress:log', workstreamId, note),
    list: (workstreamId) => ipcRenderer.invoke('progress:list', workstreamId)
  },
  tasks: {
    list: (workstreamId) => ipcRenderer.invoke('tasks:list', workstreamId),
    create: (workstreamId, title) => ipcRenderer.invoke('tasks:create', workstreamId, title),
    update: (id, data) => ipcRenderer.invoke('tasks:update', id, data),
    delete: (id) => ipcRenderer.invoke('tasks:delete', id)
  },
  chat: {
    listConversations: () => ipcRenderer.invoke('chat:list-conversations'),
    listLinkedConversationUuids: () => ipcRenderer.invoke('chat:list-linked-conversation-uuids'),
    getConversationPreview: (conversationUuid, limit) =>
      ipcRenderer.invoke('chat:get-conversation-preview', conversationUuid, limit),
    link: (workstreamId, conversationUuid) => ipcRenderer.invoke('chat:link', workstreamId, conversationUuid),
    unlink: (workstreamId, conversationUuid) => ipcRenderer.invoke('chat:unlink', workstreamId, conversationUuid),
    getWorkstreamSession: (workstreamId) => ipcRenderer.invoke('chat:get-workstream-session', workstreamId),
    getWorkstreamContext: (workstreamId) => ipcRenderer.invoke('chat:get-workstream-context', workstreamId),
    setWorkstreamContext: (workstreamId, docs) => ipcRenderer.invoke('chat:set-workstream-context', workstreamId, docs),
    getSessionContext: (workstreamId, conversationUuid) =>
      ipcRenderer.invoke('chat:get-session-context', workstreamId, conversationUuid),
    setSessionContext: (workstreamId, conversationUuid, docs) =>
      ipcRenderer.invoke('chat:set-session-context', workstreamId, conversationUuid, docs),
    resolveContextDocs: (docs) => ipcRenderer.invoke('chat:resolve-context-docs', docs),
    sendMessage: (input) => ipcRenderer.invoke('chat:send-message', input),
    cancelStream: (streamId) => ipcRenderer.invoke('chat:cancel-stream', streamId),
    onStreamEvent: (listener) => {
      const handler = (_event: unknown, payload: unknown) => {
        listener(payload as Parameters<typeof listener>[0])
      }
      ipcRenderer.on('chat:stream-event', handler)
      return () => {
        ipcRenderer.removeListener('chat:stream-event', handler)
      }
    }
  },
  sync: {
    run: (sourceId) => ipcRenderer.invoke('sync:run', sourceId),
    runs: (sourceId) => ipcRenderer.invoke('sync:runs', sourceId),
    getOrCreateSource: () => ipcRenderer.invoke('sync:get-or-create-source'),
    updateSourcePath: (sourcePath) => ipcRenderer.invoke('sync:update-source-path', sourcePath),
    diagnostics: () => ipcRenderer.invoke('sync:diagnostics')
  },
  app: {
    openObsidianNote: (noteRef) => ipcRenderer.invoke('app:open-obsidian-note', noteRef),
    pickContextFile: (options) => ipcRenderer.invoke('app:pick-context-file', options)
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
