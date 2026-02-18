import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import type {
  ChatSessionCommandMode,
  ChatSessionPreference,
  ChatSessionViewMode,
  ChatReference,
  ChatStreamEvent,
  ClaudeConversationPreviewMessage,
  ClaudePermissionMode,
  ContextDocInput,
  ContextDocSource,
  ResolveContextDocResult,
  SessionContextDoc,
  TerminalEvent,
  TerminalSessionState,
  UpdateWorkstreamInput,
  WorkstreamContextDoc,
  WorkstreamStatus
} from '../../shared/types'
import { appApi } from '../api/app'
import { chatApi } from '../api/chat'
import {
  useConversations,
  useLinkConversation,
  useLinkedConversationUuids,
  useUnlinkConversation,
  useWorkstreamChatSession
} from '../hooks/useChat'
import { useRunSync, useSyncDiagnostics, useSyncSource } from '../hooks/useSync'
import { useUpdateWorkstream, useWorkstreamDetail } from '../hooks/useWorkstreams'
import { formatDateTime, formatRelativeTime } from '../utils/time'
import { ChatMessageContent } from './chat/ChatMessageContent'
import { TerminalPane } from './chat/TerminalPane'

interface Props {
  workstreamId: number | null
}

type DetailTab = 'info' | 'chat' | 'context'

type ToolUseKind = 'read' | 'edit' | 'bash' | 'grep' | 'question' | 'permission' | 'tool'
const SUGGESTION_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
const WORKFLOW_STATUS_OPTIONS: WorkstreamStatus[] = ['active', 'blocked', 'waiting', 'done']
const RUN_DIRECTORY_PREFERRED_ROOTS = ['~/Projects', '~/Projects/playground-projects']
const DEFAULT_CHAT_SESSION_COMMAND_MODE: ChatSessionCommandMode = 'claude'
const DEFAULT_CHAT_SESSION_VIEW_MODE: ChatSessionViewMode = 'chat'
const DEFAULT_TERMINAL_SESSION_STATE: TerminalSessionState = {
  is_active: false,
  conversation_uuid: null,
  workstream_id: null,
  cwd: null,
  command_mode: null,
  started_at: null
}

interface ToolUseEntry {
  id: string
  toolUseId: string | null
  kind: ToolUseKind
  name: string
  target: string
  status: 'running' | 'done'
  detail?: string | null
  output?: string | null
  error?: boolean
}

interface ToolResultSummary {
  toolUseId: string | null
  text: string | null
  isError: boolean
}

interface QuestionOptionSummary {
  label: string
  description: string | null
}

interface QuestionSummary {
  text: string | null
  options: QuestionOptionSummary[]
}

interface PermissionSummary {
  message: string
  commands: string[]
}

interface LiveChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  streaming?: boolean
  error?: boolean
  toolUses?: ToolUseEntry[]
  createdAt: number
}

interface ChatTopicTab {
  id: string
  label: string
  resumeSessionId: string | null
  conversationUuid: string | null
  kind: 'linked' | 'new' | 'session'
}

interface ConversationPreviewState {
  status: 'loading' | 'ready' | 'error'
  messages: ClaudeConversationPreviewMessage[]
  error: string | null
}

function parseSourcePath(config: string): string {
  try {
    const parsed = JSON.parse(config) as { path?: unknown }
    return typeof parsed.path === 'string' ? parsed.path : ''
  } catch {
    return ''
  }
}

function normalizeContextDocKey(doc: ContextDocInput): string {
  const source = doc.source
  const reference = doc.reference.trim()
  if (source === 'obsidian') {
    const body = reference.startsWith('[[') && reference.endsWith(']]') ? reference.slice(2, -2).trim() : reference
    const [rawTarget] = body.split('|')
    const target = (rawTarget ?? '').trim().replace(/\\/g, '/').replace(/\\.md$/i, '')
    return `obsidian:${target.toLowerCase()}`
  }

  return `file:${reference}`
}

function extractLegacyObsidianContextDocs(notes: string | null | undefined): ContextDocInput[] {
  if (!notes) {
    return []
  }

  const regex = /\[\[([^\]]+)\]\]/g
  const docs: ContextDocInput[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null

  while ((match = regex.exec(notes)) !== null) {
    const body = (match[1] ?? '').trim()
    const [rawTarget] = body.split('|')
    const target = (rawTarget ?? '').trim()
    if (!target) {
      continue
    }

    const doc: ContextDocInput = { source: 'obsidian', reference: target }
    const key = normalizeContextDocKey(doc)
    if (!key || seen.has(key)) {
      continue
    }

    seen.add(key)
    docs.push(doc)
  }

  return docs
}

function renderContextReference(doc: ContextDocInput): string {
  if (doc.source === 'obsidian') {
    return `[[${doc.reference}]]`
  }

  return doc.reference
}

function isOutsidePreferredRunRoots(directory: string): boolean {
  const trimmed = directory.trim()
  if (!trimmed) {
    return false
  }

  const normalized = trimmed.replace(/\\/g, '/')
  if (normalized === '~/Projects' || normalized.startsWith('~/Projects/')) {
    return false
  }

  return !/^\/Users\/[^/]+\/Projects(?:\/|$)/.test(normalized)
}

function inferContextResolutionStatus(result: ResolveContextDocResult): 'ok' | 'missing' | 'invalid' {
  if (result.exists) {
    return 'ok'
  }

  const warning = (result.warning ?? '').toLowerCase()
  if (warning.includes('invalid') || warning.includes('empty')) {
    return 'invalid'
  }

  return 'missing'
}

function mapStoredContextDoc(
  doc: Pick<SessionContextDoc, 'source' | 'reference' | 'normalized_reference' | 'resolved_path' | 'status'>
): ResolveContextDocResult {
  return {
    source: doc.source,
    reference: doc.reference,
    normalized_reference: doc.normalized_reference,
    resolved_path: doc.resolved_path,
    exists: doc.status === 'ok',
    warning: doc.status === 'ok' ? undefined : doc.status === 'missing' ? 'Document missing' : 'Document invalid'
  }
}

function mapStoredContextDocsToInputs(
  docs: Array<Pick<SessionContextDoc | WorkstreamContextDoc, 'source' | 'reference'>>
): ContextDocInput[] {
  return docs.map((doc) => ({
    source: doc.source,
    reference: doc.reference
  }))
}

function getChatInitCwd(streamEvent: ChatStreamEvent): string | null {
  if (streamEvent.type !== 'init') {
    return null
  }

  const payload = streamEvent.data
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }

  const cwd = (payload as Record<string, unknown>).cwd
  return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function truncateForUi(value: string, maxLength = 260): string {
  const compacted = value.replace(/\s+/g, ' ').trim()
  if (!compacted) {
    return ''
  }

  return compacted.length > maxLength ? `${compacted.slice(0, maxLength)}...` : compacted
}

function createChatMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createChatTabId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function inferToolKind(toolName: string): ToolUseKind {
  const normalized = toolName.toLowerCase()

  if (normalized.includes('askuserquestion') || normalized.includes('question')) {
    return 'question'
  }

  if (normalized.includes('permission')) {
    return 'permission'
  }

  if (normalized.includes('read')) {
    return 'read'
  }

  if (normalized.includes('edit') || normalized.includes('write') || normalized.includes('patch')) {
    return 'edit'
  }

  if (normalized.includes('bash') || normalized.includes('shell') || normalized.includes('command')) {
    return 'bash'
  }

  if (normalized.includes('grep') || normalized.includes('search') || normalized.includes('find')) {
    return 'grep'
  }

  return 'tool'
}

function summarizeToolTarget(input: unknown): string {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    return trimmed.length > 0 ? trimmed.slice(0, 140) : 'input'
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'input'
  }

  const record = input as Record<string, unknown>
  const questions = record.questions
  if (Array.isArray(questions) && questions.length > 0) {
    const firstQuestion = asRecord(questions[0])?.question
    if (typeof firstQuestion === 'string' && firstQuestion.trim()) {
      return `question: ${truncateForUi(firstQuestion, 120)}`
    }
  }

  const knownKeys = ['path', 'file', 'files', 'command', 'description', 'pattern', 'query', 'url', 'repo', 'target']

  for (const key of knownKeys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return `${key}: ${value.trim().slice(0, 120)}`
    }

    if (Array.isArray(value) && value.length > 0) {
      const first = value[0]
      if (typeof first === 'string') {
        return `${key}: ${first.slice(0, 80)}${value.length > 1 ? ` (+${value.length - 1})` : ''}`
      }
    }
  }

  const keys = Object.keys(record)
  if (keys.length === 0) {
    return 'input'
  }

  return keys.slice(0, 3).join(', ')
}

function buildToolUseEntry(data: unknown): ToolUseEntry {
  const record = asRecord(data) ?? {}
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'Tool'
  const input = record.input
  const inputRecord = asRecord(input)
  const target = summarizeToolTarget(input)
  const description = typeof inputRecord?.description === 'string' ? truncateForUi(inputRecord.description, 140) : null

  return {
    id: createChatMessageId('tool'),
    toolUseId: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : null,
    kind: inferToolKind(name),
    name,
    target,
    status: 'running',
    detail: description,
    output: null,
    error: false
  }
}

function extractToolResultSummary(data: unknown): ToolResultSummary | null {
  const record = asRecord(data)
  if (!record) {
    return null
  }

  const text = typeof record.text === 'string' ? record.text : null
  const stdout = typeof record.stdout === 'string' ? record.stdout : null
  const stderr = typeof record.stderr === 'string' ? record.stderr : null
  const mergedText = [text, stdout, stderr]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')

  return {
    toolUseId: typeof record.tool_use_id === 'string' && record.tool_use_id.trim() ? record.tool_use_id.trim() : null,
    text: mergedText ? mergedText.slice(0, 1200) : null,
    isError: record.is_error === true
  }
}

function extractQuestionSummary(data: unknown): QuestionSummary | null {
  const record = asRecord(data)
  if (!record) {
    return null
  }

  const input = asRecord(record.input)
  const questionRows = Array.isArray(input?.questions) ? input.questions : []
  if (questionRows.length === 0) {
    return null
  }

  const firstQuestion = asRecord(questionRows[0])
  const text = typeof firstQuestion?.question === 'string' ? firstQuestion.question.trim() : ''
  const options = Array.isArray(firstQuestion?.options)
    ? firstQuestion.options
        .map((entry) => {
          const option = asRecord(entry)
          const label = option && typeof option.label === 'string' ? option.label.trim() : ''
          const description = option && typeof option.description === 'string' ? option.description.trim() : ''
          return {
            label,
            description: description || null
          }
        })
        .filter((option) => option.label.length > 0)
    : []

  return {
    text: text || null,
    options
  }
}

function extractPermissionSummary(data: unknown): PermissionSummary | null {
  const record = asRecord(data)
  if (!record) {
    return null
  }

  const denials = Array.isArray(record.denials) ? record.denials : []
  if (denials.length === 0) {
    return null
  }

  const commands: string[] = []
  const lines = denials
    .map((entry) => {
      const denial = asRecord(entry)
      if (!denial) {
        return null
      }

      const toolName =
        typeof denial.tool_name === 'string' && denial.tool_name.trim().length > 0 ? denial.tool_name.trim() : 'Tool'
      const input = asRecord(denial.tool_input)
      const command = typeof input?.command === 'string' ? input.command.trim() : ''
      const description = typeof input?.description === 'string' ? input.description.trim() : ''
      const detail = command || description || 'permission requested'
      if (command) {
        commands.push(command)
      }
      return `${toolName}: ${truncateForUi(detail, 180)}`
    })
    .filter((line): line is string => Boolean(line))

  if (lines.length === 0) {
    return null
  }

  return {
    message: `Permission required for:\n- ${lines.join('\n- ')}`,
    commands
  }
}

function normalizeSessionLabel(rawLabel: string | null | undefined, fallbackSessionId: string | null): string {
  if (rawLabel && rawLabel.trim()) {
    return rawLabel.trim().slice(0, 28)
  }

  if (fallbackSessionId) {
    return `Session ${fallbackSessionId.slice(0, 8)}`
  }

  return 'New topic'
}

