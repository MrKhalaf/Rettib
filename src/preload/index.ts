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
    update: (id, data) => ipcRenderer.invoke('tasks:update', id, data)
  },
  chat: {
    listConversations: () => ipcRenderer.invoke('chat:list-conversations'),
    link: (workstreamId, conversationUuid) => ipcRenderer.invoke('chat:link', workstreamId, conversationUuid),
    unlink: (workstreamId, conversationUuid) => ipcRenderer.invoke('chat:unlink', workstreamId, conversationUuid)
  },
  sync: {
    run: (sourceId) => ipcRenderer.invoke('sync:run', sourceId),
    runs: (sourceId) => ipcRenderer.invoke('sync:runs', sourceId),
    getOrCreateSource: () => ipcRenderer.invoke('sync:get-or-create-source'),
    updateSourcePath: (sourcePath) => ipcRenderer.invoke('sync:update-source-path', sourcePath),
    diagnostics: () => ipcRenderer.invoke('sync:diagnostics')
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
