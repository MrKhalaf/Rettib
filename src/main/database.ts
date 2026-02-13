import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

import type {
  ChatSessionPreference,
  ChatReference,
  ContextDocInput,
  CreateTaskInput,
  CreateWorkstreamInput,
  ProgressUpdate,
  SessionContextDoc,
  SyncRun,
  SyncRunStatus,
  SyncSource,
  Task,
  UpdateTaskInput,
  UpdateWorkstreamInput,
  Workstream,
  WorkstreamChatSession,
  WorkstreamListItem
} from '../shared/types'
import { normalizeContextReference } from './context-service'

const SCHEMA_VERSION = 6

let dbInstance: Database.Database | null = null

function nowMs(): number {
  return Date.now()
}

function ensureChatSessionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workstream_chat_sessions (
      workstream_id INTEGER PRIMARY KEY REFERENCES workstreams(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      project_cwd TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workstream_chat_sessions_updated
    ON workstream_chat_sessions(updated_at DESC);
  `)
}

function ensureContextSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_context_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
      conversation_uuid TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('obsidian', 'file')),
      reference TEXT NOT NULL,
      normalized_reference TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(workstream_id, conversation_uuid, normalized_reference)
    );

    CREATE TABLE IF NOT EXISTS chat_context_state (
      conversation_uuid TEXT PRIMARY KEY,
      workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
      context_fingerprint TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_context_docs_ws_conv
    ON chat_context_documents(workstream_id, conversation_uuid);

    CREATE INDEX IF NOT EXISTS idx_chat_context_state_ws
    ON chat_context_state(workstream_id);
  `)
}

function ensureWorkstreamContextSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workstream_context_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK (source IN ('obsidian', 'file')),
      reference TEXT NOT NULL,
      normalized_reference TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(workstream_id, normalized_reference)
    );

    CREATE INDEX IF NOT EXISTS idx_workstream_context_docs_ws
    ON workstream_context_documents(workstream_id);
  `)
}

function ensureChatSessionPreferenceSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_session_preferences (
      conversation_uuid TEXT PRIMARY KEY,
      command_mode TEXT NOT NULL DEFAULT 'claude' CHECK (command_mode IN ('claude', 'cc')),
      view_mode TEXT NOT NULL DEFAULT 'chat' CHECK (view_mode IN ('chat', 'terminal')),
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_session_preferences_updated
    ON chat_session_preferences(updated_at DESC);
  `)
}

