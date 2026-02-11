export type WorkstreamStatus = 'active' | 'blocked' | 'waiting' | 'done'
export type TaskStatus = 'todo' | 'in_progress' | 'done'
export type SyncSourceType = 'claude_cli' | 'claude_desktop'
export type SyncRunStatus = 'running' | 'success' | 'failed'

export interface Workstream {
  id: number
  name: string
  priority: number
  target_cadence_days: number
  last_progress_at: number | null
  status: WorkstreamStatus
  next_action: string | null
  notes: string | null
  created_at: number
  updated_at: number
}

export interface CreateWorkstreamInput {
  name: string
  priority: number
  target_cadence_days: number
  status?: WorkstreamStatus
  next_action?: string | null
  notes?: string | null
}

export interface UpdateWorkstreamInput {
  name?: string
  priority?: number
  target_cadence_days?: number
  status?: WorkstreamStatus
  next_action?: string | null
  notes?: string | null
}

export interface Task {
  id: number
  workstream_id: number
  title: string
  status: TaskStatus
  position: number
  created_at: number
  updated_at: number
}

export interface CreateTaskInput {
  workstream_id: number
  title: string
}

export interface UpdateTaskInput {
  title?: string
  status?: TaskStatus
  position?: number
}

export interface ProgressUpdate {
  id: number
  workstream_id: number
  note: string
  created_at: number
}

export interface ChatReference {
  id: number
  workstream_id: number
  source: string
  conversation_uuid: string
  conversation_title: string | null
  last_user_message: string | null
  chat_timestamp: number | null
  linked_at: number
}

export interface WorkstreamChatSession {
  workstream_id: number
  session_id: string
  project_cwd: string | null
  updated_at: number
}

export interface ClaudeConversation {
  conversation_uuid: string
  title: string | null
  chat_timestamp: number | null
  last_user_message: string | null
}

export interface ClaudeConversationPreviewMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp: number | null
}

export interface SendChatMessageInput {
  workstream_id: number
  message: string
  cwd?: string | null
  resume_session_id?: string | null
  allow_workstream_session_fallback?: boolean
  model?: string | null
  permission_mode?: ClaudePermissionMode | null
}

export interface SendChatMessageResult {
  stream_id: string
  session_id: string | null
  assistant_text: string
  result_text: string | null
  is_error: boolean
  exit_code: number | null
}

export type ClaudePermissionMode = 'acceptEdits' | 'bypassPermissions' | 'default' | 'delegate' | 'dontAsk' | 'plan'

export type ChatStreamEventType =
  | 'init'
  | 'token'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'question'
  | 'permission'
  | 'result'
  | 'error'
  | 'done'

export interface ChatStreamEvent {
  stream_id: string
  type: ChatStreamEventType
  timestamp: number
  session_id?: string | null
  text?: string
  data?: unknown
  error?: string
}

export interface SyncSource {
  id: number
  type: SyncSourceType
  config: string
  created_at: number
  updated_at: number
}

export interface SyncRun {
  id: number
  source_id: number
  status: SyncRunStatus
  started_at: number
  completed_at: number | null
  details: string | null
}

export interface WorkstreamScore {
  priority_score: number
  staleness_ratio: number
  staleness_score: number
  blocked_penalty: number
  total_score: number
  days_since_progress: number
  staleness_basis: 'progress' | 'created'
}

export interface WorkstreamWithScore extends Workstream {
  score: WorkstreamScore
  ranking_explanation: string
}

export interface WorkstreamDetail {
  workstream: WorkstreamWithScore
  tasks: Task[]
  progress: ProgressUpdate[]
  chats: ChatReference[]
}

export interface WorkstreamListItem extends WorkstreamWithScore {
  last_chat: ChatReference | null
}

export interface SyncDiagnostics {
  exists: boolean
  path: string
  error?: string
}

export interface ElectronApi {
  workstreams: {
    list: () => Promise<WorkstreamListItem[]>
    get: (id: number) => Promise<WorkstreamDetail | null>
    create: (data: CreateWorkstreamInput) => Promise<Workstream>
    update: (id: number, data: UpdateWorkstreamInput) => Promise<void>
  }
  progress: {
    log: (workstreamId: number, note: string) => Promise<void>
    list: (workstreamId: number) => Promise<ProgressUpdate[]>
  }
  tasks: {
    list: (workstreamId: number) => Promise<Task[]>
    create: (workstreamId: number, title: string) => Promise<Task>
    update: (id: number, data: UpdateTaskInput) => Promise<void>
    delete: (id: number) => Promise<void>
  }
  chat: {
    listConversations: () => Promise<ClaudeConversation[]>
    listLinkedConversationUuids: () => Promise<string[]>
    getConversationPreview: (conversationUuid: string, limit?: number) => Promise<ClaudeConversationPreviewMessage[]>
    link: (workstreamId: number, conversationUuid: string) => Promise<void>
    unlink: (workstreamId: number, conversationUuid: string) => Promise<void>
    getWorkstreamSession: (workstreamId: number) => Promise<WorkstreamChatSession | null>
    sendMessage: (input: SendChatMessageInput) => Promise<SendChatMessageResult>
    cancelStream: (streamId: string) => Promise<void>
    onStreamEvent: (listener: (event: ChatStreamEvent) => void) => () => void
  }
  sync: {
    run: (sourceId: number) => Promise<void>
    runs: (sourceId: number) => Promise<SyncRun[]>
    getOrCreateSource: () => Promise<SyncSource>
    updateSourcePath: (path: string) => Promise<SyncSource>
    diagnostics: () => Promise<SyncDiagnostics>
  }
  app: {
    openObsidianNote: (noteRef: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  }
}
