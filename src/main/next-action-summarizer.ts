import type { Workstream } from '../shared/types'
import { getDatabase, updateWorkstream } from './database'

interface RefreshNextActionInput {
  workstream: Workstream
  userMessage: string
  assistantMessage: string
}

interface AnthropicTextBlock {
  type?: unknown
  text?: unknown
}

interface AnthropicMessagesResponse {
  content?: unknown
}

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no'])
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
const DEFAULT_TIMEOUT_MS = 8_000
const MAX_USER_MESSAGE_CHARS = 1_000
const MAX_ASSISTANT_MESSAGE_CHARS = 4_000
const MAX_NEXT_ACTION_CHARS = 140

function readEnvString(key: string): string | null {
  const rawValue = process.env[key]
  if (typeof rawValue !== 'string') {
    return null
  }

  const trimmed = rawValue.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseTimeoutMs(rawValue: string | null): number {
  if (!rawValue) {
    return DEFAULT_TIMEOUT_MS
  }

  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TIMEOUT_MS
  }

  return Math.min(30_000, Math.max(2_000, Math.round(parsed)))
}

function isSummarizerEnabled(): boolean {
  const rawValue = readEnvString('RETTIB_NEXT_ACTION_SUMMARIZER_ENABLED')
  if (!rawValue) {
    return true
  }

  return !DISABLED_VALUES.has(rawValue.toLowerCase())
}

function selectModel(): string {
  return readEnvString('RETTIB_NEXT_ACTION_MODEL') ?? DEFAULT_MODEL
}

function selectBaseUrl(): string {
  const configured = readEnvString('RETTIB_ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com'
  return configured.replace(/\/+$/, '')
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }

  const clipped = text.slice(0, limit)
  const trailingBoundary = clipped.lastIndexOf(' ')
  if (trailingBoundary <= 40) {
    return clipped.trim()
  }

  return clipped.slice(0, trailingBoundary).trim()
}

function sanitizeContextText(text: string, limit: number): string {
  return clip(text.replace(/\s+/g, ' ').trim(), limit)
}

function unwrapCodeFence(rawText: string): string {
  const trimmed = rawText.trim()
  const codeFenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return codeFenceMatch ? codeFenceMatch[1].trim() : trimmed
}

function extractTextContent(responseData: AnthropicMessagesResponse): string | null {
  if (!Array.isArray(responseData.content)) {
    return null
  }

  const parts: string[] = []
  for (const block of responseData.content as AnthropicTextBlock[]) {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      continue
    }

    const text = block.text.trim()
    if (text) {
      parts.push(text)
    }
  }

  if (parts.length === 0) {
    return null
  }

  return parts.join('\n').trim()
}

function parseModelNextAction(rawText: string): string | null {
  const normalized = unwrapCodeFence(rawText)
  if (!normalized) {
    return null
  }

  let candidate = normalized
  if (candidate.includes('{') && candidate.includes('}')) {
    const jsonStart = candidate.indexOf('{')
    const jsonEnd = candidate.lastIndexOf('}')
    const jsonCandidate = candidate.slice(jsonStart, jsonEnd + 1).trim()

    try {
      const parsed = JSON.parse(jsonCandidate) as { next_action?: unknown }
      if (typeof parsed.next_action === 'string') {
        candidate = parsed.next_action
      }
    } catch {
      // Fall back to plain-text parsing below.
    }
  }

  const cleaned = clip(
    candidate
      .replace(/\r?\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^(next action|action)\s*[:\-]\s*/i, '')
      .replace(/^[*-]\s*/, '')
      .trim(),
    MAX_NEXT_ACTION_CHARS
  )

  if (!cleaned) {
    return null
  }

  return cleaned
}

function buildSummarizerPrompt(input: RefreshNextActionInput): string {
  const currentNextAction = input.workstream.next_action?.trim() || 'None'
  const compactUserMessage = sanitizeContextText(input.userMessage, MAX_USER_MESSAGE_CHARS)
  const compactAssistantMessage = sanitizeContextText(input.assistantMessage, MAX_ASSISTANT_MESSAGE_CHARS)

  return [
    'You are updating a single workstream next action after a chat response.',
    'Return JSON only: {"next_action":"..."}',
    'Rules:',
    '- one concrete action the user can do next',
    '- max 140 characters',
    '- plain text only (no markdown, bullets, numbering)',
    '- if there is no better action, keep the current next action',
    '',
    `Workstream: ${input.workstream.name}`,
    `Status: ${input.workstream.status}`,
    `Priority: ${input.workstream.priority}`,
    `Target cadence days: ${input.workstream.target_cadence_days}`,
    `Current next action: ${currentNextAction}`,
    '',
    `Latest user message: ${compactUserMessage}`,
    `Latest assistant response: ${compactAssistantMessage}`
  ].join('\n')
}

async function requestNextActionFromAnthropic(input: RefreshNextActionInput): Promise<string | null> {
  const apiKey = readEnvString('ANTHROPIC_API_KEY')
  if (!apiKey || !isSummarizerEnabled()) {
    return null
  }

  const timeoutMs = parseTimeoutMs(readEnvString('RETTIB_NEXT_ACTION_TIMEOUT_MS'))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${selectBaseUrl()}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: selectModel(),
        max_tokens: 120,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: buildSummarizerPrompt(input)
          }
        ]
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      const responseText = await response.text()
      throw new Error(`Anthropic request failed (${response.status}): ${responseText.slice(0, 300)}`)
    }

    const responseData = (await response.json()) as AnthropicMessagesResponse
    const textContent = extractTextContent(responseData)
    if (!textContent) {
      return null
    }

    return parseModelNextAction(textContent)
  } finally {
    clearTimeout(timeout)
  }
}

export async function refreshNextActionFromChat(input: RefreshNextActionInput): Promise<void> {
  const currentNextAction = input.workstream.next_action?.trim() ?? ''
  if (!input.userMessage.trim() || !input.assistantMessage.trim()) {
    return
  }

  try {
    const nextAction = await requestNextActionFromAnthropic(input)
    if (!nextAction) {
      return
    }

    if (nextAction.toLowerCase() === currentNextAction.toLowerCase()) {
      return
    }

    updateWorkstream(input.workstream.id, { next_action: nextAction }, getDatabase())
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.warn('[Rettib] Next action summarizer failed:', errorMessage)
  }
}