function ensureWorkstreamRunDirectoryColumn(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(workstreams)`).all() as Array<{ name: string }>
  const columnNames = new Set(columns.map((column) => column.name))

  if (!columnNames.has('chat_run_directory')) {
    db.exec(`ALTER TABLE workstreams ADD COLUMN chat_run_directory TEXT`)
  }
}

function parseRepoPathFromNotes(notes: string | null): string | null {
  if (!notes) {
    return null
  }

  const repoLine = notes
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^repo:/i.test(line))

  if (!repoLine) {
    return null
  }

  const rawPath = repoLine.replace(/^repo:/i, '').trim()
  if (!rawPath) {
    return null
  }

  if (rawPath.startsWith('~/')) {
    return path.join(process.env.HOME ?? '', rawPath.slice(2))
  }

  return rawPath
}

function backfillChatRunDirectoryFromLegacyNotes(db: Database.Database): void {
  const rows = db
    .prepare(
      `
      SELECT id, notes, chat_run_directory
      FROM workstreams
      WHERE chat_run_directory IS NULL
      `
    )
    .all() as Array<{ id: number; notes: string | null; chat_run_directory: string | null }>

  const updateStatement = db.prepare(
    `
    UPDATE workstreams
    SET chat_run_directory = ?, updated_at = ?
    WHERE id = ?
    `
  )

  for (const row of rows) {
    if (row.chat_run_directory) {
      continue
    }

    const repoPath = parseRepoPathFromNotes(row.notes)
    if (!repoPath) {
      continue
    }

    updateStatement.run(repoPath, nowMs(), row.id)
  }
}

function normalizeClaudeSyncSourceType(db: Database.Database): void {
  const cliSource = db
    .prepare(
      `
      SELECT id
      FROM sync_sources
      WHERE type = 'claude_cli'
      LIMIT 1
      `
    )
    .get() as { id: number } | undefined

  if (cliSource) {
    return
  }

  const desktopSource = db
    .prepare(
      `
      SELECT id
      FROM sync_sources
      WHERE type = 'claude_desktop'
      LIMIT 1
      `
    )
    .get() as { id: number } | undefined

  if (!desktopSource) {
    return
  }

  db.prepare(
    `
    UPDATE sync_sources
    SET type = 'claude_cli', updated_at = ?
    WHERE id = ?
    `
  ).run(nowMs(), desktopSource.id)
}

function normalizeClaudeSyncSourcePath(db: Database.Database): void {
  const source = db
    .prepare(
      `
      SELECT id, config
      FROM sync_sources
      WHERE type = 'claude_cli'
      LIMIT 1
      `
    )
    .get() as { id: number; config: string } | undefined

  if (!source) {
    return
  }

  let parsedConfig: { path?: unknown }
  try {
    parsedConfig = JSON.parse(source.config) as { path?: unknown }
  } catch {
    parsedConfig = {}
  }

  const currentPath = typeof parsedConfig.path === 'string' ? parsedConfig.path : ''
  const looksLegacyLevelDbPath =
    currentPath.includes('Library/Application Support/Claude/Local Storage/leveldb') || currentPath.endsWith('/leveldb')

  if (!looksLegacyLevelDbPath) {
    return
  }

  db.prepare(
    `
    UPDATE sync_sources
    SET config = ?, updated_at = ?
    WHERE id = ?
    `
  ).run(JSON.stringify({ path: defaultClaudePath() }), nowMs(), source.id)
}

export function initDatabase(databasePath: string): Database.Database {
  if (dbInstance) {
    return dbInstance
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true })

  const db = new Database(databasePath)
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  dbInstance = db

  return db
}

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database is not initialized')
  }

  return dbInstance
}

function runMigrations(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number

  if (version >= SCHEMA_VERSION) {
    ensureChatSessionSchema(db)
    ensureWorkstreamRunDirectoryColumn(db)
    ensureContextSchema(db)
    ensureWorkstreamContextSchema(db)
    ensureChatSessionPreferenceSchema(db)
    backfillChatRunDirectoryFromLegacyNotes(db)
    normalizeClaudeSyncSourceType(db)
    normalizeClaudeSyncSourcePath(db)
    seedInitialWorkstreams(db)
    return
  }

  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workstreams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
        target_cadence_days INTEGER NOT NULL CHECK (target_cadence_days >= 1),
        last_progress_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('active', 'blocked', 'waiting', 'done')) DEFAULT 'active',
        next_action TEXT,
        notes TEXT,
        chat_run_directory TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'done')) DEFAULT 'todo',
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS progress_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
        note TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_references (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        conversation_uuid TEXT NOT NULL,
        conversation_title TEXT,
        last_user_message TEXT,
        chat_timestamp INTEGER,
        linked_at INTEGER NOT NULL,
        UNIQUE(workstream_id, conversation_uuid)
      );

      CREATE TABLE IF NOT EXISTS workstream_chat_sessions (
        workstream_id INTEGER PRIMARY KEY REFERENCES workstreams(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        project_cwd TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_context_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
        conversation_uuid TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('obsidian', 'file')),
        reference TEXT NOT NULL,
        normalized_reference TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(workstream_id, conversation_uuid, normalized_reference)
      );

      CREATE TABLE IF NOT EXISTS chat_context_state (
        conversation_uuid TEXT PRIMARY KEY,
        workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
        context_fingerprint TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workstream_context_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('obsidian', 'file')),
        reference TEXT NOT NULL,
        normalized_reference TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(workstream_id, normalized_reference)
      );

      CREATE TABLE IF NOT EXISTS sync_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        config TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(type)
      );

      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES sync_sources(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        details TEXT
      );

      CREATE TABLE IF NOT EXISTS chat_session_preferences (
        conversation_uuid TEXT PRIMARY KEY,
        command_mode TEXT NOT NULL DEFAULT 'claude' CHECK (command_mode IN ('claude', 'cc')),
        view_mode TEXT NOT NULL DEFAULT 'chat' CHECK (view_mode IN ('chat', 'terminal')),
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workstreams_status ON workstreams(status);
      CREATE INDEX IF NOT EXISTS idx_workstreams_progress ON workstreams(last_progress_at);
      CREATE INDEX IF NOT EXISTS idx_progress_updates_workstream ON progress_updates(workstream_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_workstream ON tasks(workstream_id, status, position);
      CREATE INDEX IF NOT EXISTS idx_chat_refs_workstream ON chat_references(workstream_id, chat_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_workstream_chat_sessions_updated ON workstream_chat_sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_context_docs_ws_conv ON chat_context_documents(workstream_id, conversation_uuid);
      CREATE INDEX IF NOT EXISTS idx_chat_context_state_ws ON chat_context_state(workstream_id);
      CREATE INDEX IF NOT EXISTS idx_workstream_context_docs_ws ON workstream_context_documents(workstream_id);
      CREATE INDEX IF NOT EXISTS idx_sync_runs_source ON sync_runs(source_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_session_preferences_updated ON chat_session_preferences(updated_at DESC);

      CREATE TRIGGER IF NOT EXISTS trg_progress_insert_update_workstream
      AFTER INSERT ON progress_updates
      FOR EACH ROW
      BEGIN
        UPDATE workstreams
        SET
          last_progress_at = CASE
            WHEN last_progress_at IS NULL OR NEW.created_at > last_progress_at THEN NEW.created_at
            ELSE last_progress_at
          END,
          updated_at = NEW.created_at
        WHERE id = NEW.workstream_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_progress_delete_recompute
      AFTER DELETE ON progress_updates
      FOR EACH ROW
      BEGIN
        UPDATE workstreams
        SET
          last_progress_at = (
            SELECT MAX(created_at)
            FROM progress_updates
            WHERE workstream_id = OLD.workstream_id
          ),
          updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE id = OLD.workstream_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_progress_update_recompute_old
      AFTER UPDATE OF workstream_id, created_at ON progress_updates
      FOR EACH ROW
      BEGIN
        UPDATE workstreams
        SET
          last_progress_at = (
            SELECT MAX(created_at)
            FROM progress_updates
            WHERE workstream_id = OLD.workstream_id
          ),
          updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE id = OLD.workstream_id;

        UPDATE workstreams
        SET
          last_progress_at = (
            SELECT MAX(created_at)
            FROM progress_updates
            WHERE workstream_id = NEW.workstream_id
          ),
          updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
        WHERE id = NEW.workstream_id;
      END;
    `)
  }

  if (version < 2) {
    const columns = db.prepare(`PRAGMA table_info(workstreams)`).all() as Array<{ name: string }>
    const columnNames = new Set(columns.map((column) => column.name))

    if (!columnNames.has('next_action')) {
      db.exec(`ALTER TABLE workstreams ADD COLUMN next_action TEXT`)
    }

    if (!columnNames.has('notes')) {
      db.exec(`ALTER TABLE workstreams ADD COLUMN notes TEXT`)
    }
  }

  if (version < 3) {
    ensureChatSessionSchema(db)
    normalizeClaudeSyncSourceType(db)
    normalizeClaudeSyncSourcePath(db)
  }

  if (version < 4) {
    ensureWorkstreamRunDirectoryColumn(db)
    ensureContextSchema(db)
    backfillChatRunDirectoryFromLegacyNotes(db)
  }

  if (version < 5) {
    ensureWorkstreamContextSchema(db)
  }

  if (version < 6) {
    ensureChatSessionPreferenceSchema(db)
  }

  db.pragma(`user_version = ${SCHEMA_VERSION}`)
  seedInitialWorkstreams(db)
}

