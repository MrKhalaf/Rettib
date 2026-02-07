import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

import type {
  ChatReference,
  CreateTaskInput,
  CreateWorkstreamInput,
  ProgressUpdate,
  SyncRun,
  SyncRunStatus,
  SyncSource,
  Task,
  UpdateTaskInput,
  UpdateWorkstreamInput,
  Workstream,
  WorkstreamListItem
} from '../shared/types'

const SCHEMA_VERSION = 2

let dbInstance: Database.Database | null = null

function nowMs(): number {
  return Date.now()
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

      CREATE INDEX IF NOT EXISTS idx_workstreams_status ON workstreams(status);
      CREATE INDEX IF NOT EXISTS idx_workstreams_progress ON workstreams(last_progress_at);
      CREATE INDEX IF NOT EXISTS idx_progress_updates_workstream ON progress_updates(workstream_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_workstream ON tasks(workstream_id, status, position);
      CREATE INDEX IF NOT EXISTS idx_chat_refs_workstream ON chat_references(workstream_id, chat_timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_sync_runs_source ON sync_runs(source_id, started_at DESC);

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
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
        updated_at = ?
      WHERE id = ?
      `
    )
    const taskCountStatement = db.prepare(`SELECT COUNT(*) as count FROM tasks WHERE workstream_id = ?`)

    for (const seed of INITIAL_WORKSTREAMS) {
      const existing = existingWorkstreamStatement.get(seed.name) as { id: number } | undefined
      if (existing) {
        backfillStatement.run(seed.next_action, seed.notes, now, existing.id)

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
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(data.name.trim(), data.priority, data.target_cadence_days, status, nextAction, notes, now, now)

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
  return db
    .prepare(
      `
      SELECT id, workstream_id, title, status, position, created_at, updated_at
      FROM tasks
      WHERE workstream_id = ?
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
    payload.source ?? 'claude_desktop',
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
      days_since_progress: 0
    },
    ranking_explanation: '',
    last_chat: getLatestChatReference(workstream.id, db)
  }))
}

function defaultClaudePath(): string {
  return path.join(process.env.HOME ?? '', 'Library/Application Support/Claude/Local Storage/leveldb')
}

export function getOrCreateClaudeSyncSource(db = getDatabase()): SyncSource {
  const existing = db
    .prepare(
      `
      SELECT id, type, config, created_at, updated_at
      FROM sync_sources
      WHERE type = 'claude_desktop'
      LIMIT 1
      `
    )
    .get() as SyncSource | undefined

  if (existing) {
    return existing
  }

  const now = nowMs()
  const config = JSON.stringify({ path: defaultClaudePath() })
  const result = db
    .prepare(
      `
      INSERT INTO sync_sources (type, config, created_at, updated_at)
      VALUES ('claude_desktop', ?, ?, ?)
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
