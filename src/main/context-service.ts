import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import type { ContextDocInput, ContextDocSource, ResolveContextDocResult } from '../shared/types'

export interface ContextDocResolution extends ResolveContextDocResult {
  warning: string | undefined
}

export interface ContextBundleLimits {
  maxDocs: number
  maxCharsPerDoc: number
  maxTotalChars: number
}

export interface ContextBundleDocMetadata {
  source: ContextDocSource
  reference: string
  normalized_reference: string
  resolved_path: string | null
  exists: boolean
  included: boolean
  char_count: number | null
  warning?: string
  content_hash?: string
}

export interface ContextBundleResult {
  text: string | null
  metadata: ContextBundleDocMetadata[]
  resolved_docs: ContextDocResolution[]
}

const DEFAULT_BUNDLE_LIMITS: ContextBundleLimits = {
  maxDocs: 6,
  maxCharsPerDoc: 6000,
  maxTotalChars: 24000
}

function expandHomePath(input: string): string {
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2))
  }

  return input
}

function normalizeObsidianReferenceTarget(reference: string): string {
  const trimmed = reference.trim()
  const body =
    trimmed.startsWith('[[') && trimmed.endsWith(']]') ? trimmed.slice(2, -2).trim() : trimmed
  const [rawTarget] = body.split('|')
  const target = (rawTarget ?? '').trim().replace(/\\/g, '/')
  const withoutExtension = target.replace(/\.md$/i, '').trim()
  return withoutExtension.replace(/\/+/g, '/')
}

function getObsidianRoot(): string {
  return path.join(os.homedir(), 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents')
}

function findObsidianFileByRelativePath(relativePath: string): string | null {
  const obsidianRoot = getObsidianRoot()
  if (!fs.existsSync(obsidianRoot)) {
    return null
  }

  const notePath = relativePath.endsWith('.md') ? relativePath : `${relativePath}.md`
  const directCandidate = path.join(obsidianRoot, notePath)
  if (fs.existsSync(directCandidate) && fs.statSync(directCandidate).isFile()) {
    return directCandidate
  }

  const vaultDirs = fs
    .readdirSync(obsidianRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(obsidianRoot, entry.name))

  for (const vaultDir of vaultDirs) {
    const candidate = path.join(vaultDir, notePath)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }

  return null
}

function normalizeFileReferenceTarget(reference: string): string {
  const expanded = expandHomePath(reference.trim())
  if (!expanded) {
    return ''
  }

  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(expanded)
  return path.normalize(absolute)
}

export function normalizeContextReference(source: ContextDocSource, reference: string): string {
  if (source === 'obsidian') {
    const target = normalizeObsidianReferenceTarget(reference)
    return target ? `obsidian:${target.toLowerCase()}` : ''
  }

  const target = normalizeFileReferenceTarget(reference)
  return target ? `file:${target}` : ''
}

export function resolveObsidianReference(reference: string): string | null {
  const target = normalizeObsidianReferenceTarget(reference)
  if (!target) {
    return null
  }

  const absoluteCandidate = expandHomePath(target)
  if (path.isAbsolute(absoluteCandidate)) {
    const fullPath = absoluteCandidate.endsWith('.md') ? absoluteCandidate : `${absoluteCandidate}.md`
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fullPath
    }
  }

  return findObsidianFileByRelativePath(target)
}

export function resolveLocalFileReference(reference: string): string | null {
  const target = normalizeFileReferenceTarget(reference)
  return target || null
}

function resolveContextDoc(doc: ContextDocInput): ContextDocResolution {
  const source = doc.source
  const reference = doc.reference.trim()
  const normalizedReference = normalizeContextReference(source, reference)

  if (!reference || !normalizedReference) {
    return {
      source,
      reference,
      normalized_reference: normalizedReference,
      resolved_path: null,
      exists: false,
      warning: 'Reference is empty or invalid'
    }
  }

  const resolvedPath =
    source === 'obsidian' ? resolveObsidianReference(reference) : resolveLocalFileReference(reference)

  if (!resolvedPath) {
    return {
      source,
      reference,
      normalized_reference: normalizedReference,
      resolved_path: null,
      exists: false,
      warning: source === 'obsidian' ? 'Obsidian note was not found' : 'File path is invalid'
    }
  }

  try {
    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) {
      return {
        source,
        reference,
        normalized_reference: normalizedReference,
        resolved_path: resolvedPath,
        exists: false,
        warning: 'Resolved path is not a file'
      }
    }
  } catch {
    return {
      source,
      reference,
      normalized_reference: normalizedReference,
      resolved_path: resolvedPath,
      exists: false,
      warning: 'Resolved path does not exist'
    }
  }

  return {
    source,
    reference,
    normalized_reference: normalizedReference,
    resolved_path: resolvedPath,
    exists: true,
    warning: undefined
  }
}