interface SeedWorkstream {
  name: string
  priority: number
  target_cadence_days: number
  status: Workstream['status']
  next_action: string | null
  notes: string | null
}

const INITIAL_WORKSTREAMS: SeedWorkstream[] = [
  {
    name: 'CareQuotesAI',
    priority: 5,
    target_cadence_days: 2,
    status: 'active',
    next_action: 'TBD',
    notes: [
      'Repo: ~/Projects/CareQuotesAI',
      'Vault: [[CareQuotes/Plan Doc]]',
      'Sub-projects: NPPES-GeoSearch (provider search)'
    ].join('\n')
  },
  {
    name: 'Job Search',
    priority: 5,
    target_cadence_days: 1,
    status: 'active',
    next_action: 'TBD',
    notes: [
      'Vault: [[Interviewing/Profile]]',
      'Prep: [[hellointerview/Core Concepts]]',
      'Repo: ~/Projects/Resume'
    ].join('\n')
  },
  {
    name: 'DSPy Learning (disper)',
    priority: 4,
    target_cadence_days: 3,
    status: 'active',
    next_action: 'TBD',
    notes: ['Repo: ~/Projects/disper', 'Resources: [[res/dspy_lec.pdf]]'].join('\n')
  },
  {
    name: 'sandbox-security-agent',
    priority: 3,
    target_cadence_days: 14,
    status: 'waiting',
    next_action: 'Draft outline for site (AI + security showcase)',
    notes: [
      'Status label: Write-up candidate',
      'Repo: ~/Projects/sandbox-security-agent',
      'Context: Take-home for Cogent Security, AI agent for vulnerability management across vendor sources'
    ].join('\n')
  },
  {
    name: 'Cipher',
    priority: 2,
    target_cadence_days: 30,
    status: 'waiting',
    next_action: 'None - use as interview talking point',
    notes: [
      'Status label: Reference',
      'Repo: ~/Projects/Cipher',
      'Context: Python teaching exercise, networking/encryption exploration'
    ].join('\n')
  },
  {
    name: 'Josh Mandel CMS Proposal',
    priority: 1,
    target_cadence_days: 30,
    status: 'waiting',
    next_action: 'Occasional review',
    notes: 'Idea reference: [[Ideas/Josh Mandel CMS Proposal]]'
  },
  {
    name: 'OrthoDrill',
    priority: 1,
    target_cadence_days: 30,
    status: 'waiting',
    next_action: 'Occasional review',
    notes: 'Idea reference: [[Ideas/OrthoDrill]]'
  },
  {
    name: 'PDI Automation',
    priority: 1,
    target_cadence_days: 30,
    status: 'waiting',
    next_action: 'Occasional review',
    notes: 'Idea reference: [[Ideas/PDI Automation]]'
  },
  {
    name: 'Visibone',
    priority: 1,
    target_cadence_days: 30,
    status: 'waiting',
    next_action: 'Occasional review',
    notes: 'Idea reference: [[Ideas/Visibone]]'
  },
  {
    name: 'X-Growth-Plan-Khalaf',
    priority: 1,
    target_cadence_days: 30,
    status: 'waiting',
    next_action: 'Occasional review',
    notes: 'Idea reference: [[Ideas/X-Growth-Plan-Khalaf]]'
  }
]

