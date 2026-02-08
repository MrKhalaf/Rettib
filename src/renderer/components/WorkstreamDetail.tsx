import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import type { ChatReference, ChatStreamEvent, ClaudeConversationPreviewMessage } from '../../shared/types'
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
import { useCreateTask, useDeleteTask, useUpdateTask } from '../hooks/useTasks'
import { useUpdateWorkstream, useWorkstreamDetail } from '../hooks/useWorkstreams'
import { formatDateTime, formatRelativeTime } from '../utils/time'
import { TaskCard } from './TaskCard'
import { ChatMessageContent } from './chat/ChatMessageContent'

interface Props {
  workstreamId: number | null
}

type DetailTab = 'info' | 'tasks' | 'chat' | 'progress' | 'notes'

type ToolUseKind = 'read' | 'edit' | 'bash' | 'grep' | 'tool'
const SUGGESTION_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

interface ToolUseEntry {
  id: string
  kind: ToolUseKind
  name: string
  target: string
  status: 'running' | 'done'
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

interface NotePart {
  kind: 'text' | 'link'
  value: string
  target?: string
}

function parseSourcePath(config: string): string {
  try {
    const parsed = JSON.parse(config) as { path?: unknown }
    return typeof parsed.path === 'string' ? parsed.path : ''
  } catch {
    return ''
  }
}

function parseObsidianNoteLine(line: string): NotePart[] {
  const parts: NotePart[] = []
  const regex = /\[\[([^\]]+)\]\]/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ kind: 'text', value: line.slice(lastIndex, match.index) })
    }

    const linkBody = match[1].trim()
    const [rawTarget, rawLabel] = linkBody.split('|')
    const target = rawTarget.trim()
    const label = rawLabel?.trim() || target
    parts.push({ kind: 'link', value: label, target })
    lastIndex = regex.lastIndex
  }

  if (lastIndex < line.length) {
    parts.push({ kind: 'text', value: line.slice(lastIndex) })
  }

  return parts.length > 0 ? parts : [{ kind: 'text', value: line }]
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

function createChatMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createChatTabId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function inferToolKind(toolName: string): ToolUseKind {
  const normalized = toolName.toLowerCase()

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
  const knownKeys = ['path', 'file', 'files', 'command', 'pattern', 'query', 'url', 'repo', 'target']

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
  const record = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'Tool'
  const target = summarizeToolTarget(record.input)

  return {
    id: createChatMessageId('tool'),
    kind: inferToolKind(name),
    name,
    target,
    status: 'running'
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

function createNewTopicTab(label = 'New topic'): ChatTopicTab {
  return {
    id: createChatTabId('topic'),
    label,
    resumeSessionId: null,
    conversationUuid: null,
    kind: 'new'
  }
}

function buildLinkedChatTabs(chats: ChatReference[], closedConversationIds: Set<string>): ChatTopicTab[] {
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

  return Array.from(latestByConversation.values())
    .sort((a, b) => (b.chat_timestamp ?? b.linked_at) - (a.chat_timestamp ?? a.linked_at))
    .map((chat) => ({
      id: `linked-${chat.conversation_uuid}`,
      label: normalizeSessionLabel(chat.conversation_title, chat.conversation_uuid),
      resumeSessionId: chat.conversation_uuid,
      conversationUuid: chat.conversation_uuid,
      kind: 'linked' as const
    }))
}

export function WorkstreamDetail({ workstreamId }: Props) {
  const [activeTab, setActiveTab] = useState<DetailTab>('info')

  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [noteLinkError, setNoteLinkError] = useState<string | null>(null)
  const [isEditingNotes, setIsEditingNotes] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')

  const [priorityDraft, setPriorityDraft] = useState('')
  const [cadenceDraft, setCadenceDraft] = useState('')
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [settingsSaved, setSettingsSaved] = useState(false)

  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState<LiveChatMessage[]>([])
  const [isSendingChat, setIsSendingChat] = useState(false)
  const [activeStreamId, setActiveStreamId] = useState<string | null>(null)
  const [chatSessionId, setChatSessionId] = useState<string | null>(null)
  const [chatProjectCwd, setChatProjectCwd] = useState<string | null>(null)
  const [chatSendError, setChatSendError] = useState<string | null>(null)

  const [chatTabs, setChatTabs] = useState<ChatTopicTab[]>([])
  const [activeChatTabId, setActiveChatTabId] = useState<string | null>(null)
  const [closedConversationIds, setClosedConversationIds] = useState<string[]>([])
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<string[]>([])
  const [showLinkedSessionsPanel, setShowLinkedSessionsPanel] = useState(false)
  const [expandedLinkedConversationId, setExpandedLinkedConversationId] = useState<string | null>(null)
  const [conversationPreviews, setConversationPreviews] = useState<Record<string, ConversationPreviewState>>({})
  const [newTopicCount, setNewTopicCount] = useState(1)

  const activeAssistantMessageIdRef = useRef<string | null>(null)
  const activeStreamIdRef = useRef<string | null>(null)
  const activeChatTabIdRef = useRef<string | null>(null)
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
  const createTaskMutation = useCreateTask(workstreamId ?? 0)
  const updateTaskMutation = useUpdateTask(workstreamId ?? 0)
  const deleteTaskMutation = useDeleteTask(workstreamId ?? 0)
  const updateSettingsMutation = useUpdateWorkstream()
  const updateNotesMutation = useUpdateWorkstream()

  const detail = detailQuery.data
  const sourceId = sourceQuery.data?.id ?? null
  const sourcePath = sourceQuery.data ? parseSourcePath(sourceQuery.data.config) : ''

  const activeTasks = useMemo(() => {
    if (!detail) {
      return []
    }

    return detail.tasks.filter((task) => task.status !== 'done')
  }, [detail])

  const nextTask = useMemo(() => {
    if (activeTasks.length === 0) {
      return null
    }

    return activeTasks.find((task) => task.status === 'in_progress') ?? activeTasks[0]
  }, [activeTasks])

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
  const nextActionSource = nextActionText
    ? 'Source: workstream next_action'
    : nextTask
      ? 'Source: first active task'
      : 'Source: none'

  const noteLines = detail?.workstream.notes?.split('\n').filter((line) => line.trim().length > 0) ?? []

  const activeChatTab = useMemo(() => {
    if (!activeChatTabId) {
      return null
    }

    return chatTabs.find((tab) => tab.id === activeChatTabId) ?? null
  }, [chatTabs, activeChatTabId])

  const visibleSessionId = activeChatTab?.resumeSessionId ?? null
  const hasChatActivity = chatMessages.length > 0

  const score = detail?.workstream.score
  const priorityPercent = score ? Math.min(100, Math.max(0, (score.priority_score / 5) * 100)) : 0
  const stalenessPercent = score ? Math.min(100, Math.max(0, score.staleness_ratio * 100)) : 0
  const blockedPercent = score ? Math.min(100, Math.max(0, Math.abs(Math.min(0, score.blocked_penalty)) * 20)) : 0

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
    if (detail && !isEditingNotes) {
      setNoteDraft(detail.workstream.notes ?? '')
    }
  }, [detail, isEditingNotes])

  useEffect(() => {
    if (!detail) {
      return
    }

    setPriorityDraft(String(detail.workstream.priority))
    setCadenceDraft(String(detail.workstream.target_cadence_days))
  }, [detail?.workstream.id, detail?.workstream.priority, detail?.workstream.target_cadence_days])

  useEffect(() => {
    setActiveTab('info')
    setChatMessages([])
    setChatInput('')
    setChatSendError(null)
    setIsSendingChat(false)
    setActiveStreamId(null)
    setChatTabs([])
    setActiveChatTabId(null)
    setClosedConversationIds([])
    setDismissedSuggestionIds([])
    setShowLinkedSessionsPanel(false)
    setExpandedLinkedConversationId(null)
    setConversationPreviews({})
    setNewTopicCount(1)

    activeStreamIdRef.current = null
    activeAssistantMessageIdRef.current = null
    activeChatTabIdRef.current = null
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
    if (!detail) {
      return
    }

    const linkedTabs = buildLinkedChatTabs(detail.chats, new Set(closedConversationIds))

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
    if (chatTabs.length === 0) {
      setActiveChatTabId(null)
      return
    }

    if (!activeChatTabId || !chatTabs.some((tab) => tab.id === activeChatTabId)) {
      setActiveChatTabId(chatTabs[0].id)
    }
  }, [chatTabs, activeChatTabId])

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
        setChatMessages((messages) =>
          messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  toolUses: [...(message.toolUses ?? []), toolUse]
                }
              : message
          )
        )
      }

      if (streamEvent.type === 'token' && streamEvent.text && activeAssistantMessageIdRef.current) {
        const assistantId = activeAssistantMessageIdRef.current
        const tokenText = streamEvent.text
        setChatMessages((messages) =>
          messages.map((message) =>
            message.id === assistantId ? { ...message, text: `${message.text}${tokenText}` } : message
          )
        )
      }

      if (streamEvent.type === 'assistant' && streamEvent.text && activeAssistantMessageIdRef.current) {
        const assistantId = activeAssistantMessageIdRef.current
        const assistantText = streamEvent.text
        setChatMessages((messages) =>
          messages.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  text: message.text.trim() ? message.text : assistantText
                }
              : message
          )
        )
      }

      if (streamEvent.type === 'error' && streamEvent.error) {
        setChatSendError(streamEvent.error)
      }

      if (streamEvent.type === 'done') {
        setIsSendingChat(false)
        setActiveStreamId(null)
        activeStreamIdRef.current = null

        if (activeAssistantMessageIdRef.current) {
          const assistantId = activeAssistantMessageIdRef.current
          setChatMessages((messages) =>
            messages.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    streaming: false,
                    toolUses: message.toolUses?.map((toolUse) => ({ ...toolUse, status: 'done' }))
                  }
                : message
            )
          )
          activeAssistantMessageIdRef.current = null
        }
      }
    })

    return unsubscribe
  }, [])

  useEffect(() => {
    if (!chatFeedRef.current) {
      return
    }

    chatFeedRef.current.scrollTop = chatFeedRef.current.scrollHeight
  }, [chatMessages])

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

  async function handleCreateTask(event: FormEvent) {
    event.preventDefault()
    if (!newTaskTitle.trim() || workstreamId === null) {
      return
    }

    await createTaskMutation.mutateAsync(newTaskTitle.trim())
    setNewTaskTitle('')
  }

  function handleStartTask(taskId: number) {
    if (workstreamId === null) {
      return
    }

    updateTaskMutation.mutate({ id: taskId, data: { status: 'in_progress' } })
  }

  async function handleCompleteTask(taskId: number) {
    await deleteTaskMutation.mutateAsync(taskId)
  }

  async function handleDeleteTask(taskId: number) {
    await deleteTaskMutation.mutateAsync(taskId)
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
    setNoteLinkError(null)
    const result = await appApi.openObsidianNote(noteRef)
    if (!result.ok) {
      setNoteLinkError(result.error ?? `Could not open [[${noteRef}]]`)
    }
  }

  async function handleSaveNotes() {
    if (!detail) {
      return
    }

    await updateNotesMutation.mutateAsync({
      id: detail.workstream.id,
      data: {
        notes: noteDraft.trim() ? noteDraft : null
      }
    })

    setIsEditingNotes(false)
  }

  async function handleSaveWorkstreamSettings() {
    if (!detail || updateSettingsMutation.isPending) {
      return
    }

    const parsedPriority = Number(priorityDraft)
    const parsedCadence = Number(cadenceDraft)
    const nextPriority = Math.round(parsedPriority)
    const nextCadence = Math.round(parsedCadence)

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

    setSettingsError(null)
    setSettingsSaved(false)

    if (nextPriority === detail.workstream.priority && nextCadence === detail.workstream.target_cadence_days) {
      return
    }

    await updateSettingsMutation.mutateAsync({
      id: detail.workstream.id,
      data: {
        priority: nextPriority,
        target_cadence_days: nextCadence
      }
    })

    setPriorityDraft(String(nextPriority))
    setCadenceDraft(String(nextCadence))
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

  function handleCloseChatTab(tabId: string) {
    setChatTabs((tabs) => {
      const closingTab = tabs.find((tab) => tab.id === tabId)
      if (!closingTab) {
        return tabs
      }

      if (closingTab.kind === 'linked' && closingTab.conversationUuid) {
        setClosedConversationIds((ids) => (ids.includes(closingTab.conversationUuid as string) ? ids : [...ids, closingTab.conversationUuid as string]))
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

  async function handleSendChatMessage() {
    if (workstreamId === null || isSendingChat) {
      return
    }

    const message = chatInput.trim()
    if (!message) {
      return
    }

    const userMessageId = createChatMessageId('user')
    const assistantMessageId = createChatMessageId('assistant')
    const activeTabSessionId = activeChatTab?.resumeSessionId ?? null
    const allowWorkstreamSessionFallback = activeChatTab ? activeChatTab.kind !== 'new' : false

    setChatInput('')
    resetChatInputHeight()
    setChatSendError(null)
    setIsSendingChat(true)
    setActiveStreamId(null)
    activeStreamIdRef.current = null
    activeAssistantMessageIdRef.current = assistantMessageId

    setChatMessages((messages) => [
      ...messages,
      { id: userMessageId, role: 'user', text: message, createdAt: Date.now() },
      { id: assistantMessageId, role: 'assistant', text: '', streaming: true, toolUses: [], createdAt: Date.now() }
    ])

    try {
      const result = await chatApi.sendMessage({
        workstream_id: workstreamId,
        message,
        resume_session_id: activeTabSessionId,
        allow_workstream_session_fallback: allowWorkstreamSessionFallback
      })

      if (result.session_id) {
        setChatSessionId(result.session_id)
        promoteActiveTabWithSession(result.session_id)
      }

      const fallbackText = result.assistant_text || result.result_text || 'No response text returned.'
      setChatMessages((messages) =>
        messages.map((chatMessage) =>
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
      )

      if (result.is_error) {
        setChatSendError(result.result_text ?? `Claude exited with code ${result.exit_code ?? 'unknown'}`)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to send chat message'
      setChatSendError(errorMessage)
      setChatMessages((messages) =>
        messages.map((chatMessage) =>
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
      )
    } finally {
      setIsSendingChat(false)
      setActiveStreamId(null)
      activeStreamIdRef.current = null
      activeAssistantMessageIdRef.current = null

      void detailQuery.refetch()
      void conversationsQuery.refetch()
      void chatSessionQuery.refetch()
      void linkedConversationUuidsQuery.refetch()
    }
  }

  async function handleCancelActiveStream() {
    if (!activeStreamId) {
      return
    }

    await chatApi.cancelStream(activeStreamId)
  }

  function renderObsidianLine(line: string, lineIndex: number) {
    return (
      <li key={`${line}-${lineIndex}`}>
        {parseObsidianNoteLine(line).map((part, partIndex) => {
          if (part.kind === 'link' && part.target) {
            const target = part.target
            return (
              <button
                key={`${part.value}-${partIndex}`}
                type="button"
                className="note-link"
                onClick={() => void handleOpenObsidianNote(target)}
              >
                {part.value}
              </button>
            )
          }

          return <span key={`${part.value}-${partIndex}`}>{part.value}</span>
        })}
      </li>
    )
  }

  function renderLinkedSessionsList(chats: ChatReference[], mode: 'full' | 'compact') {
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
        {chats.length === 0 && <p className="section-empty">No linked sessions yet.</p>}
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
            className={`detail-tab ${activeTab === 'tasks' ? 'active' : ''}`}
            onClick={() => setActiveTab('tasks')}
          >
            Tasks
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
            className={`detail-tab ${activeTab === 'progress' ? 'active' : ''}`}
            onClick={() => setActiveTab('progress')}
          >
            Progress
          </button>
          <button
            type="button"
            className={`detail-tab ${activeTab === 'notes' ? 'active' : ''}`}
            onClick={() => setActiveTab('notes')}
          >
            Notes
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
                <p className="next-action-text">{nextActionText ?? nextTask?.title ?? 'No active tasks. Add one in Tasks tab.'}</p>
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
                <div className="setting-card">
                  <div className="setting-label">Priority</div>
                  <div className="setting-edit-row">
                    <input
                      type="number"
                      min={1}
                      max={5}
                      value={priorityDraft}
                      onChange={(event) => setPriorityDraft(event.target.value)}
                      onBlur={() => void handleSaveWorkstreamSettings()}
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
                      onBlur={() => void handleSaveWorkstreamSettings()}
                      onKeyDown={handleSettingsInputKeyDown}
                    />
                    <span className="setting-unit">days</span>
                  </div>
                </div>

                <div className="setting-card">
                  <div className="setting-label">Last Progress</div>
                  <div className="setting-value setting-value-small">{formatRelativeTime(detail.workstream.last_progress_at)}</div>
                </div>

                <div className="setting-card">
                  <div className="setting-label">Staleness Ratio</div>
                  <div className={`setting-value ${detail.workstream.score.staleness_ratio > 1 ? 'setting-danger' : ''}`}>
                    {detail.workstream.score.staleness_ratio.toFixed(1)}
                    <span className="setting-unit">x</span>
                  </div>
                </div>
              </div>
              {settingsError && <p className="detail-inline-error">{settingsError}</p>}
              {!settingsError && settingsSaved && <p className="detail-inline-success">Saved</p>}
            </section>

            <section className="info-section">
              <div className="info-section-header">Recent Progress</div>
              <div className="progress-list">
                {detail.progress.map((update) => (
                  <article key={update.id} className="progress-item">
                    <div className="progress-note">{update.note}</div>
                    <div className="progress-time">{formatRelativeTime(update.created_at)}</div>
                  </article>
                ))}
                {detail.progress.length === 0 && <p className="section-empty">No progress updates yet.</p>}
              </div>
            </section>

            <section className="info-section">
              <div className="info-section-header">Notes</div>
              {noteLines.length > 0 ? <ul className="notes-list">{noteLines.map(renderObsidianLine)}</ul> : <p className="section-empty">No notes yet.</p>}
              {noteLinkError && <p className="note-link-error">{noteLinkError}</p>}
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
                <span>{tab.label}</span>
                <button
                  type="button"
                  className="tab-close"
                  onClick={(event) => {
                    event.stopPropagation()
                    handleCloseChatTab(tab.id)
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
          </div>

          <div className="messages-scroll" ref={chatFeedRef}>
            <div className="messages-container">
              {chatMessages.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-title">Start the thread</div>
                  <div className="empty-subtitle">Send a message to stream output from Claude Code CLI.</div>
                </div>
              ) : (
                chatMessages.map((chatMessage) => {
                  if (chatMessage.role === 'user') {
                    return (
                      <div key={chatMessage.id} className="message-group message-user">
                        <div className="message-bubble">
                          <p>{chatMessage.text}</p>
                        </div>
                      </div>
                    )
                  }

                  return (
                    <div key={chatMessage.id} className={`message-group message-assistant ${chatMessage.error ? 'message-assistant-error' : ''}`}>
                      <div className="assistant-avatar">AI</div>
                      <div className="message-content">
                        {(chatMessage.toolUses ?? []).map((toolUse) => (
                          <div key={toolUse.id} className="tool-use">
                            <div className={`tool-icon ${toolUse.kind}`}>{toolUse.kind.slice(0, 1).toUpperCase()}</div>
                            <span className="tool-name">{toolUse.name}</span>
                            <span className="tool-target">{toolUse.target}</span>
                            <div className="tool-status">
                              <div className="dot" />
                              <span>{toolUse.status}</span>
                            </div>
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
                  <div className="chat-secondary-card">
                    <div className="chat-secondary-title">Runtime</div>
                    <p className="source-note">Model: claude-opus-4-6 via Max</p>
                    <p className="source-note">cwd: {chatProjectCwd ?? 'Not resolved yet'}</p>
                    <p className="source-note">Source path: {sourcePath || 'Not configured'}</p>
                    <p className="source-note">
                      {diagnosticsQuery.isLoading
                        ? 'Checking Claude session index...'
                        : diagnosticsQuery.data?.exists
                          ? 'Claude source connected'
                          : 'Claude source unavailable'}
                    </p>
                    <button
                      type="button"
                      className="sidebar-control"
                      onClick={() => void handleRunSync()}
                      disabled={!sourceId || runSyncMutation.isPending}
                    >
                      {runSyncMutation.isPending ? 'Syncing...' : 'Sync Claude now'}
                    </button>
                  </div>

                  <div className="chat-secondary-card">
                    <div className="chat-secondary-title">Suggested Sessions</div>
                    <div className="chat-secondary-list">
                      {suggestedConversations.map((conversation) => (
                        <article key={conversation.conversation_uuid} className="chat-item">
                          <div>
                            <strong>{conversation.title ?? conversation.conversation_uuid}</strong>
                            {conversation.last_user_message && <p>{conversation.last_user_message}</p>}
                            <time>{formatDateTime(conversation.chat_timestamp)}</time>
                          </div>
                          <div className="chat-item-actions">
                            <button
                              type="button"
                              className="chat-item-dismiss"
                              aria-label="Dismiss suggestion"
                              onClick={() => handleDismissSuggestion(conversation.conversation_uuid)}
                              disabled={linkMutation.isPending}
                            >
                              ×
                            </button>
                            <button
                              type="button"
                              className="chat-item-action"
                              onClick={() => void handleLinkConversation(conversation.conversation_uuid)}
                              disabled={linkMutation.isPending}
                            >
                              Link
                            </button>
                          </div>
                        </article>
                      ))}
                      {suggestedConversations.length === 0 && <p className="section-empty">No unlinked recent Claude sessions found.</p>}
                    </div>
                  </div>

                  <div className="chat-secondary-card">
                    <div className="chat-secondary-title">Linked Sessions</div>
                    {renderLinkedSessionsList(detail.chats, 'full')}
                  </div>
                </section>
              ) : (
                <section className="chat-secondary-minimized">
                  <div className="chat-secondary-minimized-row">
                    <span>Linked sessions ({detail.chats.length})</span>
                    <button
                      type="button"
                      className="chat-secondary-minimized-toggle"
                      onClick={() => setShowLinkedSessionsPanel((current) => !current)}
                    >
                      {showLinkedSessionsPanel ? 'Hide' : 'Manage'}
                    </button>
                  </div>
                  {showLinkedSessionsPanel && (
                    <div className="chat-secondary-minimized-body">{renderLinkedSessionsList(detail.chats, 'compact')}</div>
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
                disabled={isSendingChat}
              />
              <div className="input-actions">
                <button type="button" className="input-btn btn-stop" onClick={() => void handleCancelActiveStream()} disabled={!activeStreamId}>
                  Stop
                </button>
                <button type="submit" className="input-btn btn-send" disabled={isSendingChat || !chatInput.trim()}>
                  Send
                </button>
              </div>
            </div>
            <div className="input-hint">
              <span>
                <kbd>Enter</kbd> to send
              </span>
              <span>
                <kbd>Shift+Enter</kbd> for new line
              </span>
              <span className="input-model">claude-opus-4-6 via Max</span>
            </div>
            {chatSendError && <p className="detail-inline-error">{chatSendError}</p>}
          </form>
        </div>
      )}

      {activeTab === 'tasks' && (
        <div className="tab-panel">
          <div className="tab-panel-header">Tasks</div>

          <form className="task-create" onSubmit={handleCreateTask}>
            <input value={newTaskTitle} onChange={(event) => setNewTaskTitle(event.target.value)} placeholder="Add task" required />
            <button type="submit" disabled={createTaskMutation.isPending}>
              Add
            </button>
          </form>

          <div className="task-list">
            {activeTasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onStart={handleStartTask}
                onComplete={(taskId) => void handleCompleteTask(taskId)}
                onDelete={(taskId) => void handleDeleteTask(taskId)}
              />
            ))}
            {activeTasks.length === 0 && <p className="section-empty">No active tasks. Add one above.</p>}
          </div>
        </div>
      )}

      {activeTab === 'progress' && (
        <div className="tab-panel">
          <div className="tab-panel-header">Progress</div>
          <div className="progress-list">
            {detail.progress.map((update) => (
              <article key={update.id} className="progress-item">
                <div className="progress-note">{update.note}</div>
                <div className="progress-time">{formatDateTime(update.created_at)}</div>
              </article>
            ))}
            {detail.progress.length === 0 && <p className="section-empty">No progress updates yet.</p>}
          </div>
        </div>
      )}

      {activeTab === 'notes' && (
        <div className="tab-panel">
          <div className="tab-panel-header">Notes</div>
          <div className="notes-toolbar">
            {!isEditingNotes ? (
              <button type="button" className="notes-edit-toggle" onClick={() => setIsEditingNotes(true)}>
                Edit
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="notes-edit-toggle"
                  onClick={() => {
                    setNoteDraft(detail.workstream.notes ?? '')
                    setIsEditingNotes(false)
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="notes-edit-toggle notes-save-toggle"
                  onClick={() => void handleSaveNotes()}
                  disabled={updateNotesMutation.isPending}
                >
                  {updateNotesMutation.isPending ? 'Saving...' : 'Save'}
                </button>
              </>
            )}
          </div>

          {isEditingNotes ? (
            <textarea
              className="notes-editor"
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="Add notes... use [[My Note]] or [[Folder/Note|Label]]"
              rows={8}
            />
          ) : noteLines.length > 0 ? (
            <ul className="notes-list">{noteLines.map(renderObsidianLine)}</ul>
          ) : (
            <p className="section-empty">No notes yet.</p>
          )}

          {noteLinkError && <p className="note-link-error">{noteLinkError}</p>}
        </div>
      )}
    </section>
  )
}