function deriveTopicLabel(rawText: string | null | undefined, maxLength = 28): string | null {
  if (!rawText) {
    return null
  }

  const compacted = rawText.replace(/\s+/g, ' ').trim()
  if (!compacted || compacted.toLowerCase() === 'no prompt') {
    return null
  }

  const sentenceBoundary = compacted.search(/[.?!](?:\s|$)/)
  const sentence = sentenceBoundary > 0 ? compacted.slice(0, sentenceBoundary) : compacted
  const cleaned = sentence.replace(/^["'`([{]+|["'`)\]}]+$/g, '').trim()
  if (!cleaned) {
    return null
  }

  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned
}

function labelsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) {
    return false
  }

  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

function createNewTopicTab(label = 'New topic'): ChatTopicTab {
  return {
    id: createChatTabId('topic'),
    label,
    resumeSessionId: null,
    conversationUuid: null,
    kind: 'new'
  }
}

function buildLinkedChatTabs(
  chats: ChatReference[],
  closedConversationIds: Set<string>,
  workstreamName: string | null | undefined
): ChatTopicTab[] {
  const latestByConversation = new Map<string, ChatReference>()

  for (const chat of chats) {
    if (closedConversationIds.has(chat.conversation_uuid)) {
      continue
    }

    const existing = latestByConversation.get(chat.conversation_uuid)
    const chatTimestamp = chat.chat_timestamp ?? chat.linked_at
    const existingTimestamp = existing ? (existing.chat_timestamp ?? existing.linked_at) : -1

    if (!existing || chatTimestamp >= existingTimestamp) {
      latestByConversation.set(chat.conversation_uuid, chat)
    }
  }

  const sortedChats = Array.from(latestByConversation.values()).sort(
    (a, b) => (b.chat_timestamp ?? b.linked_at) - (a.chat_timestamp ?? a.linked_at)
  )
  const titleCounts = new Map<string, number>()

  for (const chat of sortedChats) {
    const title = deriveTopicLabel(chat.conversation_title)
    if (!title) {
      continue
    }

    const normalized = title.toLowerCase()
    titleCounts.set(normalized, (titleCounts.get(normalized) ?? 0) + 1)
  }

  return sortedChats.map((chat) => {
    const titleLabel = deriveTopicLabel(chat.conversation_title)
    const promptLabel = deriveTopicLabel(chat.last_user_message)
    const isDuplicateTitle = titleLabel ? (titleCounts.get(titleLabel.toLowerCase()) ?? 0) > 1 : false
    const isWorkstreamTitle = labelsMatch(titleLabel, workstreamName)
    const prefersPrompt = Boolean(promptLabel && (isDuplicateTitle || isWorkstreamTitle))
    const preferredLabel = prefersPrompt ? promptLabel : titleLabel ?? promptLabel

    return {
      id: `linked-${chat.conversation_uuid}`,
      label: normalizeSessionLabel(preferredLabel, chat.conversation_uuid),
      resumeSessionId: chat.conversation_uuid,
      conversationUuid: chat.conversation_uuid,
      kind: 'linked' as const
    }
  })
}

function buildHistoryMessages(messages: ClaudeConversationPreviewMessage[]): LiveChatMessage[] {
  const fallbackStart = Date.now() - messages.length * 1000

  return messages.map((message, index) => ({
    id: createChatMessageId('history'),
    role: message.role,
    text: message.text,
    createdAt: message.timestamp ?? fallbackStart + index * 1000
  }))
}

export function WorkstreamDetail({ workstreamId }: Props) {
  const [activeTab, setActiveTab] = useState<DetailTab>('info')

  const [contextUiError, setContextUiError] = useState<string | null>(null)
  const [contextInputSource, setContextInputSource] = useState<ContextDocSource>('obsidian')
  const [contextInputReference, setContextInputReference] = useState('')
  const [isPickingContextFile, setIsPickingContextFile] = useState(false)
  const [projectContextDocs, setProjectContextDocs] = useState<ContextDocInput[]>([])
  const [projectContextResolutions, setProjectContextResolutions] = useState<ResolveContextDocResult[]>([])
  const [projectContextLoaded, setProjectContextLoaded] = useState(false)
  const [contextDocsByTab, setContextDocsByTab] = useState<Record<string, ContextDocInput[]>>({})
  const [contextHydratedTabs, setContextHydratedTabs] = useState<Record<string, boolean>>({})

  const [runDirectoryDraft, setRunDirectoryDraft] = useState('')
  const [titleDraft, setTitleDraft] = useState('')
  const [priorityDraft, setPriorityDraft] = useState('')
  const [cadenceDraft, setCadenceDraft] = useState('')
  const [statusDraft, setStatusDraft] = useState<WorkstreamStatus>('active')
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [runDirectoryWarning, setRunDirectoryWarning] = useState<string | null>(null)

  const [chatInput, setChatInput] = useState('')
  const [chatMessagesByTab, setChatMessagesByTab] = useState<Record<string, LiveChatMessage[]>>({})
  const [isSendingChat, setIsSendingChat] = useState(false)
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null)
  const [chatSessionId, setChatSessionId] = useState<string | null>(null)
  const [chatProjectCwd, setChatProjectCwd] = useState<string | null>(null)
  const [chatSendErrorsByTab, setChatSendErrorsByTab] = useState<Record<string, string | null>>({})
  const [pendingQuestionsByTab, setPendingQuestionsByTab] = useState<Record<string, QuestionSummary | null>>({})
  const [pendingPermissionsByTab, setPendingPermissionsByTab] = useState<Record<string, PermissionSummary | null>>({})
  const [sessionPreferencesByConversation, setSessionPreferencesByConversation] = useState<Record<string, ChatSessionPreference>>({})
  const [sessionPreferenceLoadedByConversation, setSessionPreferenceLoadedByConversation] = useState<Record<string, boolean>>({})
  const [draftCommandModeByTab, setDraftCommandModeByTab] = useState<Record<string, ChatSessionCommandMode>>({})
  const [draftViewModeByTab, setDraftViewModeByTab] = useState<Record<string, ChatSessionViewMode>>({})
  const [terminalState, setTerminalState] = useState<TerminalSessionState>(DEFAULT_TERMINAL_SESSION_STATE)
  const [terminalOutputByConversation, setTerminalOutputByConversation] = useState<Record<string, string>>({})
  const [terminalErrorsByTab, setTerminalErrorsByTab] = useState<Record<string, string | null>>({})

  const [chatTabs, setChatTabs] = useState<ChatTopicTab[]>([])
  const [activeChatTabId, setActiveChatTabId] = useState<string | null>(null)
  const [closedConversationIds, setClosedConversationIds] = useState<string[]>([])
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<string[]>([])
  const [showLinkedSessionsPanel, setShowLinkedSessionsPanel] = useState(false)
  const [expandedLinkedConversationId, setExpandedLinkedConversationId] = useState<string | null>(null)
  const [conversationPreviews, setConversationPreviews] = useState<Record<string, ConversationPreviewState>>({})
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameTabDraft, setRenameTabDraft] = useState('')
  const [newTopicCount, setNewTopicCount] = useState(1)

  const activeAssistantMessageIdRef = useRef<string | null>(null)
  const activeStreamIdRef = useRef<string | null>(null)
  const activeChatTabIdRef = useRef<string | null>(null)
  const activeMessageTabIdRef = useRef<string | null>(null)
  const streamTabLookupRef = useRef<Record<string, string>>({})
  const pendingTerminalStartTabIdRef = useRef<string | null>(null)
  const contextDocsByTabRef = useRef<Record<string, ContextDocInput[]>>({})
  const projectContextDocsRef = useRef<ContextDocInput[]>([])
  const workstreamIdRef = useRef<number | null>(workstreamId)
  const isSendingChatRef = useRef(false)

  const chatFeedRef = useRef<HTMLDivElement | null>(null)
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null)

  const detailQuery = useWorkstreamDetail(workstreamId)
  const sourceQuery = useSyncSource()
  const diagnosticsQuery = useSyncDiagnostics()
  const conversationsQuery = useConversations()
  const linkedConversationUuidsQuery = useLinkedConversationUuids()
  const chatSessionQuery = useWorkstreamChatSession(workstreamId)
  const runSyncMutation = useRunSync()
  const linkMutation = useLinkConversation()
  const unlinkMutation = useUnlinkConversation()
  const updateSettingsMutation = useUpdateWorkstream()

  const detail = detailQuery.data
  const sourceId = sourceQuery.data?.id ?? null
  const sourcePath = sourceQuery.data ? parseSourcePath(sourceQuery.data.config) : ''

  const latestChat = useMemo(() => {
    if (!detail || detail.chats.length === 0) {
      return null
    }

    return detail.chats.reduce((latest, current) => {
      const latestTimestamp = latest.chat_timestamp ?? latest.linked_at
      const currentTimestamp = current.chat_timestamp ?? current.linked_at
      return currentTimestamp > latestTimestamp ? current : latest
    })
  }, [detail])

  const linkedConversationIds = useMemo(() => new Set((detail?.chats ?? []).map((chat) => chat.conversation_uuid)), [detail?.chats])
  const globallyLinkedConversationIds = useMemo(
    () => new Set(linkedConversationUuidsQuery.data ?? []),
    [linkedConversationUuidsQuery.data]
  )

  const suggestedConversations = useMemo(() => {
    const cutoffTimestamp = Date.now() - SUGGESTION_MAX_AGE_MS
    const dismissedSet = new Set(dismissedSuggestionIds)
    return (conversationsQuery.data ?? [])
      .filter((conversation) => !dismissedSet.has(conversation.conversation_uuid))
      .filter((conversation) => !linkedConversationIds.has(conversation.conversation_uuid))
      .filter((conversation) => !globallyLinkedConversationIds.has(conversation.conversation_uuid))
      .filter((conversation) => conversation.chat_timestamp !== null && conversation.chat_timestamp >= cutoffTimestamp)
      .slice(0, 5)
  }, [conversationsQuery.data, linkedConversationIds, globallyLinkedConversationIds, dismissedSuggestionIds])

  const nextActionText = detail?.workstream.next_action?.trim() || null
  const nextActionSource = nextActionText ? 'Source: workstream next_action' : 'Source: none'

  const legacyObsidianContextDocs = useMemo(
    () => extractLegacyObsidianContextDocs(detail?.workstream.notes),
    [detail?.workstream.notes]
  )

  const activeChatTab = useMemo(() => {
    if (!activeChatTabId) {
      return null
    }

    return chatTabs.find((tab) => tab.id === activeChatTabId) ?? null
  }, [chatTabs, activeChatTabId])

  const activeChatMessages = useMemo(() => {
    if (!activeChatTabId) {
      return []
    }

    return chatMessagesByTab[activeChatTabId] ?? []
  }, [chatMessagesByTab, activeChatTabId])
  const activeChatConversationId = activeChatTab?.conversationUuid ?? activeChatTab?.resumeSessionId ?? null
  const activeSessionPreference = activeChatConversationId ? (sessionPreferencesByConversation[activeChatConversationId] ?? null) : null
  const activeCommandMode =
    activeSessionPreference?.command_mode ??
    (activeChatTabId ? (draftCommandModeByTab[activeChatTabId] ?? DEFAULT_CHAT_SESSION_COMMAND_MODE) : DEFAULT_CHAT_SESSION_COMMAND_MODE)
  const activeViewMode =
    activeSessionPreference?.view_mode ??
    (activeChatTabId ? (draftViewModeByTab[activeChatTabId] ?? DEFAULT_CHAT_SESSION_VIEW_MODE) : DEFAULT_CHAT_SESSION_VIEW_MODE)
  const isTerminalActiveForActiveConversation = Boolean(
    terminalState.is_active &&
      activeChatConversationId &&
      terminalState.conversation_uuid &&
      terminalState.conversation_uuid === activeChatConversationId
  )
  const terminalConversationId = terminalState.conversation_uuid
  const activeTerminalOutput = activeChatConversationId ? (terminalOutputByConversation[activeChatConversationId] ?? '') : ''
  const activeTerminalError = activeChatTabId ? (terminalErrorsByTab[activeChatTabId] ?? null) : null
  const activeConversationPreview = activeChatConversationId ? conversationPreviews[activeChatConversationId] : undefined
  const isActiveChatHistoryLoading = activeChatMessages.length === 0 && activeConversationPreview?.status === 'loading'
  const activeChatHistoryError = activeChatMessages.length === 0 && activeConversationPreview?.status === 'error' ? activeConversationPreview.error : null
  const activeChatSendError = activeChatTabId ? (chatSendErrorsByTab[activeChatTabId] ?? null) : null
  const activePendingQuestion = activeChatTabId ? (pendingQuestionsByTab[activeChatTabId] ?? null) : null
  const activePendingPermission = activeChatTabId ? (pendingPermissionsByTab[activeChatTabId] ?? null) : null
  const projectContextResolutionByKey = useMemo(
    () => new Map(projectContextResolutions.map((entry) => [entry.normalized_reference, entry])),
    [projectContextResolutions]
  )
  const activeContextDocs = activeChatTabId ? (contextDocsByTab[activeChatTabId] ?? projectContextDocs) : projectContextDocs
  const activeContextKeySet = useMemo(
    () => new Set(activeContextDocs.map((doc) => normalizeContextDocKey(doc))),
    [activeContextDocs]
  )
  const projectContextWarnings = useMemo(
    () => projectContextResolutions.map((entry) => entry.warning).filter((warning): warning is string => Boolean(warning)),
    [projectContextResolutions]
  )
  const activeTabLinkedChats = useMemo(() => {
    if (!detail || !activeChatConversationId) {
      return []
    }

    return detail.chats.filter((chat) => chat.conversation_uuid === activeChatConversationId)
  }, [detail, activeChatConversationId])
  const linkedSessionEmptyMessage = activeChatConversationId
    ? 'No linked session found for this topic.'
    : 'This topic is not linked to a session yet.'
  const visibleSessionId = activeChatTab?.resumeSessionId ?? null
  const hasChatActivity = activeChatMessages.length > 0

  const score = detail?.workstream.score
  const priorityPercent = score ? Math.min(100, Math.max(0, (score.priority_score / 5) * 100)) : 0
  const stalenessPercent = score ? Math.min(100, Math.max(0, score.staleness_ratio * 100)) : 0
  const blockedPercent = score ? Math.min(100, Math.max(0, Math.abs(Math.min(0, score.blocked_penalty)) * 20)) : 0
  const stalenessBasisLabel =
    score?.staleness_basis === 'chat'
      ? 'chat activity'
      : score?.staleness_basis === 'session'
        ? 'session activity'
        : score?.staleness_basis === 'created'
          ? 'created'
          : 'progress'
  const stalenessReferenceAt = score?.staleness_reference_at ?? detail?.workstream.created_at ?? null

  function setChatErrorForTab(tabId: string, error: string | null) {
    setChatSendErrorsByTab((previous) => {
      const current = previous[tabId] ?? null
      if (current === error) {
        return previous
      }

      if (error === null) {
        if (!(tabId in previous)) {
          return previous
        }

        const next = { ...previous }
        delete next[tabId]
        return next
      }

      return {
        ...previous,
        [tabId]: error
      }
    })
  }

  function setTerminalErrorForTab(tabId: string, error: string | null) {
    setTerminalErrorsByTab((previous) => {
      const current = previous[tabId] ?? null
      if (current === error) {
        return previous
      }

      if (error === null) {
        if (!(tabId in previous)) {
          return previous
        }

        const next = { ...previous }
        delete next[tabId]
        return next
      }

      return {
        ...previous,
        [tabId]: error
      }
    })
  }

  function appendSystemMessage(tabId: string, text: string, error = false) {
    const compact = text.trim()
    if (!compact) {
      return
    }

    setChatMessagesByTab((previous) => ({
      ...previous,
      [tabId]: [
        ...(previous[tabId] ?? []),
        {
          id: createChatMessageId('system'),
          role: 'system',
          text: compact,
          error,
          createdAt: Date.now()
        }
      ]
    }))
  }

  function setPendingQuestionForTab(tabId: string, question: QuestionSummary | null) {
    setPendingQuestionsByTab((previous) => {
      const current = previous[tabId] ?? null
      if (current === question) {
        return previous
      }

      if (question === null) {
        if (!(tabId in previous)) {
          return previous
        }

        const next = { ...previous }
        delete next[tabId]
        return next
      }

      return {
        ...previous,
        [tabId]: question
      }
    })
  }

  function setPendingPermissionForTab(tabId: string, permission: PermissionSummary | null) {
    setPendingPermissionsByTab((previous) => {
      const current = previous[tabId] ?? null
      if (current === permission) {
        return previous
      }

      if (permission === null) {
        if (!(tabId in previous)) {
          return previous
        }

        const next = { ...previous }
        delete next[tabId]
        return next
      }

      return {
        ...previous,
        [tabId]: permission
      }
    })
  }

  async function refreshProjectContextResolutions(docs: ContextDocInput[]) {
    if (docs.length === 0) {
      setProjectContextResolutions([])
      return
    }

    try {
      const resolutions = await chatApi.resolveContextDocs(docs)
      setProjectContextResolutions(resolutions)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not resolve context documents'
      setContextUiError(message)
    }
  }

  function setProjectContext(docs: ContextDocInput[], resolutions?: ResolveContextDocResult[]) {
    setProjectContextDocs(docs)
    if (resolutions) {
      setProjectContextResolutions(resolutions)
      return
    }

    void refreshProjectContextResolutions(docs)
  }

  function setContextDocsForTab(tabId: string, docs: ContextDocInput[]) {
    setContextDocsByTab((previous) => ({
      ...previous,
      [tabId]: docs
    }))
  }

  function promoteActiveTabWithSession(sessionId: string) {
    const normalized = sessionId.trim()
    if (!normalized) {
      return
    }

    setChatTabs((tabs) => {
      const activeId = activeChatTabIdRef.current
      if (!activeId) {
        if (tabs.some((tab) => tab.resumeSessionId === normalized)) {
          return tabs
        }

        const newTab: ChatTopicTab = {
          id: `session-${normalized}`,
          label: normalizeSessionLabel(null, normalized),
          resumeSessionId: normalized,
          conversationUuid: normalized,
          kind: 'session'
        }

        setActiveChatTabId(newTab.id)
        return [newTab, ...tabs]
      }

      let updated = false
      const nextTabs = tabs.map((tab) => {
        if (tab.id !== activeId || tab.resumeSessionId) {
          return tab
        }

        updated = true
        return {
          ...tab,
          label: normalizeSessionLabel(tab.label, normalized),
          resumeSessionId: normalized,
          conversationUuid: normalized,
          kind: 'session' as const
        }
      })

      if (updated) {
        return nextTabs
      }

      if (nextTabs.some((tab) => tab.resumeSessionId === normalized)) {
        return nextTabs
      }

      const insertedTab: ChatTopicTab = {
        id: `session-${normalized}`,
        label: normalizeSessionLabel(null, normalized),
        resumeSessionId: normalized,
        conversationUuid: normalized,
        kind: 'session'
      }

      setActiveChatTabId(insertedTab.id)
      return [insertedTab, ...nextTabs]
    })
  }

  function focusChatInput() {
    window.setTimeout(() => {
      chatInputRef.current?.focus()
    }, 0)
  }

  useEffect(() => {
    activeChatTabIdRef.current = activeChatTabId
  }, [activeChatTabId])

  useEffect(() => {
    isSendingChatRef.current = isSendingChat
  }, [isSendingChat])

  useEffect(() => {
    contextDocsByTabRef.current = contextDocsByTab
  }, [contextDocsByTab])

  useEffect(() => {
    projectContextDocsRef.current = projectContextDocs
  }, [projectContextDocs])

  useEffect(() => {
    workstreamIdRef.current = workstreamId
  }, [workstreamId])

  useEffect(() => {
    if (!detail) {
      return
    }

    const nextRunDirectory = detail.workstream.chat_run_directory ?? ''
    setTitleDraft(detail.workstream.name)
    setRunDirectoryDraft(nextRunDirectory)
    setPriorityDraft(String(detail.workstream.priority))
    setCadenceDraft(String(detail.workstream.target_cadence_days))
    setStatusDraft(detail.workstream.status)
    setRunDirectoryWarning(
      nextRunDirectory && isOutsidePreferredRunRoots(nextRunDirectory)
        ? `Outside preferred roots (${RUN_DIRECTORY_PREFERRED_ROOTS.join(', ')}). This is allowed, but double-check it.`
        : null
    )
  }, [
    detail?.workstream.id,
    detail?.workstream.chat_run_directory,
    detail?.workstream.name,
    detail?.workstream.priority,
    detail?.workstream.target_cadence_days,
    detail?.workstream.status
  ])

  useEffect(() => {
    setActiveTab('info')
    setContextUiError(null)
    setContextInputSource('obsidian')
    setContextInputReference('')
    setIsPickingContextFile(false)
    setProjectContextDocs([])
    setProjectContextResolutions([])
    setProjectContextLoaded(false)
    setContextDocsByTab({})
    setContextHydratedTabs({})
    setChatMessagesByTab({})
    setChatInput('')
    setChatSendErrorsByTab({})
    setPendingQuestionsByTab({})
    setPendingPermissionsByTab({})
    setSessionPreferencesByConversation({})
    setSessionPreferenceLoadedByConversation({})
    setDraftCommandModeByTab({})
    setDraftViewModeByTab({})
    setTerminalState(DEFAULT_TERMINAL_SESSION_STATE)
    setTerminalOutputByConversation({})
    setTerminalErrorsByTab({})
    setIsSendingChat(false)
    setActiveStreamId(null)
    setChatSessionId(null)
    setChatProjectCwd(null)
    setChatTabs([])
    setActiveChatTabId(null)
    setClosedConversationIds([])
    setDismissedSuggestionIds([])
    setShowLinkedSessionsPanel(false)
    setExpandedLinkedConversationId(null)
    setConversationPreviews({})
    setRenamingTabId(null)
    setRenameTabDraft('')
    setNewTopicCount(1)

    activeStreamIdRef.current = null
    activeAssistantMessageIdRef.current = null
    activeChatTabIdRef.current = null
    activeMessageTabIdRef.current = null
    streamTabLookupRef.current = {}
    pendingTerminalStartTabIdRef.current = null
    isSendingChatRef.current = false
  }, [workstreamId])

  useEffect(() => {
    if (!chatSessionQuery.data) {
      setChatSessionId(null)
      setChatProjectCwd(null)
      return
    }

    setChatSessionId(chatSessionQuery.data.session_id)
    setChatProjectCwd(chatSessionQuery.data.project_cwd)
  }, [chatSessionQuery.data])

  useEffect(() => {
    let cancelled = false

    void chatApi
      .getTerminalSessionState()
      .then((state) => {
        if (!cancelled) {
          setTerminalState(state)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTerminalState(DEFAULT_TERMINAL_SESSION_STATE)
        }
      })

    return () => {
      cancelled = true
    }
  }, [workstreamId])

  useEffect(() => {
    if (workstreamId === null) {
      setProjectContext([])
      setProjectContextLoaded(true)
      return
    }

    let cancelled = false
    setProjectContextLoaded(false)

    void chatApi
      .getWorkstreamContext(workstreamId)
      .then((docs) => {
        if (cancelled) {
          return
        }

        setProjectContext(
          mapStoredContextDocsToInputs(docs),
          docs.map((doc) => mapStoredContextDoc(doc))
        )
        setProjectContextLoaded(true)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }

        const message = error instanceof Error ? error.message : 'Failed to load project context'
        setContextUiError(message)
        setProjectContext([], [])
        setProjectContextLoaded(true)
      })

    return () => {
      cancelled = true
    }
  }, [workstreamId])

  useEffect(() => {
    if (!detail) {
      return
    }

    const linkedTabs = buildLinkedChatTabs(detail.chats, new Set(closedConversationIds), detail.workstream.name)

    setChatTabs((previous) => {
      const localTabs = previous.filter((tab) => tab.kind !== 'linked')
      const seenSessionIds = new Set<string>()
      const dedupedLocalTabs: ChatTopicTab[] = []

      for (const localTab of localTabs) {
        if (localTab.resumeSessionId) {
          if (seenSessionIds.has(localTab.resumeSessionId)) {
            continue
          }
          seenSessionIds.add(localTab.resumeSessionId)
        }

        dedupedLocalTabs.push(localTab)
      }

      const tabsWithDefaultNew =
        dedupedLocalTabs.some((tab) => tab.kind === 'new' && tab.resumeSessionId === null)
          ? dedupedLocalTabs
          : [createNewTopicTab(), ...dedupedLocalTabs]

      const mergedTabs: ChatTopicTab[] = [...tabsWithDefaultNew]

      for (const linkedTab of linkedTabs) {
        if (linkedTab.resumeSessionId && mergedTabs.some((tab) => tab.resumeSessionId === linkedTab.resumeSessionId)) {
          continue
        }

        mergedTabs.push(linkedTab)
      }

      return mergedTabs
    })
  }, [detail, closedConversationIds])

  useEffect(() => {
    if (!renamingTabId) {
      return
    }

    if (!chatTabs.some((tab) => tab.id === renamingTabId)) {
      setRenamingTabId(null)
      setRenameTabDraft('')
    }
  }, [chatTabs, renamingTabId])

  useEffect(() => {
    if (chatTabs.length === 0) {
      setActiveChatTabId(null)
      return
    }

    if (!activeChatTabId || !chatTabs.some((tab) => tab.id === activeChatTabId)) {
      setActiveChatTabId(chatTabs[0].id)
    }
  }, [chatTabs, activeChatTabId])

  useEffect(() => {
    const validTabIds = new Set(chatTabs.map((tab) => tab.id))
    const hasSameKeys = <T,>(current: Record<string, T>, next: Record<string, T>): boolean => {
      const currentKeys = Object.keys(current)
      const nextKeys = Object.keys(next)
      if (currentKeys.length !== nextKeys.length) {
        return false
      }

      return nextKeys.every((key) => key in current)
    }

    const pruneRecordByTab = <T,>(record: Record<string, T>): Record<string, T> => {
      const next: Record<string, T> = {}
      for (const [tabId, value] of Object.entries(record)) {
        if (validTabIds.has(tabId)) {
          next[tabId] = value
        }
      }
      return next
    }

    setChatMessagesByTab((previous) => {
      const next = pruneRecordByTab(previous)
      return hasSameKeys(previous, next) ? previous : next
    })

    setChatSendErrorsByTab((previous) => {
      const next = pruneRecordByTab(previous)
      return hasSameKeys(previous, next) ? previous : next
    })

    setPendingQuestionsByTab((previous) => {
      const next = pruneRecordByTab(previous)
      return hasSameKeys(previous, next) ? previous : next
    })

    setPendingPermissionsByTab((previous) => {
      const next = pruneRecordByTab(previous)
      return hasSameKeys(previous, next) ? previous : next
    })

    setTerminalErrorsByTab((previous) => {
      const next = pruneRecordByTab(previous)
      return hasSameKeys(previous, next) ? previous : next
    })

    setDraftCommandModeByTab((previous) => {
      const next = pruneRecordByTab(previous)
      return hasSameKeys(previous, next) ? previous : next
    })

    setDraftViewModeByTab((previous) => {
      const next = pruneRecordByTab(previous)
      return hasSameKeys(previous, next) ? previous : next
    })

    setContextDocsByTab((previous) => {
      const next = pruneRecordByTab(previous)
      return hasSameKeys(previous, next) ? previous : next
    })

    setContextHydratedTabs((previous) => {
      const next = pruneRecordByTab(previous)
      return hasSameKeys(previous, next) ? previous : next
    })
  }, [chatTabs])

  useEffect(() => {
    if (!activeChatTabId || !activeChatConversationId || activeChatMessages.length > 0) {
      return
    }

    const existing = conversationPreviews[activeChatConversationId]
    if (existing?.status === 'ready') {
      if (existing.messages.length === 0) {
        return
      }

      setChatMessagesByTab((previous) => {
        if ((previous[activeChatTabId]?.length ?? 0) > 0) {
          return previous
        }

        return {
          ...previous,
          [activeChatTabId]: buildHistoryMessages(existing.messages)
        }
      })
      return
    }

    if (existing?.status === 'loading') {
      return
    }

    setConversationPreviews((previous) => ({
      ...previous,
      [activeChatConversationId]: {
        status: 'loading',
        messages: [],
        error: null
      }
    }))

    let cancelled = false

    void chatApi
      .getConversationPreview(activeChatConversationId, 4)
      .then((messages) => {
        if (cancelled) {
          return
        }

        setConversationPreviews((previous) => ({
          ...previous,
          [activeChatConversationId]: {
            status: 'ready',
            messages,
            error: null
          }
        }))

        if (messages.length === 0) {
          return
        }

        setChatMessagesByTab((previous) => {
          if ((previous[activeChatTabId]?.length ?? 0) > 0) {
            return previous
          }

          return {
            ...previous,
            [activeChatTabId]: buildHistoryMessages(messages)
          }
        })
      })
      .catch((error) => {
        if (cancelled) {
          return
        }

        const errorMessage = error instanceof Error ? error.message : 'Failed to load conversation preview'
        setConversationPreviews((previous) => ({
          ...previous,
          [activeChatConversationId]: {
            status: 'error',
            messages: [],
            error: errorMessage
          }
        }))
      })

    return () => {
      cancelled = true
    }
  }, [activeChatTabId, activeChatConversationId, activeChatMessages.length])

  useEffect(() => {
    if (!projectContextLoaded || !activeChatTabId || !activeChatTab || contextHydratedTabs[activeChatTabId]) {
      return
    }

    let cancelled = false

    const tabId = activeChatTabId
    const resumeSessionId = activeChatTab.resumeSessionId

    if (!resumeSessionId || workstreamId === null) {
      setContextDocsForTab(tabId, projectContextDocs)
      setContextHydratedTabs((previous) => ({
        ...previous,
        [tabId]: true
      }))
      return
    }

    void chatApi
      .getSessionContext(workstreamId, resumeSessionId)
      .then((docs) => {
        if (cancelled) {
          return
        }

        const mappedDocs: ContextDocInput[] = docs.map((doc) => ({
          source: doc.source,
          reference: doc.reference
        }))

        const projectKeys = new Set(projectContextDocs.map((doc) => normalizeContextDocKey(doc)))
        const missingProjectDocs = mappedDocs.filter((doc) => !projectKeys.has(normalizeContextDocKey(doc)))
        if (missingProjectDocs.length > 0) {
          const mergedProjectDocs = [...projectContextDocs]
          for (const doc of missingProjectDocs) {
            if (mergedProjectDocs.some((entry) => normalizeContextDocKey(entry) === normalizeContextDocKey(doc))) {
              continue
            }
            mergedProjectDocs.push(doc)
          }
          setProjectContext(mergedProjectDocs)
          void persistProjectContext(workstreamId, mergedProjectDocs)
        }

        setContextDocsForTab(tabId, mappedDocs.length > 0 ? mappedDocs : projectContextDocs)
        setContextHydratedTabs((previous) => ({
          ...previous,
          [tabId]: true
        }))
      })
      .catch((error) => {
        if (cancelled) {
          return
        }

        const message = error instanceof Error ? error.message : 'Failed to load session context'
        setContextUiError(message)
        setContextHydratedTabs((previous) => ({
          ...previous,
          [tabId]: true
        }))
      })

    return () => {
      cancelled = true
    }
  }, [
    activeChatTab,
    activeChatTabId,
    contextHydratedTabs,
    projectContextDocs,
    projectContextLoaded,
    workstreamId
  ])

  useEffect(() => {
    if (!activeChatConversationId) {
      return
    }

    if (sessionPreferenceLoadedByConversation[activeChatConversationId]) {
      return
    }

    let cancelled = false

    void chatApi
      .getSessionPreference(activeChatConversationId)
      .then((preference) => {
        if (cancelled) {
          return
        }

        if (preference) {
          setSessionPreferencesByConversation((previous) => ({
            ...previous,
            [preference.conversation_uuid]: preference
          }))
        }

        setSessionPreferenceLoadedByConversation((previous) => ({
          ...previous,
          [activeChatConversationId]: true
        }))
      })
      .catch((error) => {
        if (cancelled) {
          return
        }

        const message = error instanceof Error ? error.message : 'Failed to load session preference'
        if (activeChatTabIdRef.current) {
          setTerminalErrorForTab(activeChatTabIdRef.current, message)
        }

        setSessionPreferenceLoadedByConversation((previous) => ({
          ...previous,
          [activeChatConversationId]: true
        }))
      })

    return () => {
      cancelled = true
    }
  }, [activeChatConversationId, sessionPreferenceLoadedByConversation])

  useEffect(() => {
    let cancelled = false

    void chatApi
      .getTerminalSessionState()
      .then((state) => {
        if (!cancelled) {
          setTerminalState(state)
          if (state.conversation_uuid) {
            setChatSessionId(state.conversation_uuid)
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTerminalState(DEFAULT_TERMINAL_SESSION_STATE)
        }
      })

    const unsubscribe = chatApi.onTerminalEvent((event: TerminalEvent) => {
      if (event.type === 'output' && event.conversation_uuid && event.output) {
        setTerminalOutputByConversation((previous) => ({
          ...previous,
          [event.conversation_uuid as string]: `${previous[event.conversation_uuid as string] ?? ''}${event.output}`
        }))
      }

      if ((event.type === 'started' || event.type === 'stopped' || event.type === 'exit') && event.state) {
        setTerminalState(event.state)
      }

      if (event.type === 'started' && event.conversation_uuid) {
        setChatSessionId(event.conversation_uuid)
        promoteActiveTabWithSession(event.conversation_uuid)

        const pendingTabId = pendingTerminalStartTabIdRef.current ?? activeChatTabIdRef.current
        if (pendingTabId) {
          const currentWorkstreamId = workstreamIdRef.current
          if (currentWorkstreamId !== null) {
            const docs = contextDocsByTabRef.current[pendingTabId] ?? projectContextDocsRef.current
            void persistContextForSession(currentWorkstreamId, event.conversation_uuid, docs)
          }
        }

        pendingTerminalStartTabIdRef.current = null
      }

      if (event.type === 'error' && event.message) {
        const targetTabId = pendingTerminalStartTabIdRef.current ?? activeChatTabIdRef.current
        if (targetTabId) {
          setTerminalErrorForTab(targetTabId, event.message)
        }
      }

      if (event.type === 'stopped' || event.type === 'exit') {
        pendingTerminalStartTabIdRef.current = null
        void detailQuery.refetch()
        void conversationsQuery.refetch()
        void chatSessionQuery.refetch()
      }
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const unsubscribe = chatApi.onStreamEvent((streamEvent) => {
      const activeStream = activeStreamIdRef.current
      if (activeStream && streamEvent.stream_id !== activeStream) {
        return
      }

      if (!activeStream) {
        if (!isSendingChatRef.current) {
          return
        }

        activeStreamIdRef.current = streamEvent.stream_id
        setActiveStreamId(streamEvent.stream_id)

        if (activeMessageTabIdRef.current) {
          streamTabLookupRef.current[streamEvent.stream_id] = activeMessageTabIdRef.current
        }
      }

      const targetTabId = streamTabLookupRef.current[streamEvent.stream_id] ?? activeMessageTabIdRef.current
      if (!targetTabId) {
        return
      }

      if (streamEvent.session_id) {
        setChatSessionId(streamEvent.session_id)
        promoteActiveTabWithSession(streamEvent.session_id)
      }

      const streamCwd = getChatInitCwd(streamEvent)
      if (streamCwd) {
        setChatProjectCwd(streamCwd)
      }

      if (streamEvent.type === 'tool_use' && activeAssistantMessageIdRef.current) {
        const assistantId = activeAssistantMessageIdRef.current
        const toolUse = buildToolUseEntry(streamEvent.data)
        setChatMessagesByTab((previous) => {
          const messages = previous[targetTabId]
          if (!messages || messages.length === 0) {
            return previous
          }

          return {
            ...previous,
            [targetTabId]: messages.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    toolUses:
                      toolUse.toolUseId && (message.toolUses ?? []).some((entry) => entry.toolUseId === toolUse.toolUseId)
                        ? (message.toolUses ?? []).map((entry) =>
                            entry.toolUseId === toolUse.toolUseId ? { ...entry, ...toolUse, status: entry.status } : entry
                          )
                        : [...(message.toolUses ?? []), toolUse]
                  }
                : message
            )
          }
        })
      }

      if (streamEvent.type === 'tool_result') {
        const summary = extractToolResultSummary(streamEvent.data)
        if (summary) {
          let matchedToolName: string | null = null
          let matchedToolTarget: string | null = null

          if (activeAssistantMessageIdRef.current) {
            const assistantId = activeAssistantMessageIdRef.current
            setChatMessagesByTab((previous) => {
              const messages = previous[targetTabId]
              if (!messages || messages.length === 0) {
                return previous
              }

              let didUpdate = false
              const nextMessages = messages.map((message) => {
                if (message.id !== assistantId || !message.toolUses || message.toolUses.length === 0) {
                  return message
                }

                const nextToolUses: ToolUseEntry[] = message.toolUses.map((toolUse): ToolUseEntry => {
                  const matchesById = Boolean(summary.toolUseId && toolUse.toolUseId === summary.toolUseId)
                  if (!matchesById) {
                    return toolUse
                  }

                  didUpdate = true
                  matchedToolName = toolUse.name
                  matchedToolTarget = toolUse.target
                  return {
                    ...toolUse,
                    status: 'done' as const,
                    output: summary.text ?? toolUse.output ?? null,
                    error: summary.isError
                  }
                })

                return didUpdate ? { ...message, toolUses: nextToolUses } : message
              })

              if (!didUpdate) {
                return previous
              }

              return {
                ...previous,
                [targetTabId]: nextMessages
              }
            })
          }

          if (summary.text) {
            const header =
              matchedToolName && matchedToolTarget ? `${matchedToolName} (${matchedToolTarget})` : 'Tool output'
            appendSystemMessage(targetTabId, `${header}\n${summary.text}`, summary.isError)
          }

          if (summary.isError) {
            setChatErrorForTab(targetTabId, summary.text ?? 'Tool execution returned an error')
          }
        }
      }

      if (streamEvent.type === 'question') {
        const question = extractQuestionSummary(streamEvent.data)
        if (question?.text) {
          const optionsText = question.options.length > 0 ? `\nOptions: ${question.options.map((option) => option.label).join(' | ')}` : ''
          appendSystemMessage(targetTabId, `Claude needs input:\n${question.text}${optionsText}`, true)
          setPendingQuestionForTab(targetTabId, question)
          setChatErrorForTab(targetTabId, question.text)
        }
      }

      if (streamEvent.type === 'permission') {
        const permission = extractPermissionSummary(streamEvent.data)
        if (permission) {
          appendSystemMessage(targetTabId, permission.message, true)
          setPendingPermissionForTab(targetTabId, permission)
          setChatErrorForTab(targetTabId, permission.message)
        }
      }

      if (streamEvent.type === 'token' && streamEvent.text && activeAssistantMessageIdRef.current) {
        const assistantId = activeAssistantMessageIdRef.current
        const tokenText = streamEvent.text
        setChatMessagesByTab((previous) => {
          const messages = previous[targetTabId]
          if (!messages || messages.length === 0) {
            return previous
          }

          return {
            ...previous,
            [targetTabId]: messages.map((message) =>
              message.id === assistantId ? { ...message, text: `${message.text}${tokenText}` } : message
            )
          }
        })
      }

      if (streamEvent.type === 'assistant' && streamEvent.text && activeAssistantMessageIdRef.current) {
        const assistantId = activeAssistantMessageIdRef.current
        const assistantText = streamEvent.text
        setChatMessagesByTab((previous) => {
          const messages = previous[targetTabId]
          if (!messages || messages.length === 0) {
            return previous
          }

          return {
            ...previous,
            [targetTabId]: messages.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    text: message.text.trim() ? message.text : assistantText
                  }
                : message
            )
          }
        })
      }

      if (streamEvent.type === 'error' && streamEvent.error) {
        setChatErrorForTab(targetTabId, streamEvent.error)
      }

      if (streamEvent.type === 'done') {
        setIsSendingChat(false)
        setActiveStreamId(null)
        activeStreamIdRef.current = null
        delete streamTabLookupRef.current[streamEvent.stream_id]

        if (activeAssistantMessageIdRef.current) {
          const assistantId = activeAssistantMessageIdRef.current
          setChatMessagesByTab((previous) => {
            const messages = previous[targetTabId]
            if (!messages || messages.length === 0) {
              return previous
            }

            return {
              ...previous,
              [targetTabId]: messages.map((message) =>
                message.id === assistantId
                  ? {
                      ...message,
                      streaming: false,
                      toolUses: message.toolUses?.map((toolUse) => ({ ...toolUse, status: 'done' }))
                    }
                  : message
              )
            }
          })
          activeAssistantMessageIdRef.current = null
        }

        activeMessageTabIdRef.current = null
      }
    })

    return unsubscribe
  }, [])

  useEffect(() => {
    if (!chatFeedRef.current) {
      return
    }

    chatFeedRef.current.scrollTop = chatFeedRef.current.scrollHeight
  }, [activeChatMessages])

  if (workstreamId === null) {
    return (
      <section className="detail-pane empty-detail">
        <div className="detail-empty-card">
          <h2>Select a workstream</h2>
          <p>Pick a ranked workstream to inspect context and continue chat execution.</p>
        </div>
      </section>
    )
  }

  if (detailQuery.isLoading) {
    return (
      <section className="detail-pane empty-detail">
        <div className="detail-empty-card">
          <p>Loading workstream details...</p>
        </div>
      </section>
    )
  }

  if (!detail) {
    return (
      <section className="detail-pane empty-detail">
        <div className="detail-empty-card">
          <p>Workstream not found.</p>
        </div>
      </section>
    )
  }

  async function handleLinkConversation(conversationUuid: string) {
    if (workstreamId === null) {
      return
    }

    await linkMutation.mutateAsync({ workstreamId, conversationUuid })
    setDismissedSuggestionIds((ids) => ids.filter((id) => id !== conversationUuid))
  }

  async function handleUnlink(conversationUuid: string) {
    if (workstreamId === null) {
      return
    }

    await unlinkMutation.mutateAsync({ workstreamId, conversationUuid })
  }

  async function handleRunSync() {
    if (!sourceId) {
      return
    }

    await runSyncMutation.mutateAsync(sourceId)
  }

  async function handleOpenObsidianNote(noteRef: string) {
    setContextUiError(null)
    const result = await appApi.openObsidianNote(noteRef)
    if (!result.ok) {
      setContextUiError(result.error ?? `Could not open [[${noteRef}]]`)
    }
  }

  async function handleSaveWorkstreamSettings() {
    if (!detail || updateSettingsMutation.isPending) {
      return
    }

    const nextTitle = titleDraft.trim()
    const nextRunDirectory = runDirectoryDraft.trim() ? runDirectoryDraft.trim() : null
    const parsedPriority = Number(priorityDraft)
    const parsedCadence = Number(cadenceDraft)
    const nextStatus = statusDraft
    const nextPriority = Math.round(parsedPriority)
    const nextCadence = Math.round(parsedCadence)

    if (!nextTitle) {
      setSettingsError('Title must not be empty.')
      setSettingsSaved(false)
      return
    }

    if (!Number.isFinite(parsedPriority) || nextPriority < 1 || nextPriority > 5) {
      setSettingsError('Priority must be between 1 and 5.')
      setSettingsSaved(false)
      return
    }

    if (!Number.isFinite(parsedCadence) || nextCadence < 1 || nextCadence > 365) {
      setSettingsError('Cadence must be between 1 and 365 days.')
      setSettingsSaved(false)
      return
    }

    if (!WORKFLOW_STATUS_OPTIONS.includes(nextStatus)) {
      setSettingsError('Workflow status is invalid.')
      setSettingsSaved(false)
      return
    }

    setSettingsError(null)
    setSettingsSaved(false)
    setRunDirectoryWarning(
      nextRunDirectory && isOutsidePreferredRunRoots(nextRunDirectory)
        ? `Outside preferred roots (${RUN_DIRECTORY_PREFERRED_ROOTS.join(', ')}). This is allowed, but double-check it.`
        : null
    )

    const hasTitleChanged = nextTitle !== detail.workstream.name
    const hasRunDirectoryChanged = nextRunDirectory !== (detail.workstream.chat_run_directory ?? null)
    const hasPriorityChanged = nextPriority !== detail.workstream.priority
    const hasCadenceChanged = nextCadence !== detail.workstream.target_cadence_days
    const hasStatusChanged = nextStatus !== detail.workstream.status

    if (!hasTitleChanged && !hasRunDirectoryChanged && !hasPriorityChanged && !hasCadenceChanged && !hasStatusChanged) {
      return
    }

    const updatePayload: UpdateWorkstreamInput = {}
    if (hasTitleChanged) {
      updatePayload.name = nextTitle
    }
    if (hasRunDirectoryChanged) {
      updatePayload.chat_run_directory = nextRunDirectory
    }
    if (hasPriorityChanged) {
      updatePayload.priority = nextPriority
    }
    if (hasCadenceChanged) {
      updatePayload.target_cadence_days = nextCadence
    }
    if (hasStatusChanged) {
      updatePayload.status = nextStatus
    }

    try {
      await updateSettingsMutation.mutateAsync({
        id: detail.workstream.id,
        data: updatePayload
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save settings'
      setSettingsError(message)
      setSettingsSaved(false)
      return
    }

    setTitleDraft(nextTitle)
    setRunDirectoryDraft(nextRunDirectory ?? '')
    setPriorityDraft(String(nextPriority))
    setCadenceDraft(String(nextCadence))
    setStatusDraft(nextStatus)
    setSettingsSaved(true)
    window.setTimeout(() => {
      setSettingsSaved(false)
    }, 1200)
  }

  async function handleSetWorkflowStatus(nextStatus: WorkstreamStatus) {
    if (!detail || updateSettingsMutation.isPending) {
      return
    }

    if (nextStatus === detail.workstream.status) {
      setStatusDraft(nextStatus)
      return
    }

    setSettingsError(null)
    setSettingsSaved(false)

    try {
      await updateSettingsMutation.mutateAsync({
        id: detail.workstream.id,
        data: {
          status: nextStatus
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update workflow status'
      setSettingsError(message)
      setSettingsSaved(false)
      return
    }

    setStatusDraft(nextStatus)
    setSettingsSaved(true)
    window.setTimeout(() => {
      setSettingsSaved(false)
    }, 1200)
  }

  function handleSettingsInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') {
      return
    }

    event.preventDefault()
    void handleSaveWorkstreamSettings()
    event.currentTarget.blur()
  }

  function handleChatInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) {
      return
    }

    event.preventDefault()
    void handleSendChatMessage()
  }

  function handleChatInputChange(value: string, textarea: HTMLTextAreaElement) {
    setChatInput(value)
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`
  }

  function resetChatInputHeight() {
    if (!chatInputRef.current) {
      return
    }

    chatInputRef.current.style.height = 'auto'
  }

  function handleCreateNewTopicTab() {
    const nextTopicNumber = newTopicCount
    const newTabId = createChatTabId('topic')

    setNewTopicCount((count) => count + 1)
    setChatTabs((tabs) => [
      ...tabs,
      {
        id: newTabId,
        label: `Topic ${nextTopicNumber}`,
        resumeSessionId: null,
        conversationUuid: null,
        kind: 'new'
      }
    ])
    setActiveChatTabId(newTabId)
  }

  function handleDismissSuggestion(conversationUuid: string) {
    setDismissedSuggestionIds((ids) => (ids.includes(conversationUuid) ? ids : [...ids, conversationUuid]))
  }

  function beginRenameChatTab(tabId: string) {
    const tab = chatTabs.find((entry) => entry.id === tabId)
    if (!tab) {
      return
    }

    setTerminalErrorForTab(tabId, null)
    setRenamingTabId(tabId)
    setRenameTabDraft(tab.label)
  }

  function cancelRenameChatTab() {
    setRenamingTabId(null)
    setRenameTabDraft('')
  }

  async function commitRenameChatTab(tabId: string) {
    if (renamingTabId !== tabId) {
      return
    }

    const tab = chatTabs.find((entry) => entry.id === tabId)
    if (!tab) {
      cancelRenameChatTab()
      return
    }

    const trimmedInput = renameTabDraft.trim()
    if (!trimmedInput) {
      setTerminalErrorForTab(tabId, 'Session name must not be empty.')
      return
    }

    const conversationUuid = tab.resumeSessionId ?? tab.conversationUuid ?? null
    const nextLabel = normalizeSessionLabel(trimmedInput, conversationUuid)
    const previousLabel = tab.label
    cancelRenameChatTab()
    setTerminalErrorForTab(tabId, null)

    if (nextLabel === previousLabel) {
      return
    }

    setChatTabs((tabs) => tabs.map((entry) => (entry.id === tabId ? { ...entry, label: nextLabel } : entry)))

    if (!conversationUuid || workstreamId === null) {
      return
    }

    try {
      await chatApi.renameSession(workstreamId, conversationUuid, trimmedInput)
      void detailQuery.refetch()
      void conversationsQuery.refetch()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rename session'
      setTerminalErrorForTab(tabId, message)
      setChatTabs((tabs) => tabs.map((entry) => (entry.id === tabId ? { ...entry, label: previousLabel } : entry)))
    }
  }

  async function handleToggleLinkedSessionPreview(conversationUuid: string) {
    if (expandedLinkedConversationId === conversationUuid) {
      setExpandedLinkedConversationId(null)
      return
    }

    setExpandedLinkedConversationId(conversationUuid)

    const existing = conversationPreviews[conversationUuid]
    if (existing && (existing.status === 'loading' || existing.status === 'ready')) {
      return
    }

    setConversationPreviews((previous) => ({
      ...previous,
      [conversationUuid]: {
        status: 'loading',
        messages: [],
        error: null
      }
    }))

    try {
      const messages = await chatApi.getConversationPreview(conversationUuid, 4)
      setConversationPreviews((previous) => ({
        ...previous,
        [conversationUuid]: {
          status: 'ready',
          messages,
          error: null
        }
      }))
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to load conversation preview'
      setConversationPreviews((previous) => ({
        ...previous,
        [conversationUuid]: {
          status: 'error',
          messages: [],
          error: errorMessage
        }
      }))
    }
  }

  async function handleCloseChatTab(tabId: string) {
    const tabToClose = chatTabs.find((tab) => tab.id === tabId)
    if (!tabToClose) {
      return
    }

    const conversationUuid = tabToClose.resumeSessionId ?? tabToClose.conversationUuid ?? null
    if (terminalState.is_active && conversationUuid && terminalState.conversation_uuid === conversationUuid) {
      await handleStopTerminalSession()
    }

    if (conversationUuid && workstreamId !== null) {
      try {
        await handleUnlink(conversationUuid)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to archive session'
        setTerminalErrorForTab(tabId, message)
        return
      }
    }

    setChatMessagesByTab((previous) => {
      if (!(tabId in previous)) {
        return previous
      }

      const next = { ...previous }
      delete next[tabId]
      return next
    })

    setChatSendErrorsByTab((previous) => {
      if (!(tabId in previous)) {
        return previous
      }

      const next = { ...previous }
      delete next[tabId]
      return next
    })

    setTerminalErrorsByTab((previous) => {
      if (!(tabId in previous)) {
        return previous
      }

      const next = { ...previous }
      delete next[tabId]
      return next
    })

    setDraftCommandModeByTab((previous) => {
      if (!(tabId in previous)) {
        return previous
      }

      const next = { ...previous }
      delete next[tabId]
      return next
    })

    setDraftViewModeByTab((previous) => {
      if (!(tabId in previous)) {
        return previous
      }

      const next = { ...previous }
      delete next[tabId]
      return next
    })

    if (activeMessageTabIdRef.current === tabId) {
      activeMessageTabIdRef.current = null
    }

    for (const [streamId, mappedTabId] of Object.entries(streamTabLookupRef.current)) {
      if (mappedTabId === tabId) {
        delete streamTabLookupRef.current[streamId]
      }
    }

    setChatTabs((tabs) => {
      if (!tabs.some((tab) => tab.id === tabId)) {
        return tabs
      }

      const remainingTabs = tabs.filter((tab) => tab.id !== tabId)
      const hasFreshTopicTab = remainingTabs.some((tab) => tab.kind === 'new' && tab.resumeSessionId === null)
      const nextTabs = hasFreshTopicTab ? remainingTabs : [createNewTopicTab(), ...remainingTabs]

      if (activeChatTabIdRef.current === tabId) {
        const currentIndex = tabs.findIndex((tab) => tab.id === tabId)
        const nextTab = nextTabs[Math.max(0, currentIndex - 1)] ?? nextTabs[0]
        setActiveChatTabId(nextTab.id)
      }

      return nextTabs
    })
  }

  async function persistContextForSession(
    workstream: number,
    conversationUuid: string,
    docs: ContextDocInput[]
  ) {
    try {
      await chatApi.setSessionContext(workstream, conversationUuid, docs)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to persist session context'
      setContextUiError(message)
    }
  }

  async function persistSessionPreference(
    conversationUuid: string,
    patch: {
      command_mode?: ChatSessionCommandMode
      view_mode?: ChatSessionViewMode
    }
  ) {
    try {
      const saved = await chatApi.setSessionPreference(conversationUuid, patch)
      setSessionPreferencesByConversation((previous) => ({
        ...previous,
        [saved.conversation_uuid]: saved
      }))
      setSessionPreferenceLoadedByConversation((previous) => ({
        ...previous,
        [saved.conversation_uuid]: true
      }))
      return saved
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save session preference'
      if (activeChatTabIdRef.current) {
        setTerminalErrorForTab(activeChatTabIdRef.current, message)
      }
      return null
    }
  }

  async function persistDraftPreferencesForTab(tabId: string, conversationUuid: string) {
    const commandModeDraft = draftCommandModeByTab[tabId]
    const viewModeDraft = draftViewModeByTab[tabId]
    if (commandModeDraft === undefined && viewModeDraft === undefined) {
      return
    }

    await persistSessionPreference(conversationUuid, {
      command_mode: commandModeDraft,
      view_mode: viewModeDraft
    })

    setDraftCommandModeByTab((previous) => {
      if (!(tabId in previous)) {
        return previous
      }

      const next = { ...previous }
      delete next[tabId]
      return next
    })

    setDraftViewModeByTab((previous) => {
      if (!(tabId in previous)) {
        return previous
      }

      const next = { ...previous }
      delete next[tabId]
      return next
    })
  }

  async function persistProjectContext(workstream: number, docs: ContextDocInput[]) {
    try {
      const saved = await chatApi.setWorkstreamContext(workstream, docs)
      const mappedDocs = mapStoredContextDocsToInputs(saved)
      setProjectContext(
        mappedDocs,
        saved.map((doc) => mapStoredContextDoc(doc))
      )

      const allowedKeys = new Set(mappedDocs.map((doc) => normalizeContextDocKey(doc)))
      setContextDocsByTab((previous) => {
        let changed = false
        const next: Record<string, ContextDocInput[]> = {}
        for (const [tabId, tabDocs] of Object.entries(previous)) {
          const filtered = tabDocs.filter((doc) => allowedKeys.has(normalizeContextDocKey(doc)))
          if (filtered.length !== tabDocs.length) {
            changed = true
          }
          next[tabId] = filtered
        }
        return changed ? next : previous
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to persist project context'
      setContextUiError(message)
    }
  }

  function handleContextInputSourceChange(nextSource: ContextDocSource) {
    setContextInputSource(nextSource)
  }

  function handleContextInputReferenceChange(nextReference: string) {
    setContextInputReference(nextReference)
  }

  function handleRunDirectoryDraftChange(nextValue: string) {
    setRunDirectoryDraft(nextValue)
    const normalized = nextValue.trim()
    setRunDirectoryWarning(
      normalized && isOutsidePreferredRunRoots(normalized)
        ? `Outside preferred roots (${RUN_DIRECTORY_PREFERRED_ROOTS.join(', ')}). This is allowed, but double-check it.`
        : null
    )
  }

  async function handleAddContextDocument(docInput?: ContextDocInput) {
    if (workstreamId === null) {
      return
    }

    const source = docInput?.source ?? contextInputSource
    const reference = (docInput?.reference ?? contextInputReference).trim()
    if (!reference) {
      return
    }

    const doc: ContextDocInput = {
      source,
      reference
    }
    const key = normalizeContextDocKey(doc)
    const existing = projectContextDocs
    if (existing.some((entry) => normalizeContextDocKey(entry) === key)) {
      setContextInputReference('')
      return
    }

    const nextDocs = [...existing, doc]
    setProjectContext(nextDocs)
    setContextInputReference('')
    setContextUiError(null)

    await persistProjectContext(workstreamId, nextDocs)
  }

  async function handleRemoveContextDocument(index: number) {
    if (workstreamId === null) {
      return
    }

    const existing = projectContextDocs
    if (index < 0 || index >= existing.length) {
      return
    }

    const nextDocs = existing.filter((_doc, docIndex) => docIndex !== index)
    setProjectContext(nextDocs)
    setContextUiError(null)

    await persistProjectContext(workstreamId, nextDocs)
  }

  async function handleAddLegacyContextDoc(doc: ContextDocInput) {
    await handleAddContextDocument(doc)
  }

  async function setActiveTopicContextDocs(nextDocs: ContextDocInput[]) {
    if (!activeChatTabId || workstreamId === null) {
      return
    }

    setContextDocsForTab(activeChatTabId, nextDocs)
    const activeTab = chatTabs.find((tab) => tab.id === activeChatTabId)
    if (activeTab?.resumeSessionId) {
      await persistContextForSession(workstreamId, activeTab.resumeSessionId, nextDocs)
    }
  }

  async function handleToggleActiveTopicContextDoc(doc: ContextDocInput, checked: boolean) {
    const key = normalizeContextDocKey(doc)
    const existing = activeContextDocs
    const filtered = existing.filter((entry) => normalizeContextDocKey(entry) !== key)
    const nextDocs = checked ? [...filtered, doc] : filtered
    await setActiveTopicContextDocs(nextDocs)
  }

  async function handleSelectAllActiveTopicContextDocs() {
    await setActiveTopicContextDocs(projectContextDocs)
  }

  async function handleClearActiveTopicContextDocs() {
    await setActiveTopicContextDocs([])
  }

  async function handlePickContextFile() {
    if (contextInputSource !== 'file' || isPickingContextFile) {
      return
    }

    setContextUiError(null)
    setIsPickingContextFile(true)

    try {
      const defaultPath =
        contextInputReference.trim() ||
        runDirectoryDraft.trim() ||
        detail?.workstream.chat_run_directory ||
        chatProjectCwd ||
        null
      const selection = await appApi.pickContextFile({ defaultPath })
      if (selection.canceled || !selection.path) {
        return
      }

      if (workstreamId === null) {
        setContextInputReference(selection.path)
        return
      }

      await handleAddContextDocument({
        source: 'file',
        reference: selection.path
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not open file picker'
      setContextUiError(message)
    } finally {
      setIsPickingContextFile(false)
    }
  }

  async function handleCommandModeChange(nextMode: ChatSessionCommandMode) {
    if (!activeChatTabId) {
      return
    }

    setTerminalErrorForTab(activeChatTabId, null)

    if (!activeChatConversationId) {
      setDraftCommandModeByTab((previous) => ({
        ...previous,
        [activeChatTabId]: nextMode
      }))
      return
    }

    await persistSessionPreference(activeChatConversationId, { command_mode: nextMode })
    if (isTerminalActiveForActiveConversation) {
      appendSystemMessage(activeChatTabId, 'Command mode changed. The new mode applies the next time you start terminal.')
    }
  }

  async function handleViewModeChange(nextMode: ChatSessionViewMode) {
    if (!activeChatTabId) {
      return
    }

    setTerminalErrorForTab(activeChatTabId, null)

    if (!activeChatConversationId) {
      setDraftViewModeByTab((previous) => ({
        ...previous,
        [activeChatTabId]: nextMode
      }))
      return
    }

    await persistSessionPreference(activeChatConversationId, { view_mode: nextMode })
  }

  async function startTerminalForActiveTopic(allowReplaceActive: boolean): Promise<boolean> {
    if (workstreamId === null || !activeChatTabId) {
      return false
    }

    const activeTab = chatTabs.find((tab) => tab.id === activeChatTabId)
    if (!activeTab) {
      return false
    }

    const payload = {
      workstream_id: workstreamId,
      conversation_uuid: activeTab.resumeSessionId,
      cwd: detail?.workstream.chat_run_directory ?? chatProjectCwd ?? null,
      command_mode: activeCommandMode
    }

    try {
      pendingTerminalStartTabIdRef.current = activeChatTabId
      const state = await chatApi.startTerminalSession(payload)
      setTerminalState(state)

      if (state.conversation_uuid) {
        setChatSessionId(state.conversation_uuid)
        promoteActiveTabWithSession(state.conversation_uuid)
        await persistDraftPreferencesForTab(activeChatTabId, state.conversation_uuid)
        await persistContextForSession(workstreamId, state.conversation_uuid, activeContextDocs)
      }

      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start terminal session'
      if (
        !allowReplaceActive &&
        message.toLowerCase().includes('another terminal session is already active') &&
        window.confirm('Another terminal session is active. Stop it and start this one?')
      ) {
        try {
          await chatApi.stopTerminalSession()
        } catch (stopError) {
          const stopMessage = stopError instanceof Error ? stopError.message : 'Failed to stop currently active terminal session'
          setTerminalErrorForTab(activeChatTabId, stopMessage)
          pendingTerminalStartTabIdRef.current = null
          return false
        }
        return await startTerminalForActiveTopic(true)
      }

      setTerminalErrorForTab(activeChatTabId, message)
      pendingTerminalStartTabIdRef.current = null
      return false
    }
  }

  async function handleStartTerminalSession() {
    await startTerminalForActiveTopic(false)
  }

  async function handleStopTerminalSession() {
    try {
      const state = await chatApi.stopTerminalSession()
      setTerminalState(state)
      if (activeChatTabId) {
        setTerminalErrorForTab(activeChatTabId, null)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to stop terminal session'
      if (activeChatTabId) {
        setTerminalErrorForTab(activeChatTabId, message)
      }
    }
  }

  function handleTerminalInput(data: string) {
    if (!isTerminalActiveForActiveConversation) {
      return
    }

    void chatApi.sendTerminalInput(data).catch((error) => {
      const message = error instanceof Error ? error.message : 'Failed to send terminal input'
      if (activeChatTabId) {
        setTerminalErrorForTab(activeChatTabId, message)
      }
    })
  }

  function handleTerminalResize(cols: number, rows: number) {
    if (!isTerminalActiveForActiveConversation) {
      return
    }

    void chatApi.resizeTerminal(cols, rows).catch(() => {
      // Ignore resize failures from transient layout updates.
    })
  }

  async function handleSendChatMessage(overrides?: { message?: string; permissionMode?: ClaudePermissionMode | null }) {
    if (workstreamId === null || isSendingChat) {
      return
    }

    if (isTerminalActiveForActiveConversation) {
      if (activeChatTabIdRef.current) {
        setChatErrorForTab(activeChatTabIdRef.current, 'Terminal session is active; use terminal input or stop terminal first.')
      }
      return
    }

    const message = (overrides?.message ?? chatInput).trim()
    if (!message) {
      return
    }

    const targetTabId = activeChatTabIdRef.current
    if (!targetTabId) {
      return
    }

    const targetTab = chatTabs.find((tab) => tab.id === targetTabId)
    if (!targetTab) {
      return
    }

    const userMessageId = createChatMessageId('user')
    const assistantMessageId = createChatMessageId('assistant')
    const activeTabSessionId = targetTab.resumeSessionId
    const activeTabContextDocs = contextDocsByTab[targetTabId] ?? projectContextDocs
    const allowWorkstreamSessionFallback = targetTab.kind !== 'new'

    if (!overrides?.message) {
      setChatInput('')
      resetChatInputHeight()
    }

    setPendingQuestionForTab(targetTabId, null)
    setPendingPermissionForTab(targetTabId, null)
    setChatErrorForTab(targetTabId, null)
    setIsSendingChat(true)
    setActiveStreamId(null)
    activeStreamIdRef.current = null
    activeAssistantMessageIdRef.current = assistantMessageId
    activeMessageTabIdRef.current = targetTabId

    setChatMessagesByTab((previous) => ({
      ...previous,
      [targetTabId]: [
        ...(previous[targetTabId] ?? []),
        { id: userMessageId, role: 'user', text: message, createdAt: Date.now() },
        { id: assistantMessageId, role: 'assistant', text: '', streaming: true, toolUses: [], createdAt: Date.now() }
      ]
    }))

    try {
      const chatPayload: Parameters<typeof chatApi.sendMessage>[0] = {
        workstream_id: workstreamId,
        message,
        resume_session_id: activeTabSessionId,
        allow_workstream_session_fallback: allowWorkstreamSessionFallback,
        permission_mode: overrides?.permissionMode ?? null,
        dangerously_skip_permissions: activeCommandMode === 'cc',
        context_docs: activeTabContextDocs
      }

      const result = await chatApi.sendMessage(chatPayload)

      streamTabLookupRef.current[result.stream_id] = targetTabId

      if (result.session_id) {
        setChatSessionId(result.session_id)
        promoteActiveTabWithSession(result.session_id)
        await persistDraftPreferencesForTab(targetTabId, result.session_id)
        await persistContextForSession(workstreamId, result.session_id, activeTabContextDocs)
      }

      const fallbackText = result.assistant_text || result.result_text || 'No response text returned.'
      setChatMessagesByTab((previous) => {
        const messages = previous[targetTabId]
        if (!messages || messages.length === 0) {
          return previous
        }

        return {
          ...previous,
          [targetTabId]: messages.map((chatMessage) =>
            chatMessage.id === assistantMessageId
              ? {
                  ...chatMessage,
                  text: chatMessage.text.trim() ? chatMessage.text : fallbackText,
                  streaming: false,
                  error: result.is_error,
                  toolUses: chatMessage.toolUses?.map((toolUse) => ({ ...toolUse, status: 'done' }))
                }
              : chatMessage
          )
        }
      })

      if (result.is_error) {
        setChatErrorForTab(targetTabId, result.result_text ?? `Claude exited with code ${result.exit_code ?? 'unknown'}`)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to send chat message'
      setChatErrorForTab(targetTabId, errorMessage)
      setChatMessagesByTab((previous) => {
        const messages = previous[targetTabId]
        if (!messages || messages.length === 0) {
          return previous
        }

        return {
          ...previous,
          [targetTabId]: messages.map((chatMessage) =>
            chatMessage.id === assistantMessageId
              ? {
                  ...chatMessage,
                  text: chatMessage.text.trim() ? chatMessage.text : errorMessage,
                  streaming: false,
                  error: true,
                  toolUses: chatMessage.toolUses?.map((toolUse) => ({ ...toolUse, status: 'done' }))
                }
              : chatMessage
          )
        }
      })
    } finally {
      const currentStreamId = activeStreamIdRef.current
      if (currentStreamId) {
        delete streamTabLookupRef.current[currentStreamId]
      }

      setIsSendingChat(false)
      setActiveStreamId(null)
      activeStreamIdRef.current = null
      activeAssistantMessageIdRef.current = null
      activeMessageTabIdRef.current = null

      void detailQuery.refetch()
      void conversationsQuery.refetch()
      void chatSessionQuery.refetch()
      void linkedConversationUuidsQuery.refetch()
    }
  }

  async function handleAnswerPendingQuestion(option: QuestionOptionSummary) {
    if (!activeChatTabId) {
      return
    }

    const question = pendingQuestionsByTab[activeChatTabId]
    if (!question?.text) {
      return
    }

    const answerText = option.description ? `${option.label} (${option.description})` : option.label
    const response = `Answer to your question "${question.text}": ${answerText}`
    await handleSendChatMessage({ message: response })
  }

  async function handleApprovePendingPermission() {
    if (!activeChatTabId) {
      return
    }

    const permission = pendingPermissionsByTab[activeChatTabId]
    if (!permission) {
      return
    }

    const commandLines =
      permission.commands.length > 0 ? permission.commands.map((command) => `- ${command}`).join('\n') : '- Previously blocked command'
    const response = `Approved. Continue and retry the blocked operation(s):\n${commandLines}`
    await handleSendChatMessage({ message: response, permissionMode: 'bypassPermissions' })
  }

  async function handleRejectPendingPermission() {
    if (!activeChatTabId) {
      return
    }

    const permission = pendingPermissionsByTab[activeChatTabId]
    if (!permission) {
      return
    }

    const response = 'I do not approve the blocked operation. Continue without running it.'
    await handleSendChatMessage({ message: response })
  }

  async function handleCancelActiveStream() {
    if (!activeStreamId) {
      return
    }

    await chatApi.cancelStream(activeStreamId)
  }

  function renderLinkedSessionsList(chats: ChatReference[], mode: 'full' | 'compact', emptyMessage: string) {
    return (
      <div className={`chat-secondary-list ${mode === 'compact' ? 'chat-secondary-list-compact' : ''}`}>
        {chats.map((chat) => {
          const conversationUuid = chat.conversation_uuid
          const preview = conversationPreviews[conversationUuid]
          const isExpanded = expandedLinkedConversationId === conversationUuid

          return (
            <article
              key={`${chat.workstream_id}-${conversationUuid}`}
              className={`chat-item chat-item-clickable ${isExpanded ? 'expanded' : ''}`}
              onClick={() => void handleToggleLinkedSessionPreview(conversationUuid)}
            >
              <div className="chat-item-body">
                <strong>{chat.conversation_title ?? conversationUuid}</strong>
                {chat.last_user_message && <p>{chat.last_user_message}</p>}
                <time>{formatDateTime(chat.chat_timestamp ?? chat.linked_at)}</time>

                {isExpanded && (
                  <div className="linked-preview">
                    {preview?.status === 'loading' && <p className="section-empty">Loading last messages...</p>}
                    {preview?.status === 'error' && <p className="detail-inline-error">{preview.error ?? 'Could not load preview.'}</p>}
                    {preview?.status === 'ready' && preview.messages.length === 0 && (
                      <p className="section-empty">No previewable messages for this session.</p>
                    )}
                    {preview?.status === 'ready' && preview.messages.length > 0 && (
                      <div className="linked-preview-list">
                        {preview.messages.map((message, index) => (
                          <div key={`${conversationUuid}-${index}`} className={`linked-preview-message ${message.role}`}>
                            <span className="linked-preview-role">{message.role}</span>
                            <p>{message.text}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="chat-item-actions">
                <button
                  type="button"
                  className="chat-item-action"
                  onClick={(event) => {
                    event.stopPropagation()
                    void handleUnlink(conversationUuid)
                  }}
                >
                  Unlink
                </button>
              </div>
            </article>
          )
        })}
        {chats.length === 0 && <p className="section-empty">{emptyMessage}</p>}
      </div>
    )
  }

  return (
    <section className="detail-pane">
      <header className="detail-header-shell">
        <div className="detail-title-row">
          <h2 className="detail-title">{detail.workstream.name}</h2>
          <span className={`status-pill ${detail.workstream.status}`}>{detail.workstream.status}</span>
        </div>

        <div className="detail-tabs" role="tablist" aria-label="Workstream detail tabs">
          <button
            type="button"
            className={`detail-tab ${activeTab === 'info' ? 'active' : ''}`}
            onClick={() => setActiveTab('info')}
          >
            Info
          </button>
          <button
            type="button"
            className={`detail-tab ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('chat')
              focusChatInput()
            }}
          >
            Chat
          </button>
          <button
            type="button"
            className={`detail-tab ${activeTab === 'context' ? 'active' : ''}`}
            onClick={() => setActiveTab('context')}
          >
            Context
          </button>
        </div>
      </header>

      {activeTab === 'info' && (
        <div className="info-panel visible">
          <div className="info-content">
            <section className="info-section">
              <div className="info-section-header">Ranking Score</div>
              <div className="score-card">
                <div className="score-total">
                  <div className="score-number">{Math.round(detail.workstream.score.total_score)}</div>
                  <div className="score-label">Total</div>
                </div>
                <div className="score-breakdown">
                  <div className="score-component">
                    <div className="score-component-value">{Math.round(detail.workstream.score.priority_score)}</div>
                    <div className="score-component-name">Priority</div>
                    <div className="score-bar-track">
                      <div className="score-bar-fill priority" style={{ width: `${priorityPercent}%` }} />
                    </div>
                  </div>
                  <div className="score-component">
                    <div className="score-component-value">{Math.round(detail.workstream.score.staleness_score)}</div>
                    <div className="score-component-name">Staleness</div>
                    <div className="score-bar-track">
                      <div className="score-bar-fill staleness" style={{ width: `${stalenessPercent}%` }} />
                    </div>
                  </div>
                  <div className="score-component">
                    <div className="score-component-value">{Math.round(detail.workstream.score.blocked_penalty)}</div>
                    <div className="score-component-name">Blocked</div>
                    <div className="score-bar-track">
                      <div className="score-bar-fill blocked" style={{ width: `${blockedPercent}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="info-section">
              <div className="info-section-header">Next Action</div>
              <div className="next-action-card">
                <p className="next-action-text">{nextActionText ?? 'No next action set.'}</p>
                <p className="next-action-source">{nextActionSource}</p>
              </div>
            </section>

            <section className="info-section">
              <div className="info-section-header">Resume Context</div>
              <div className="resume-card">
                {latestChat ? (
                  <>
                    <div className="resume-chat-title" title={latestChat.conversation_title ?? latestChat.conversation_uuid}>
                      {latestChat.conversation_title ?? latestChat.conversation_uuid}
                    </div>
                    <div className="resume-chat-preview">{latestChat.last_user_message ?? 'No recent user message captured.'}</div>
                    <div className="resume-chat-time">{formatDateTime(latestChat.chat_timestamp ?? latestChat.linked_at)}</div>
                  </>
                ) : (
                  <div className="resume-chat-preview">No linked chat context yet.</div>
                )}
                <button
                  type="button"
                  className="resume-link-btn"
                  onClick={() => {
                    setActiveTab('chat')
                    focusChatInput()
                  }}
                >
                  {'>'} Continue in Chat
                </button>
              </div>
            </section>

            <section className="info-section">
              <div className="info-section-header">Settings</div>
              <div className="settings-grid">
                <div className="setting-card setting-card-wide">
                  <div className="setting-label">Title</div>
                  <div className="setting-edit-row">
                    <input
                      type="text"
                      className="setting-input-wide"
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onKeyDown={handleSettingsInputKeyDown}
                    />
                  </div>
                </div>

                <div className="setting-card setting-card-wide">
                  <div className="setting-label">Project Run Directory</div>
                  <div className="setting-edit-row">
                    <input
                      type="text"
                      className="setting-input-wide"
                      value={runDirectoryDraft}
                      onChange={(event) => handleRunDirectoryDraftChange(event.target.value)}
                      onKeyDown={handleSettingsInputKeyDown}
                      placeholder="~/Projects/my-project"
                    />
                  </div>
                </div>

                <div className="setting-card">
                  <div className="setting-label">Priority</div>
                  <div className="setting-edit-row">
                    <input
                      type="number"
                      min={1}
                      max={5}
                      value={priorityDraft}
                      onChange={(event) => setPriorityDraft(event.target.value)}
                      onKeyDown={handleSettingsInputKeyDown}
                    />
                    <span className="setting-unit">/ 5</span>
                  </div>
                </div>

                <div className="setting-card">
                  <div className="setting-label">Cadence</div>
                  <div className="setting-edit-row">
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={cadenceDraft}
                      onChange={(event) => setCadenceDraft(event.target.value)}
                      onKeyDown={handleSettingsInputKeyDown}
                    />
                    <span className="setting-unit">days</span>
                  </div>
                </div>

                <div className="setting-card">
                  <div className="setting-label">Workflow Status</div>
                  <div className="setting-edit-row">
                    <select value={statusDraft} onChange={(event) => setStatusDraft(event.target.value as WorkstreamStatus)}>
                      {WORKFLOW_STATUS_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="setting-card">
                  <div className="setting-label">Last Activity</div>
                  <div className="setting-value setting-value-small">{formatRelativeTime(stalenessReferenceAt)}</div>
                  <div className="setting-note">Basis: {stalenessBasisLabel}</div>
                </div>

                <div className="setting-card">
                  <div className="setting-label">Staleness Ratio</div>
                  <div className={`setting-value ${detail.workstream.score.staleness_ratio > 1 ? 'setting-danger' : ''}`}>
                    {detail.workstream.score.staleness_ratio.toFixed(1)}
                    <span className="setting-unit">x</span>
                  </div>
                </div>
              </div>
              {runDirectoryWarning && <p className="detail-inline-warning">{runDirectoryWarning}</p>}
              <div className="settings-actions">
                <button
                  type="button"
                  className="setting-action-button"
                  onClick={() => void handleSaveWorkstreamSettings()}
                  disabled={updateSettingsMutation.isPending}
                >
                  {updateSettingsMutation.isPending ? 'Saving...' : 'Save Settings'}
                </button>
                {detail.workstream.status === 'done' ? (
                  <button
                    type="button"
                    className="setting-action-button"
                    onClick={() => void handleSetWorkflowStatus('active')}
                    disabled={updateSettingsMutation.isPending}
                  >
                    Unarchive Workflow
                  </button>
                ) : (
                  <button
                    type="button"
                    className="setting-action-button setting-action-warning"
                    onClick={() => void handleSetWorkflowStatus('done')}
                    disabled={updateSettingsMutation.isPending}
                  >
                    Archive Workflow
                  </button>
                )}
              </div>
              {settingsError && <p className="detail-inline-error">{settingsError}</p>}
              {!settingsError && settingsSaved && <p className="detail-inline-success">Saved</p>}
            </section>

            <section className="info-section">
              <div className="info-section-header">Legacy Context Links</div>
              {legacyObsidianContextDocs.length > 0 ? (
                <div className="context-legacy-list">
                  {legacyObsidianContextDocs.map((doc) => (
                    <div key={normalizeContextDocKey(doc)} className="context-legacy-item">
                      <button type="button" className="note-link" onClick={() => void handleOpenObsidianNote(doc.reference)}>
                        {renderContextReference(doc)}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="section-empty">No legacy Obsidian links found in stored notes.</p>
              )}
              {contextUiError && <p className="note-link-error">{contextUiError}</p>}
            </section>
          </div>
        </div>
      )}

      {activeTab === 'chat' && (
        <div className="chat-panel">
          <div className="session-bar">
            {chatTabs.map((tab) => (
              <div
                key={tab.id}
                className={`session-tab ${tab.id === activeChatTabId ? 'active' : ''}`}
                onClick={() => setActiveChatTabId(tab.id)}
              >
                <span className="tab-icon">●</span>
                {renamingTabId === tab.id ? (
                  <input
                    type="text"
                    className="tab-rename-input"
                    value={renameTabDraft}
                    autoFocus
                    onClick={(event) => {
                      event.stopPropagation()
                    }}
                    onChange={(event) => setRenameTabDraft(event.target.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void commitRenameChatTab(tab.id)
                        return
                      }

                      if (event.key === 'Escape') {
                        event.preventDefault()
                        cancelRenameChatTab()
                      }
                    }}
                  />
                ) : (
                  <span>{tab.label}</span>
                )}
                <button
                  type="button"
                  className="tab-rename"
                  title={renamingTabId === tab.id ? 'Save session name' : 'Rename session'}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (renamingTabId === tab.id) {
                      void commitRenameChatTab(tab.id)
                      return
                    }

                    beginRenameChatTab(tab.id)
                  }}
                >
                  {renamingTabId === tab.id ? 'Save' : 'Edit'}
                </button>
                <button
                  type="button"
                  className="tab-close"
                  onClick={(event) => {
                    event.stopPropagation()
                    void handleCloseChatTab(tab.id)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="session-new" title="New topic" onClick={handleCreateNewTopicTab}>
              +
            </button>
            <div className="session-id">session: {visibleSessionId ?? 'new session'}</div>
            <div className="session-controls">
              <div className="session-control-group">
                <span>Mode</span>
                <button
                  type="button"
                  className={`session-control-btn ${activeCommandMode === 'claude' ? 'active' : ''}`}
                  onClick={() => void handleCommandModeChange('claude')}
                >
                  Claude
                </button>
                <button
                  type="button"
                  className={`session-control-btn ${activeCommandMode === 'cc' ? 'active' : ''}`}
                  onClick={() => void handleCommandModeChange('cc')}
                >
                  CC
                </button>
              </div>
              <div className="session-control-group">
                <span>View</span>
                <button
                  type="button"
                  className={`session-control-btn ${activeViewMode === 'chat' ? 'active' : ''}`}
                  onClick={() => void handleViewModeChange('chat')}
                >
                  Chat
                </button>
                <button
                  type="button"
                  className={`session-control-btn ${activeViewMode === 'terminal' ? 'active' : ''}`}
                  onClick={() => void handleViewModeChange('terminal')}
                >
                  Terminal
                </button>
              </div>
            </div>
          </div>

          {activeViewMode === 'terminal' ? (
            <div className="terminal-view">
              <TerminalPane
                conversationUuid={activeChatConversationId}
                activeConversationUuid={terminalConversationId}
                output={activeTerminalOutput}
                isTerminalRunning={terminalState.is_active}
                terminalError={activeTerminalError}
                onStart={() => {
                  void handleStartTerminalSession()
                }}
                onStop={() => {
                  void handleStopTerminalSession()
                }}
                onSendInput={handleTerminalInput}
                onResize={handleTerminalResize}
              />
              {terminalState.is_active && terminalConversationId && terminalConversationId !== activeChatConversationId && (
                <p className="terminal-note">Another topic owns the active terminal: {terminalConversationId}</p>
              )}
            </div>
          ) : (
            <>
              <div className="messages-scroll" ref={chatFeedRef}>
                <div className="messages-container">
                  {activeChatMessages.length === 0 ? (
                    <div className="empty-state">
                      <div className="empty-title">Start the thread</div>
                      <div className="empty-subtitle">
                        {isActiveChatHistoryLoading
                          ? 'Loading last messages for this topic...'
                          : activeChatHistoryError
                            ? activeChatHistoryError
                            : 'Send a message to stream output from Claude Code CLI.'}
                      </div>
                    </div>
                  ) : (
                    activeChatMessages.map((chatMessage) => {
                      if (chatMessage.role === 'user') {
                        return (
                          <div key={chatMessage.id} className="message-group message-user">
                            <div className="message-bubble">
                              <p>{chatMessage.text}</p>
                            </div>
                          </div>
                        )
                      }

                      if (chatMessage.role === 'system') {
                        return (
                          <div key={chatMessage.id} className={`message-group message-system ${chatMessage.error ? 'message-system-error' : ''}`}>
                            <div className="assistant-avatar system">SYS</div>
                            <div className="message-content">
                              <div className={`message-bubble message-bubble-system ${chatMessage.error ? 'message-bubble-error' : ''}`}>
                                <ChatMessageContent text={chatMessage.text} />
                              </div>
                              <div className="message-time">{formatRelativeTime(chatMessage.createdAt)}</div>
                            </div>
                          </div>
                        )
                      }

                      return (
                        <div key={chatMessage.id} className={`message-group message-assistant ${chatMessage.error ? 'message-assistant-error' : ''}`}>
                          <div className="assistant-avatar">AI</div>
                          <div className="message-content">
                            {(chatMessage.toolUses ?? []).map((toolUse) => (
                              <div key={toolUse.id} className="tool-use-group">
                                <div className={`tool-use ${toolUse.error ? 'tool-use-error' : ''}`}>
                                  <div className={`tool-icon ${toolUse.kind}`}>{toolUse.kind.slice(0, 1).toUpperCase()}</div>
                                  <span className="tool-name">{toolUse.name}</span>
                                  <span className="tool-target">{toolUse.target}</span>
                                  {toolUse.detail && <span className="tool-detail">{toolUse.detail}</span>}
                                  <div className="tool-status">
                                    <div className="dot" />
                                    <span>{toolUse.status}</span>
                                  </div>
                                </div>
                                {toolUse.output && (
                                  <div className={`tool-output ${toolUse.error ? 'tool-output-error' : ''}`}>
                                    <ChatMessageContent text={toolUse.output} />
                                  </div>
                                )}
                              </div>
                            ))}

                            <div className={`message-bubble ${chatMessage.error ? 'message-bubble-error' : ''}`}>
                              <ChatMessageContent text={chatMessage.text || (chatMessage.streaming ? '...' : '')} />
                              {chatMessage.streaming && <span className="cursor-blink" />}
                            </div>
                            <div className="message-time">
                              {chatMessage.streaming ? (
                                <span className="streaming-indicator">
                                  <span className="streaming-dots">
                                    <span />
                                    <span />
                                    <span />
                                  </span>
                                  streaming
                                </span>
                              ) : (
                                formatRelativeTime(chatMessage.createdAt)
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })
                  )}

                  {!hasChatActivity ? (
                    <section className="chat-secondary-panel">
                      <section className="chat-context-picker">
                        <div className="chat-secondary-title">Context for This Topic</div>
                        <div className="chat-context-picker-actions">
                          <button
                            type="button"
                            className="chat-item-action"
                            onClick={() => void handleSelectAllActiveTopicContextDocs()}
                            disabled={projectContextDocs.length === 0 || isSendingChat}
                          >
                            Select All
                          </button>
                          <button
                            type="button"
                            className="chat-item-action"
                            onClick={() => void handleClearActiveTopicContextDocs()}
                            disabled={activeContextDocs.length === 0 || isSendingChat}
                          >
                            Clear
                          </button>
                        </div>
                        <div className="chat-context-picker-list">
                          {projectContextDocs.map((doc, index) => {
                            const key = normalizeContextDocKey(doc)
                            const resolution = projectContextResolutionByKey.get(key)
                            const status: 'ok' | 'missing' | 'invalid' = resolution
                              ? resolution.exists
                                ? 'ok'
                                : inferContextResolutionStatus(resolution)
                              : 'invalid'
                            const checked = activeContextKeySet.has(key)

                            return (
                              <label key={`${key}-${index}`} className={`chat-context-picker-item context-item-${status}`}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(event) => void handleToggleActiveTopicContextDoc(doc, event.target.checked)}
                                  disabled={isSendingChat}
                                />
                                <span className="chat-context-picker-label">{renderContextReference(doc)}</span>
                                <span className={`context-status-badge ${status}`}>{status}</span>
                              </label>
                            )
                          })}
                          {projectContextDocs.length === 0 && (
                            <p className="section-empty">No project context docs configured yet. Add them in the Context tab.</p>
                          )}
                        </div>
                      </section>

                      <div className="chat-secondary-card">
                        <div className="chat-secondary-title">Linked Sessions</div>
                        {renderLinkedSessionsList(activeTabLinkedChats, 'full', linkedSessionEmptyMessage)}
                      </div>
                    </section>
                  ) : (
                    <section className="chat-secondary-minimized">
                      <div className="chat-secondary-minimized-row">
                        <span>Linked sessions ({activeTabLinkedChats.length})</span>
                        <button
                          type="button"
                          className="chat-secondary-minimized-toggle"
                          onClick={() => setShowLinkedSessionsPanel((current) => !current)}
                        >
                          {showLinkedSessionsPanel ? 'Hide' : 'Manage'}
                        </button>
                      </div>
                      {showLinkedSessionsPanel && (
                        <div className="chat-secondary-minimized-body">
                          {renderLinkedSessionsList(activeTabLinkedChats, 'compact', linkedSessionEmptyMessage)}
                        </div>
                      )}
                    </section>
                  )}
                </div>
              </div>

              <form
                className="input-bar"
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleSendChatMessage()
                }}
              >
                <div className="input-wrapper">
                  <textarea
                    ref={chatInputRef}
                    className="input-textarea"
                    value={chatInput}
                    onChange={(event) => handleChatInputChange(event.target.value, event.currentTarget)}
                    onKeyDown={handleChatInputKeyDown}
                    placeholder={`Message Claude about ${detail.workstream.name}...`}
                    rows={1}
                    disabled={isSendingChat || isTerminalActiveForActiveConversation}
                  />
                  <div className="input-actions">
                    <button
                      type="button"
                      className="input-btn btn-stop"
                      onClick={() => void handleCancelActiveStream()}
                      disabled={!activeStreamId}
                    >
                      Stop
                    </button>
                    <button
                      type="submit"
                      className="input-btn btn-send"
                      disabled={isSendingChat || isTerminalActiveForActiveConversation || !chatInput.trim()}
                    >
                      Send
                    </button>
                  </div>
                </div>
                {isTerminalActiveForActiveConversation && (
                  <p className="terminal-chat-banner">Terminal session is active for this topic. Stop terminal or switch to Terminal view to continue.</p>
                )}
                {(activePendingQuestion || activePendingPermission) && (
                  <div className="pending-actions">
                    {activePendingQuestion && (
                      <div className="pending-card">
                        <p className="pending-title">Claude is asking for input</p>
                        <p className="pending-text">{activePendingQuestion.text}</p>
                        <div className="pending-buttons">
                          {activePendingQuestion.options.map((option) => (
                            <button
                              key={`${option.label}-${option.description ?? ''}`}
                              type="button"
                              className="pending-btn"
                              onClick={() => void handleAnswerPendingQuestion(option)}
                              disabled={isSendingChat}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {activePendingPermission && (
                      <div className="pending-card pending-card-warning">
                        <p className="pending-title">Claude needs permission</p>
                        <p className="pending-text">{activePendingPermission.message}</p>
                        <div className="pending-buttons">
                          <button
                            type="button"
                            className="pending-btn pending-btn-primary"
                            onClick={() => void handleApprovePendingPermission()}
                            disabled={isSendingChat}
                          >
                            Approve and Continue
                          </button>
                          <button
                            type="button"
                            className="pending-btn"
                            onClick={() => void handleRejectPendingPermission()}
                            disabled={isSendingChat}
                          >
                            Deny
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="input-hint">
                  <span>
                    <kbd>Enter</kbd> to send
                  </span>
                  <span>
                    <kbd>Shift+Enter</kbd> for new line
                  </span>
                  <span className="input-model">claude-opus-4-6 via Max</span>
                </div>
                {activeChatSendError && <p className="detail-inline-error">{activeChatSendError}</p>}
                {activeTerminalError && <p className="detail-inline-error">{activeTerminalError}</p>}
              </form>
            </>
          )}
        </div>
      )}

      {activeTab === 'context' && (
        <div className="tab-panel">
          <div className="tab-panel-header">Context</div>
          <div className="context-panel">
            <div className="context-meta">
              <span>Project docs: {projectContextDocs.length}</span>
              <span>Active topic selection: {activeContextDocs.length}</span>
            </div>

            <div className="context-add-row">
              <select value={contextInputSource} onChange={(event) => handleContextInputSourceChange(event.target.value as ContextDocSource)}>
                <option value="obsidian">Obsidian</option>
                <option value="file">File</option>
              </select>
              <input
                value={contextInputReference}
                onChange={(event) => handleContextInputReferenceChange(event.target.value)}
                placeholder={contextInputSource === 'obsidian' ? 'Vault/Note or [[Vault/Note]]' : '/absolute/path/to/file.md'}
              />
              {contextInputSource === 'file' && (
                <button type="button" onClick={() => void handlePickContextFile()} disabled={isPickingContextFile}>
                  {isPickingContextFile ? 'Opening...' : 'Browse'}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleAddContextDocument()}
                disabled={!contextInputReference.trim() || isPickingContextFile}
              >
                Add
              </button>
            </div>

            <div className="context-list">
              {projectContextDocs.map((doc, index) => {
                const key = normalizeContextDocKey(doc)
                const resolution = projectContextResolutionByKey.get(key)
                const status: 'ok' | 'missing' | 'invalid' = resolution
                  ? resolution.exists
                    ? 'ok'
                    : inferContextResolutionStatus(resolution)
                  : 'invalid'

                return (
                  <article key={`${key}-${index}`} className={`context-item context-item-${status}`}>
                    <div className="context-item-main">
                      <strong>{renderContextReference(doc)}</strong>
                      <p>{resolution?.resolved_path ?? 'Unresolved path'}</p>
                    </div>
                    <div className="context-item-actions">
                      <span className={`context-status-badge ${status}`}>{status}</span>
                      {doc.source === 'obsidian' && (
                        <button type="button" className="chat-item-action" onClick={() => void handleOpenObsidianNote(doc.reference)}>
                          Open
                        </button>
                      )}
                      <button type="button" className="chat-item-action" onClick={() => void handleRemoveContextDocument(index)}>
                        Remove
                      </button>
                    </div>
                  </article>
                )
              })}
              {projectContextDocs.length === 0 && <p className="section-empty">No project context docs yet.</p>}
            </div>

            {legacyObsidianContextDocs.length > 0 && (
              <div className="context-legacy">
                <div className="chat-secondary-title">Auto-discovered from legacy notes</div>
                <div className="context-legacy-list">
                  {legacyObsidianContextDocs.map((doc) => (
                    <div key={normalizeContextDocKey(doc)} className="context-legacy-item">
                      <span>{renderContextReference(doc)}</span>
                      <button type="button" className="chat-item-action" onClick={() => void handleAddLegacyContextDoc(doc)}>
                        Add to session
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {projectContextWarnings.length > 0 && (
              <div className="context-warnings">
                {projectContextWarnings.map((warning, index) => (
                  <p key={`${warning}-${index}`} className="detail-inline-warning">
                    {warning}
                  </p>
                ))}
              </div>
            )}

            {contextUiError && <p className="detail-inline-error">{contextUiError}</p>}
          </div>
        </div>
      )}
    </section>
  )
}