function shouldCreateTaskFromNextAction(nextAction: string | null): boolean {
  if (!nextAction) {
    return false
  }

  const normalized = nextAction.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  return normalized !== 'tbd' && !normalized.startsWith('none')
}

function seedInitialWorkstreams(db: Database.Database): void {
  const insertSeedData = db.transaction(() => {
    const now = nowMs()

    const workstreamStatement = db.prepare(
      `
      INSERT INTO workstreams (
        name,
        priority,
        target_cadence_days,
        status,
        next_action,
        notes,
        chat_run_directory,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )

    const taskStatement = db.prepare(
      `
      INSERT INTO tasks (workstream_id, title, status, position, created_at, updated_at)
      VALUES (?, ?, 'todo', 0, ?, ?)
      `
    )

    const existingWorkstreamStatement = db.prepare(`SELECT id FROM workstreams WHERE name = ? LIMIT 1`)
    const backfillStatement = db.prepare(
      `
      UPDATE workstreams
      SET
        next_action = COALESCE(next_action, ?),
        notes = COALESCE(notes, ?),
        chat_run_directory = COALESCE(chat_run_directory, ?),
        updated_at = ?
      WHERE id = ?
      `
    )
    const taskCountStatement = db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE workstream_id = ?`)

    for (const seed of INITIAL_WORKSTREAMS) {
      const existing = existingWorkstreamStatement.get(seed.name) as { id: number } | undefined
      if (existing) {
        backfillStatement.run(seed.next_action, seed.notes, parseRepoPathFromNotes(seed.notes), now, existing.id)

        if (shouldCreateTaskFromNextAction(seed.next_action)) {
          const existingTaskCount = taskCountStatement.get(existing.id) as { count: number }
          if (existingTaskCount.count === 0) {
            taskStatement.run(existing.id, seed.next_action, now, now)
          }
        }

        continue
      }

      const insertResult = workstreamStatement.run(
        seed.name,
        seed.priority,
        seed.target_cadence_days,
        seed.status,
        seed.next_action,
        seed.notes,
        parseRepoPathFromNotes(seed.notes),
        now,
        now
      )

      if (shouldCreateTaskFromNextAction(seed.next_action)) {
        taskStatement.run(Number(insertResult.lastInsertRowid), seed.next_action, now, now)
      }
    }
  })

  insertSeedData()
}

function normalizeWorkstreamInput(data: CreateWorkstreamInput | UpdateWorkstreamInput): void {
  if (typeof data.priority === 'number' && (data.priority < 1 || data.priority > 5)) {
    throw new Error('Priority must be between 1 and 5')
  }

  if (
    typeof data.target_cadence_days === 'number' &&
    (!Number.isInteger(data.target_cadence_days) || data.target_cadence_days < 1)
  ) {
    throw new Error('Target cadence must be an integer >= 1')
  }
}

export function listWorkstreams(db = getDatabase()): Workstream[] {
  const rows = db
    .prepare(
      `
      SELECT
        id,
        name,
        priority,
        target_cadence_days,
        last_progress_at,
        status,
        next_action,
        notes,
        chat_run_directory,
        created_at,
        updated_at
      FROM workstreams
      ORDER BY created_at DESC
      `
    )
    .all() as Workstream[]

  return rows
}

export function getWorkstream(db: Database.Database, id: number): Workstream | null {
  const row = db
    .prepare(
      `
      SELECT
        id,
        name,
        priority,
        target_cadence_days,
        last_progress_at,
        status,
        next_action,
        notes,
        chat_run_directory,
        created_at,
        updated_at
      FROM workstreams
      WHERE id = ?
      `
    )
    .get(id) as Workstream | undefined

  return row ?? null
}

