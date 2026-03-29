import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

export interface WorktreeInfo {
  path: string
  branch: string
  baseRepo: string
}

const DEFAULT_ROOT = path.join(os.homedir(), '.rettib', 'worktrees')

export class WorktreeService {
  private worktreeRoot: string

  constructor(worktreeRoot: string = DEFAULT_ROOT) {
    this.worktreeRoot = worktreeRoot
    fs.mkdirSync(worktreeRoot, { recursive: true })
  }

  createWorktree(taskId: number, baseRepoPath: string): WorktreeInfo {
    const branch = `rettib/task-${taskId}`
    const worktreePath = path.join(this.worktreeRoot, `task-${taskId}`)

    if (fs.existsSync(worktreePath)) {
      return { path: worktreePath, branch, baseRepo: baseRepoPath }
    }

    execFileSync('git', ['-C', baseRepoPath, 'worktree', 'add', '-b', branch, worktreePath], {
      timeout: 15_000,
      encoding: 'utf8'
    })

    return { path: worktreePath, branch, baseRepo: baseRepoPath }
  }

  removeWorktree(taskId: number, baseRepoPath: string): void {
    const worktreePath = path.join(this.worktreeRoot, `task-${taskId}`)
    if (!fs.existsSync(worktreePath)) return

    execFileSync('git', ['-C', baseRepoPath, 'worktree', 'remove', worktreePath, '--force'], {
      timeout: 15_000,
      encoding: 'utf8'
    })

    const branch = `rettib/task-${taskId}`
    try {
      execFileSync('git', ['-C', baseRepoPath, 'branch', '-D', branch], {
        timeout: 5_000,
        encoding: 'utf8'
      })
    } catch {
      // Branch may already be deleted
    }
  }

  listWorktrees(baseRepoPath: string): WorktreeInfo[] {
    let output: string
    try {
      output = execFileSync('git', ['-C', baseRepoPath, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8',
        timeout: 5_000
      })
    } catch {
      return []
    }

    const results: WorktreeInfo[] = []
    let currentPath: string | null = null
    let currentBranch: string | null = null

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length)
      } else if (line.startsWith('branch ')) {
        currentBranch = line.slice('branch '.length).replace('refs/heads/', '')
      } else if (line === '') {
        if (currentPath && currentBranch?.startsWith('rettib/task-')) {
          results.push({ path: currentPath, branch: currentBranch, baseRepo: baseRepoPath })
        }
        currentPath = null
        currentBranch = null
      }
    }

    return results
  }

  getWorktreePath(taskId: number): string {
    return path.join(this.worktreeRoot, `task-${taskId}`)
  }

  worktreeExists(taskId: number): boolean {
    return fs.existsSync(this.getWorktreePath(taskId))
  }
}