export function resolveContextDocs(docs: ContextDocInput[]): ContextDocResolution[] {
  return docs.map(resolveContextDoc)
}

export function extractObsidianLinks(text: string | null | undefined): ContextDocInput[] {
  if (!text) {
    return []
  }

  const regex = /\[\[([^\]]+)\]\]/g
  const links: ContextDocInput[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    const target = normalizeObsidianReferenceTarget(match[1] ?? '')
    if (!target) {
      continue
    }

    const normalized = normalizeContextReference('obsidian', target)
    if (!normalized || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    links.push({
      source: 'obsidian',
      reference: target
    })
  }

  return links
}

export function readContextFile(
  resolvedPath: string,
  limits: {
    maxCharsPerDoc: number
    remainingChars: number
  }
): { text: string | null; char_count: number | null; truncated: boolean; warning?: string } {
  const maxChars = Math.max(0, Math.min(limits.maxCharsPerDoc, limits.remainingChars))
  if (maxChars <= 0) {
    return {
      text: null,
      char_count: 0,
      truncated: false,
      warning: 'Context budget exhausted'
    }
  }

  try {
    const raw = fs.readFileSync(resolvedPath, 'utf8')
    if (raw.includes('\u0000')) {
      return {
        text: null,
        char_count: null,
        truncated: false,
        warning: 'Binary files are not supported for context'
      }
    }

    const normalized = raw.trim()
    if (!normalized) {
      return {
        text: null,
        char_count: 0,
        truncated: false,
        warning: 'File is empty'
      }
    }

    const wasTruncated = normalized.length > maxChars
    const text = wasTruncated
      ? `${normalized.slice(0, maxChars)}\n\n[... truncated by Rettib ...]`
      : normalized

    return {
      text,
      char_count: text.length,
      truncated: wasTruncated
    }
  } catch {
    return {
      text: null,
      char_count: null,
      truncated: false,
      warning: 'Could not read file contents'
    }
  }
}

function stableHash(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function buildContextBundle(
  docs: ContextDocInput[],
  limits: ContextBundleLimits = DEFAULT_BUNDLE_LIMITS
): ContextBundleResult {
  const limitedDocs = docs.slice(0, Math.max(0, limits.maxDocs))
  const resolvedDocs = resolveContextDocs(limitedDocs)
  const metadata: ContextBundleDocMetadata[] = []
  const sections: string[] = []
  let remainingChars = Math.max(0, limits.maxTotalChars)

  for (const resolved of resolvedDocs) {
    if (!resolved.exists || !resolved.resolved_path) {
      metadata.push({
        ...resolved,
        included: false,
        char_count: null,
        warning: resolved.warning
      })
      continue
    }

    const loaded = readContextFile(resolved.resolved_path, {
      maxCharsPerDoc: limits.maxCharsPerDoc,
      remainingChars
    })

    if (!loaded.text || loaded.char_count === null) {
      metadata.push({
        ...resolved,
        included: false,
        char_count: loaded.char_count,
        warning: loaded.warning
      })
      continue
    }

    remainingChars = Math.max(0, remainingChars - loaded.char_count)
    const contentHash = stableHash(loaded.text)

    metadata.push({
      ...resolved,
      included: true,
      char_count: loaded.char_count,
      warning: loaded.warning,
      content_hash: contentHash
    })

    sections.push(
      [`## Context Document`, `- source: ${resolved.source}`, `- reference: ${resolved.reference}`, `- resolved_path: ${resolved.resolved_path}`, '', loaded.text].join(
        '\n'
      )
    )
  }

  if (sections.length === 0) {
    return {
      text: null,
      metadata,
      resolved_docs: resolvedDocs
    }
  }

  const header = `[Rettib Context | session-scoped | generated at ${new Date().toISOString()}]`
  const footer = '[End Context]'

  return {
    text: `${header}\n\n${sections.join('\n\n')}\n\n${footer}`,
    metadata,
    resolved_docs: resolvedDocs
  }
}

export function computeContextFingerprint(metadata: ContextBundleDocMetadata[]): string {
  const payload = metadata.map((entry) => ({
    source: entry.source,
    reference: entry.reference,
    normalized_reference: entry.normalized_reference,
    resolved_path: entry.resolved_path,
    exists: entry.exists,
    included: entry.included,
    char_count: entry.char_count,
    content_hash: entry.content_hash ?? null,
    warning: entry.warning ?? null
  }))

  return stableHash(JSON.stringify(payload))
}