export function createWorkstream(data: CreateWorkstreamInput, db = getDatabase()): Workstream {
  normalizeWorkstreamInput(data)

  const now = nowMs()
  const status = data.status ?? 'active'
  const nextAction = typeof data.next_action === 'string' ? data.next_action.trim() || null : data.next_action ?? null
  const notes = typeof data.notes === 'string' ? data.notes.trim() || null : data.notes ?? null
  const chatRunDirectory =
    typeof data.chat_run_directory === 'string' ? data.chat_run_directory.trim() || null : data.chat_run_directory ?? null
  const result = db
    .prepare(
      `
      INSERT INTO workstreams (
        name,
        priority,
        target_cadence_days,
        status,
        next_action,
        notes,
        chat_run_directory,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(data.name.trim(), data.priority, data.target_cadence_days, status, nextAction, notes, chatRunDirectory, now, now)

  return getWorkstream(db, Number(result.lastInsertRowid)) as Workstream
}

export function updateWorkstream(id: number, data: UpdateWorkstreamInput, db = getDatabase()): void {
  normalizeWorkstreamInput(data)

  const updates: string[] = []
  const values: Array<string | number | null> = []

  if (typeof data.name === 'string') {
    updates.push('name = ?')
    values.push(data.name.trim())
  }

  if (typeof data.priority === 'number') {
    updates.push('priority = ?')
    values.push(data.priority)
  }

  if (typeof data.target_cadence_days === 'number') {
    updates.push('target_cadence_days = ?')
    values.push(data.target_cadence_days)
  }

  if (typeof data.status === 'string') {
    updates.push('status = ?')
    values.push(data.status)
  }

  if (data.next_action !== undefined) {
    updates.push('next_action = ?')
    if (typeof data.next_action === 'string') {
      values.push(data.next_action.trim() || null)
    } else {
      values.push(null)
    }
  }

  if (data.notes !== undefined) {
    updates.push('notes = ?')
    if (typeof data.notes === 'string') {
      values.push(data.notes.trim() || null)
    } else {
      values.push(null)
    }
  }

  if (data.chat_run_directory !== undefined) {
    updates.push('chat_run_directory = ?')
    if (typeof data.chat_run_directory === 'string') {
      values.push(data.chat_run_directory.trim() || null)
    } else {
      values.push(null)
    }
  }

  if (updates.length === 0) {
    return
  }

  updates.push('updated_at = ?')
  values.push(nowMs())
  values.push(id)

  db.prepare(`UPDATE workstreams SET ${updates.join(', ')} WHERE id = ?`).run(...values)
}

export function logProgress(workstreamId: number, note: string, db = getDatabase()): void {
  const trimmed = note.trim()
  if (!trimmed) {
    throw new Error('Progress note cannot be empty')
  }

  db.prepare(
    `
    INSERT INTO progress_updates (workstream_id, note, created_at)
    VALUES (?, ?, ?)
    `
  ).run(workstreamId, trimmed, nowMs())
}

export function listProgress(workstreamId: number, db = getDatabase()): ProgressUpdate[] {
  return db
    .prepare(
      `
      SELECT id, workstream_id, note, created_at
      FROM progress_updates
      WHERE workstream_id = ?
      ORDER BY created_at DESC
      `
    )
    .all(workstreamId) as ProgressUpdate[]
}

export function listTasks(workstreamId: number, db = getDatabase()): Task[] {
  db.prepare(
    `
    DELETE FROM tasks
    WHERE workstream_id = ? AND status = 'done'
    `
  ).run(workstreamId)

  return db
    .prepare(
      `
      SELECT id, workstream_id, title, status, position, created_at, updated_at
      FROM tasks
      WHERE workstream_id = ? AND status != 'done'
      ORDER BY position ASC, created_at ASC
      `
    )
    .all(workstreamId) as Task[]
}

export function createTask(data: CreateTaskInput, db = getDatabase()): Task {
  const now = nowMs()
  const result = db
    .prepare(
      `
      INSERT INTO tasks (workstream_id, title, status, position, created_at, updated_at)
      VALUES (?, ?, 'todo', COALESCE((SELECT MAX(position) + 1 FROM tasks WHERE workstream_id = ?), 0), ?, ?)
      `
    )
    .run(data.workstream_id, data.title.trim(), data.workstream_id, now, now)

  return db
    .prepare(
      `
      SELECT id, workstream_id, title, status, position, created_at, updated_at
      FROM tasks
      WHERE id = ?
      `
    )
    .get(result.lastInsertRowid) as Task
}

export function updateTask(id: number, data: UpdateTaskInput, db = getDatabase()): void {
  if (data.status === 'done') {
    deleteTask(id, db)
    return
  }

  const updates: string[] = []
  const values: Array<number | string> = []

  if (typeof data.title === 'string') {
    updates.push('title = ?')
    values.push(data.title.trim())
  }

  if (typeof data.status === 'string') {
    updates.push('status = ?')
    values.push(data.status)
  }

  if (typeof data.position === 'number') {
    updates.push('position = ?')
    values.push(data.position)
  }

  if (updates.length === 0) {
    return
  }

  updates.push('updated_at = ?')
  values.push(nowMs())
  values.push(id)

  db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteTask(id: number, db = getDatabase()): void {
  db.prepare(
    `
    DELETE FROM tasks
    WHERE id = ?
    `
  ).run(id)
}

export function listChatReferences(workstreamId: number, db = getDatabase()): ChatReference[] {
  return db
    .prepare(
      `
      SELECT
        id,
        workstream_id,
        source,
        conversation_uuid,
        conversation_title,
        last_user_message,
        chat_timestamp,
        linked_at
      FROM chat_references
      WHERE workstream_id = ?
      ORDER BY COALESCE(chat_timestamp, linked_at) DESC
      `
    )
    .all(workstreamId) as ChatReference[]
}

export function listLinkedConversationUuids(db = getDatabase()): string[] {
  const rows = db
    .prepare(
      `
      SELECT DISTINCT conversation_uuid
      FROM chat_references
      ORDER BY conversation_uuid ASC
      `
    )
    .all() as Array<{ conversation_uuid: string }>

  return rows.map((row) => row.conversation_uuid)
}

export function getLatestChatReference(workstreamId: number, db = getDatabase()): ChatReference | null {
  const row = db
    .prepare(
      `
      SELECT
        id,
        workstream_id,
        source,
        conversation_uuid,
        conversation_title,
        last_user_message,
        chat_timestamp,
        linked_at
      FROM chat_references
      WHERE workstream_id = ?
      ORDER BY COALESCE(chat_timestamp, linked_at) DESC
      LIMIT 1
      `
    )
    .get(workstreamId) as ChatReference | undefined

  return row ?? null
}

export function linkChatReference(
  workstreamId: number,
  payload: {
    conversation_uuid: string
    conversation_title?: string | null
    last_user_message?: string | null
    chat_timestamp?: number | null
    source?: string
  },
  db = getDatabase()
): void {
  db.prepare(
    `
    INSERT INTO chat_references (
      workstream_id,
      source,
      conversation_uuid,
      conversation_title,
      last_user_message,
      chat_timestamp,
      linked_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workstream_id, conversation_uuid)
    DO UPDATE SET
      source = excluded.source,
      conversation_title = excluded.conversation_title,
      last_user_message = excluded.last_user_message,
      chat_timestamp = excluded.chat_timestamp,
      linked_at = excluded.linked_at
    `
  ).run(
    workstreamId,
    payload.source ?? 'claude_cli',
    payload.conversation_uuid,
    payload.conversation_title ?? null,
    payload.last_user_message ?? null,
    payload.chat_timestamp ?? null,
    nowMs()
  )
}

export function unlinkChatReference(workstreamId: number, conversationUuid: string, db = getDatabase()): void {
  db.prepare(
    `
    DELETE FROM chat_references
    WHERE workstream_id = ? AND conversation_uuid = ?
    `
  ).run(workstreamId, conversationUuid)
}

export function getWorkstreamChatSession(workstreamId: number, db = getDatabase()): WorkstreamChatSession | null {
  const row = db
    .prepare(
      `
      SELECT
        workstream_id,
        session_id,
        project_cwd,
        updated_at
      FROM workstream_chat_sessions
      WHERE workstream_id = ?
      LIMIT 1
      `
    )
    .get(workstreamId) as WorkstreamChatSession | undefined

  return row ?? null
}

export function setWorkstreamChatSession(
  workstreamId: number,
  sessionId: string,
  projectCwd: string | null,
  db = getDatabase()
): WorkstreamChatSession {
  const updatedAt = nowMs()
  db.prepare(
    `
    INSERT INTO workstream_chat_sessions (
      workstream_id,
      session_id,
      project_cwd,
      updated_at
    )
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workstream_id)
    DO UPDATE SET
      session_id = excluded.session_id,
      project_cwd = excluded.project_cwd,
      updated_at = excluded.updated_at
    `
  ).run(workstreamId, sessionId, projectCwd, updatedAt)

  return getWorkstreamChatSession(workstreamId, db) as WorkstreamChatSession
}

export function getChatSessionPreference(conversationUuid: string, db = getDatabase()): ChatSessionPreference | null {
  const normalizedConversationUuid = conversationUuid.trim()
  if (!normalizedConversationUuid) {
    return null
  }

  const row = db
    .prepare(
      `
      SELECT conversation_uuid, command_mode, view_mode, updated_at
      FROM chat_session_preferences
      WHERE conversation_uuid = ?
      LIMIT 1
      `
    )
    .get(normalizedConversationUuid) as ChatSessionPreference | undefined

  return row ?? null
}

export function setChatSessionPreference(
  conversationUuid: string,
  patch: {
    command_mode?: 'claude' | 'cc'
    view_mode?: 'chat' | 'terminal'
  },
  db = getDatabase()
): ChatSessionPreference {
  const normalizedConversationUuid = conversationUuid.trim()
  if (!normalizedConversationUuid) {
    throw new Error('conversation uuid must not be empty')
  }

  const existing = getChatSessionPreference(normalizedConversationUuid, db)
  const commandMode = patch.command_mode ?? existing?.command_mode ?? 'claude'
  const viewMode = patch.view_mode ?? existing?.view_mode ?? 'chat'

  db.prepare(
    `
    INSERT INTO chat_session_preferences (
      conversation_uuid,
      command_mode,
      view_mode,
      updated_at
    )
    VALUES (?, ?, ?, ?)
    ON CONFLICT(conversation_uuid)
    DO UPDATE SET
      command_mode = excluded.command_mode,
      view_mode = excluded.view_mode,
      updated_at = excluded.updated_at
    `
  ).run(normalizedConversationUuid, commandMode, viewMode, nowMs())

  return getChatSessionPreference(normalizedConversationUuid, db) as ChatSessionPreference
}

interface StoredContextDocRow {
  id: number
  workstream_id: number
  conversation_uuid: string
  source: 'obsidian' | 'file'
  reference: string
  normalized_reference: string
  created_at: number
  updated_at: number
}

interface StoredWorkstreamContextDocRow {
  id: number
  workstream_id: number
  source: 'obsidian' | 'file'
  reference: string
  normalized_reference: string
  created_at: number
  updated_at: number
}

export function listWorkstreamContextDocuments(
  workstreamId: number,
  db = getDatabase()
): StoredWorkstreamContextDocRow[] {
  return db
    .prepare(
      `
      SELECT
        id,
        workstream_id,
        source,
        reference,
        normalized_reference,
        created_at,
        updated_at
      FROM workstream_context_documents
      WHERE workstream_id = ?
      ORDER BY created_at ASC, id ASC
      `
    )
    .all(workstreamId) as StoredWorkstreamContextDocRow[]
}

export function replaceWorkstreamContextDocuments(
  workstreamId: number,
  docs: ContextDocInput[],
  db = getDatabase()
): StoredWorkstreamContextDocRow[] {
  const now = nowMs()
  const dedupedDocs: Array<{ source: 'obsidian' | 'file'; reference: string; normalized_reference: string }> = []
  const seen = new Set<string>()

  for (const doc of docs) {
    if (doc.source !== 'obsidian' && doc.source !== 'file') {
      continue
    }

    const reference = doc.reference.trim()
    if (!reference) {
      continue
    }

    const normalizedReference = normalizeContextReference(doc.source, reference)
    if (!normalizedReference || seen.has(normalizedReference)) {
      continue
    }

    seen.add(normalizedReference)
    dedupedDocs.push({
      source: doc.source,
      reference,
      normalized_reference: normalizedReference
    })
  }

  const tx = db.transaction(() => {
    db.prepare(
      `
      DELETE FROM workstream_context_documents
      WHERE workstream_id = ?
      `
    ).run(workstreamId)

    const insert = db.prepare(
      `
      INSERT INTO workstream_context_documents (
        workstream_id,
        source,
        reference,
        normalized_reference,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `
    )

    for (const doc of dedupedDocs) {
      insert.run(workstreamId, doc.source, doc.reference, doc.normalized_reference, now, now)
    }
  })

  tx()
  return listWorkstreamContextDocuments(workstreamId, db)
}

export function listSessionContextDocuments(
  workstreamId: number,
  conversationUuid: string,
  db = getDatabase()
): StoredContextDocRow[] {
  return db
    .prepare(
      `
      SELECT
        id,
        workstream_id,
        conversation_uuid,
        source,
        reference,
        normalized_reference,
        created_at,
        updated_at
      FROM chat_context_documents
      WHERE workstream_id = ? AND conversation_uuid = ?
      ORDER BY created_at ASC, id ASC
      `
    )
    .all(workstreamId, conversationUuid) as StoredContextDocRow[]
}

export function replaceSessionContextDocuments(
  workstreamId: number,
  conversationUuid: string,
  docs: ContextDocInput[],
  db = getDatabase()
): StoredContextDocRow[] {
  const now = nowMs()
  const dedupedDocs: Array<{ source: 'obsidian' | 'file'; reference: string; normalized_reference: string }> = []
  const seen = new Set<string>()

  for (const doc of docs) {
    if (doc.source !== 'obsidian' && doc.source !== 'file') {
      continue
    }

    const reference = doc.reference.trim()
    if (!reference) {
      continue
    }

    const normalizedReference = normalizeContextReference(doc.source, reference)
    if (!normalizedReference || seen.has(normalizedReference)) {
      continue
    }

    seen.add(normalizedReference)
    dedupedDocs.push({
      source: doc.source,
      reference,
      normalized_reference: normalizedReference
    })
  }

  const tx = db.transaction(() => {
    db.prepare(
      `
      DELETE FROM chat_context_documents
      WHERE workstream_id = ? AND conversation_uuid = ?
      `
    ).run(workstreamId, conversationUuid)

    const insert = db.prepare(
      `
      INSERT INTO chat_context_documents (
        workstream_id,
        conversation_uuid,
        source,
        reference,
        normalized_reference,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    )

    for (const doc of dedupedDocs) {
      insert.run(workstreamId, conversationUuid, doc.source, doc.reference, doc.normalized_reference, now, now)
    }
  })

  tx()
  return listSessionContextDocuments(workstreamId, conversationUuid, db)
}

