 Rettib V1 Implementation Plan

 Project: Personal project management tool with priority-based ranking and Claude Desktop
 integration
 Location: /Users/mohammadkhalaf/Projects/Rettib (empty directory, starting fresh)

 Overview

 Build a local-first Electron app that helps prioritize work using:
 - Ranking formula: priority * 20 + min(staleness_ratio, 3) * 30 + blocked_penalty
 - Staleness ratio: days_since_last_progress / target_cadence_days
 - Claude integration: Show last user message + relative timestamp from Claude Desktop
 chat history

 Tech Stack

 - Desktop: Electron 28 + React 18 + Vite 5 + TypeScript 5
 - Database: SQLite (better-sqlite3)
 - State: TanStack Query for data fetching
 - Claude Import: LevelDB reader (level package) for ~/Library/Application
 Support/Claude/Local Storage/leveldb/

 Data Model

 workstreams (id, name, priority[1-5], target_cadence_days, last_progress_at, status)
 tasks (id, workstream_id, title, status, position)
 progress_updates (id, workstream_id, note, created_at)
 chat_references (id, workstream_id, conversation_uuid, last_user_message, chat_timestamp)
 sync_sources (id, type, config)
 sync_runs (id, source_id, status, started_at, completed_at)

 Key trigger: Insert into progress_updates → auto-update workstreams.last_progress_at

 Architecture

 Main Process (Node.js)

 - src/main/database.ts - SQLite setup, schema, CRUD operations
 - src/main/ranking-engine.ts - Calculate scores: calculateRankings(db) → sorted array
 - src/main/claude-connector.ts - Read LevelDB, extract conversations
 - src/main/ipc-handlers.ts - Register IPC channels (see API contract below)

 Renderer Process (React)

 - src/renderer/components/Dashboard.tsx - Ranked workstream list
 - src/renderer/components/WorkstreamCard.tsx - Shows score + breakdown
 - src/renderer/components/RankingExplainer.tsx - Visual score components
 - src/renderer/components/QuickCapture.tsx - Modal to log progress
 - src/renderer/components/WorkstreamDetail.tsx - Deep dive view
 - src/renderer/components/SyncSettings.tsx - Claude import UI
 - src/renderer/hooks/useWorkstreams.ts - TanStack Query wrapper
 - src/renderer/hooks/useProgress.ts - Mutation for logging

 IPC API Contract

 // Workstreams
 'workstreams:list' → WorkstreamWithScore[]  // Pre-ranked by main process
 'workstreams:get' (id) → WorkstreamDetail
 'workstreams:create' (data) → Workstream
 'workstreams:update' (id, data) → void

 // Progress
 'progress:log' (workstreamId, note) → void
 'progress:list' (workstreamId) → ProgressUpdate[]

 // Tasks
 'tasks:list' (workstreamId) → Task[]
 'tasks:create' (workstreamId, title) → Task
 'tasks:update' (id, data) → void

 // Claude
 'chat:list-conversations' → ConversationMetadata[]
 'chat:link' (workstreamId, conversationUuid) → void
 'chat:unlink' (workstreamId, conversationUuid) → void

 // Sync
 'sync:run' (sourceId) → void
 'sync:runs' (sourceId) → SyncRun[]

 Critical Files

 1. /Users/mohammadkhalaf/Projects/Rettib/src/main/database.ts

 Purpose: Core data layer - all features depend on this

 Key functions:
 export function initDatabase(): Database  // Schema + migrations
 export function createWorkstream(data): Workstream
 export function listWorkstreams(): Workstream[]
 export function updateWorkstream(id, data): void
 export function logProgress(workstreamId, note): void

 Includes:
 - Full SQL schema with triggers
 - Schema versioning via PRAGMA user_version
 - Foreign key constraints enabled

 2. /Users/mohammadkhalaf/Projects/Rettib/src/main/ranking-engine.ts

 Purpose: Heart of the product - implements staleness + priority formula

 Key functions:
 export function calculateRankings(db: Database): WorkstreamWithScore[]
 export function getRankingExplanation(score: WorkstreamScore): string

 Formula implementation:
 priorityScore = ws.priority * 20
 daysSinceProgress = ws.last_progress_at ? (now - ws.last_progress_at) / 86400000 : 999
 stalenessRatio = daysSinceProgress / ws.target_cadence_days
 stalenessScore = Math.min(stalenessRatio, 3) * 30
 blockedPenalty = ws.status === 'blocked' ? -25 : 0
 totalScore = priorityScore + stalenessScore + blockedPenalty

 3. /Users/mohammadkhalaf/Projects/Rettib/src/main/claude-connector.ts

 Purpose: Unique differentiator - parse Claude Desktop chat history

 Key class:
 export class ClaudeConnector {
   async listConversations(): Promise<ClaudeConversation[]>
   async getConversationDetail(uuid: string): Promise<ClaudeConversation | null>
   private extractLastUserMessage(editorState: any): string | null
 }

 export async function importClaudeConversations(db: Database): Promise<number>

 Technical notes:
 - Reads from ~/Library/Application Support/Claude/Local Storage/leveldb/
 - Parses keys matching LSS-[UUID]:conversation:[property]
 - Extracts: conversation UUID, timestamp (Unix ms), last user message
 - Text content in editor state format: {type:"doc", content:[{type:"paragraph",...}]}

 4. /Users/mohammadkhalaf/Projects/Rettib/src/main/ipc-handlers.ts

 Purpose: API contract between main and renderer

 export function registerIpcHandlers() {
   ipcMain.handle('workstreams:list', async () => {
     const db = getDatabase()
     return calculateRankings(db)  // Returns pre-sorted
   })

   ipcMain.handle('progress:log', async (_, workstreamId: number, note: string) => {
     const db = getDatabase()
     logProgress(workstreamId, note)  // Trigger updates last_progress_at
   })

   ipcMain.handle('chat:list-conversations', async () => {
     const connector = new ClaudeConnector()
     return connector.listConversations()
   })

   // ... etc
 }

 5. /Users/mohammadkhalaf/Projects/Rettib/src/renderer/components/Dashboard.tsx

 Purpose: Primary UI - where users spend 80% of time

 export function Dashboard({ onSelectWorkstream }: Props) {
   const { data: rankedWorkstreams, isLoading } = useWorkstreams()

   // TanStack Query auto-refetches every 30s for staleness updates

   return (
     <div className="dashboard">
       <h1>Your Workstreams</h1>
       <div className="workstream-list">
         {rankedWorkstreams?.map((ws, index) => (
           <WorkstreamCard
             key={ws.id}
             workstream={ws}
             rank={index + 1}  // #1, #2, #3...
             onClick={() => onSelectWorkstream(ws.id)}
           />
         ))}
       </div>
       <button onClick={/* create new */}>+ New Workstream</button>
     </div>
   )
 }

 Must show: Rank number, score breakdown, "why this rank" explanation

 Implementation Phases

 Phase 0: Scaffolding (30 min)

 Goal: Electron + React "Hello World"

 Create:
 - package.json with dependencies (electron, react, vite, better-sqlite3, level,
 @tanstack/react-query)
 - vite.config.ts, tsconfig.json
 - src/main/index.ts - minimal Electron main
 - src/preload/index.ts - empty preload
 - src/renderer/index.html, main.tsx, App.tsx

 Validation: npm run dev launches Electron window

 Phase 1: Database Foundation (1-2 hours)

 Goal: SQLite with schema and CRUD

 Create:
 - src/main/database.ts with full schema
 - Test: Insert workstreams, verify triggers work

 Validation: Main process can create/read workstreams

 Phase 2: Ranking Engine (1 hour)

 Goal: Calculate scores and produce sorted list

 Create:
 - src/main/ranking-engine.ts
 - Seed DB with 3-5 workstreams with different priorities/staleness
 - Verify ranking order matches expectations

 Phase 3: IPC Bridge (2 hours)

 Goal: Connect main to renderer

 Create:
 - src/main/ipc-handlers.ts
 - src/preload/index.ts - expose window.electronAPI
 - src/renderer/types/index.ts - shared TypeScript types
 - src/renderer/api/workstreams.ts, progress.ts - client wrappers
 - src/renderer/hooks/useWorkstreams.ts, useProgress.ts

 Validation: window.electronAPI.workstreams.list() works from DevTools

 Phase 4: Dashboard UI (3-4 hours)

 Goal: Display ranked workstreams

 Create:
 - Dashboard.tsx, WorkstreamCard.tsx, RankingExplainer.tsx, StatusBadge.tsx
 - src/renderer/styles/globals.css

 Validation: Dashboard shows ranked list with score breakdown

 Phase 5: Quick Capture (2 hours)

 Goal: Log progress and see ranking update

 Create:
 - QuickCapture.tsx - modal with workstream selector + textarea

 Validation:
 - Log progress for a workstream
 - See its rank change in dashboard
 - last_progress_at updated in DB

 Phase 6: Claude Connector (3-4 hours)

 Goal: Import Claude conversations

 Create:
 - src/main/claude-connector.ts - LevelDB reader
 - SyncSettings.tsx - UI for import
 - src/renderer/api/sync.ts

 Validation:
 - Click "Import Conversations"
 - See list of Claude chats with last user message
 - Link chat to workstream
 - View in workstream detail

 Phase 7: Workstream Detail View (2-3 hours)

 Goal: Deep dive into single workstream

 Create:
 - WorkstreamDetail.tsx, TaskCard.tsx

 Validation: Click card → see next task, recent progress, linked chats

 Phase 8: Polish (1-2 hours)

 - Add keyboard shortcut (Cmd+K) for quick capture
 - App icon
 - System tray icon (optional)
 - electron-builder.yml for packaging

 1-Day MVP Scope

 Goal: Validate ranking concept with minimal features

 In Scope:

 - Manual workstream creation (name, priority, cadence)
 - Dashboard with ranked list + explanations
 - Quick capture to log progress
 - Basic detail view

 Out of Scope (defer):

 - Claude connector
 - Tasks management
 - Sync settings
 - Onboarding flow

 Timeline: ~7 hours focused work (Phases 0-5)

 Ranking Formula Validation Tests

 Manual test cases:
 1. Never worked on: Should rank at top (staleness_ratio = ∞)
 2. 2x overdue (6 days since progress, 3-day cadence): staleness_score = 60
 3. On schedule (2 days since progress, 3-day cadence): staleness_score = 20
 4. Priority 5 vs Priority 1 (same staleness): P5 should rank 80 points higher
 5. Blocked: Should have -25 penalty

 Expected dashboard order after test data:
 1. Never-worked-on P5 workstream (score ~190)
 2. 2x overdue P5 workstream (score ~160)
 3. On-schedule P5 workstream (score ~120)
 4. 2x overdue P1 workstream (score ~80)
 5. Blocked P5 workstream (score ~95)

 Extensibility

 Adding New Connectors

 Pattern (demonstrated by Claude connector):

 1. Create src/main/connectors/[name]-connector.ts
 2. Implement interface:
 interface Connector {
   type: string
   listItems(): Promise<ConnectorItem[]>
   importToDatabase(db: Database): Promise<number>
 }
 3. Add sync source type to schema (supports 'claude_desktop', 'github', 'linear')
 4. Add IPC handler: sync:run-[type]
 5. Add UI panel in SyncSettings.tsx

 Examples ready to add later:
 - GitHub repos → workstreams (use Octokit)
 - Linear projects → workstreams (use Linear SDK)

 Verification

 After implementation:
 1. Create 3 workstreams with different priorities (1, 3, 5) and same cadence (7 days)
 2. Log progress on P1 workstream
 3. Check ranking: P5 and P3 should rank above P1 (due to staleness)
 4. Wait 1 minute, refresh
 5. Check ranking: Should remain stable (staleness hasn't changed enough)
 6. Manually set P5 workstream's last_progress_at to 14 days ago
 7. Check ranking: P5 should jump to #1 (2x overdue on 7-day cadence)
 8. Mark P5 as blocked
 9. Check ranking: P5 should drop due to -25 penalty
 10. Import Claude chats (if Phase 6 complete)
 11. Link chat to P1 workstream
 12. Open P1 detail view: Should show linked chat with timestamp

 Notes

 - All timestamps in Unix milliseconds
 - TanStack Query refetch interval: 30s (keeps staleness scores current)
 - SQLite file location: ~/Library/Application Support/Rettib/rettib.db
 - Claude LevelDB: Read-only access (no corruption risk)
 - Ranking calculated on-demand in main process (fast with <100 workstreams)
 - Future: Add background worker for periodic Claude sync

 Dependencies

 {
   "dependencies": {
     "better-sqlite3": "^11.7.0",
     "electron": "^28.0.0",
     "level": "^8.0.1",
     "react": "^18.2.0",
     "react-dom": "^18.2.0",
     "@tanstack/react-query": "^5.17.0"
   },
   "devDependencies": {
     "@types/better-sqlite3": "^7.6.8",
     "@types/node": "^20.10.0",
     "@types/react": "^18.2.45",
     "@types/react-dom": "^18.2.18",
     "@vitejs/plugin-react": "^4.2.1",
     "electron-builder": "^24.9.0",
     "typescript": "^5.3.3",
     "vite": "^5.0.8",
     "vite-plugin-electron": "^0.28.0"
   }
 }