export function getSessionContextFingerprint(conversationUuid: string, db = getDatabase()): string | null {
  const row = db
    .prepare(
      `
      SELECT context_fingerprint
      FROM chat_context_state
      WHERE conversation_uuid = ?
      LIMIT 1
      `
    )
    .get(conversationUuid) as { context_fingerprint: string } | undefined

  return row?.context_fingerprint ?? null
}

export function setSessionContextFingerprint(
  workstreamId: number,
  conversationUuid: string,
  contextFingerprint: string,
  db = getDatabase()
): void {
  db.prepare(
    `
    INSERT INTO chat_context_state (
      conversation_uuid,
      workstream_id,
      context_fingerprint,
      updated_at
    )
    VALUES (?, ?, ?, ?)
    ON CONFLICT(conversation_uuid)
    DO UPDATE SET
      workstream_id = excluded.workstream_id,
      context_fingerprint = excluded.context_fingerprint,
      updated_at = excluded.updated_at
    `
  ).run(conversationUuid, workstreamId, contextFingerprint, nowMs())
}

export function listWorkstreamsWithLatestChat(db = getDatabase()): WorkstreamListItem[] {
  const workstreams = listWorkstreams(db)
  return workstreams.map((workstream) => ({
    ...workstream,
    score: {
      priority_score: 0,
      staleness_ratio: 0,
      staleness_score: 0,
      blocked_penalty: 0,
      total_score: 0,
      days_since_progress: 0,
      staleness_basis: 'progress',
      staleness_reference_at: workstream.created_at
    },
    ranking_explanation: '',
    last_chat: getLatestChatReference(workstream.id, db)
  }))
}

function defaultClaudePath(): string {
  return path.join(process.env.HOME ?? '', '.claude', 'projects')
}

export function getOrCreateClaudeSyncSource(db = getDatabase()): SyncSource {
  const existing = db
    .prepare(
      `
      SELECT id, type, config, created_at, updated_at
      FROM sync_sources
      WHERE type IN ('claude_cli', 'claude_desktop')
      ORDER BY CASE type WHEN 'claude_cli' THEN 0 ELSE 1 END
      LIMIT 1
      `
    )
    .get() as SyncSource | undefined

  if (existing) {
    if (existing.type !== 'claude_cli') {
      db.prepare(
        `
        UPDATE sync_sources
        SET type = 'claude_cli', updated_at = ?
        WHERE id = ?
        `
      ).run(nowMs(), existing.id)

      return db
        .prepare(
          `
          SELECT id, type, config, created_at, updated_at
          FROM sync_sources
          WHERE id = ?
          `
        )
        .get(existing.id) as SyncSource
    }

    return existing
  }

  const now = nowMs()
  const config = JSON.stringify({ path: defaultClaudePath() })
  const result = db
    .prepare(
      `
      INSERT INTO sync_sources (type, config, created_at, updated_at)
      VALUES ('claude_cli', ?, ?, ?)
      `
    )
    .run(config, now, now)

  return db
    .prepare(
      `
      SELECT id, type, config, created_at, updated_at
      FROM sync_sources
      WHERE id = ?
      `
    )
    .get(result.lastInsertRowid) as SyncSource
}

export function updateClaudeSourcePath(claudePath: string, db = getDatabase()): SyncSource {
  const source = getOrCreateClaudeSyncSource(db)
  const now = nowMs()
  db.prepare(
    `
    UPDATE sync_sources
    SET config = ?, updated_at = ?
    WHERE id = ?
    `
  ).run(JSON.stringify({ path: claudePath }), now, source.id)

  return db
    .prepare(
      `
      SELECT id, type, config, created_at, updated_at
      FROM sync_sources
      WHERE id = ?
      `
    )
    .get(source.id) as SyncSource
}

export function createSyncRun(sourceId: number, status: SyncRunStatus, details: string | null, db = getDatabase()): number {
  const result = db
    .prepare(
      `
      INSERT INTO sync_runs (source_id, status, started_at, completed_at, details)
      VALUES (?, ?, ?, ?, ?)
      `
    )
    .run(sourceId, status, nowMs(), status === 'running' ? null : nowMs(), details)

  return Number(result.lastInsertRowid)
}

export function completeSyncRun(
  runId: number,
  status: Exclude<SyncRunStatus, 'running'>,
  details: string | null,
  db = getDatabase()
): void {
  db.prepare(
    `
    UPDATE sync_runs
    SET status = ?, completed_at = ?, details = ?
    WHERE id = ?
    `
  ).run(status, nowMs(), details, runId)
}

export function listSyncRuns(sourceId: number, db = getDatabase()): SyncRun[] {
  return db
    .prepare(
      `
      SELECT id, source_id, status, started_at, completed_at, details
      FROM sync_runs
      WHERE source_id = ?
      ORDER BY started_at DESC
      LIMIT 50
      `
    )
    .all(sourceId) as SyncRun[]
}
