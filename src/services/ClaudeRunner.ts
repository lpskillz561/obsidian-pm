import type { ChildProcess } from 'node:child_process'
import { FileSystemAdapter, Notice, Platform } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, Task } from '../types'

/**
 * Node's API, pulled in on first use rather than imported.
 *
 * The manifest sets `isDesktopOnly: false`, so this module is evaluated on
 * mobile as well — and a static import of `child_process` compiles to a
 * top-level require that would throw there and take the whole plugin down with
 * it. Every caller below is already behind a `Platform.isDesktopApp` check.
 *
 * The require calls are the point, not an oversight: an import statement is
 * hoisted, and hoisting is exactly what we are avoiding here.
 */
function node(): {
  cp: typeof import('node:child_process')
  fs: typeof import('node:fs/promises')
  os: typeof import('node:os')
  path: typeof import('node:path')
} {
  /* eslint-disable @typescript-eslint/no-require-imports */
  // oxlint-disable typescript/no-require-imports
  return {
    cp: require('node:child_process') as typeof import('node:child_process'),
    fs: require('node:fs/promises') as typeof import('node:fs/promises'),
    os: require('node:os') as typeof import('node:os'),
    path: require('node:path') as typeof import('node:path')
  }
  // oxlint-enable typescript/no-require-imports
  /* eslint-enable @typescript-eslint/no-require-imports */
}

export type RunPhase = 'running' | 'error'

export interface RunState {
  phase: RunPhase
  startedAt: number
  /** Set when phase is 'error'. Shown in the card tooltip. */
  message?: string
}

/** Shape written to the handoff file. Mirrored in the skill's SKILL.md. */
interface Handoff {
  runId: string
  vault: string
  taskFile: string
  taskId: string
  taskTitle: string
  taskType: string
  taskStatus: string
  priority: string
  tags: string[]
  description: string
  project: string
  projectFile: string
  repo: string
  question?: string
}

/** The `--output-format json` envelope, minus the fields we ignore. */
interface ResultEnvelope {
  is_error?: boolean
  result?: string
}

/** How long an error badge lingers on the card before clearing itself. */
const ERROR_LINGER_MS = 60_000

export class ClaudeRunner {
  /** taskId → state. Runtime only; a restart clears it and orphans nothing. */
  private runs = new Map<string, RunState>()
  private processes = new Map<string, ChildProcess>()
  private listeners = new Set<() => void>()

  constructor(private plugin: PMPlugin) {}

  stateFor(taskId: string): RunState | undefined {
    return this.runs.get(taskId)
  }

  isRunning(taskId: string): boolean {
    return this.runs.get(taskId)?.phase === 'running'
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try {
        cb()
      } catch (e) {
        console.error('[PM] Claude run listener failed:', e)
      }
    }
  }

  /**
   * Is the feature usable right now? Returns a reason string when it is not, so
   * callers can explain themselves instead of silently hiding a menu item.
   */
  unavailableReason(): string | null {
    const cfg = this.plugin.settings.claude
    if (!cfg.enabled) return 'Claude tasks are turned off in settings.'
    if (!Platform.isDesktopApp) return 'Claude tasks need the desktop app.'
    if (!cfg.binaryPath) return 'No path to the claude binary is set.'
    if (!cfg.configDir) return 'No Claude config directory is set.'
    return null
  }

  /** Absolute path of the repo this project maps to, or null if unmapped. */
  repoFor(project: Project): string | null {
    return this.plugin.settings.claude.repoPaths[project.filePath] || null
  }

  cancel(taskId: string): void {
    const proc = this.processes.get(taskId)
    if (!proc) return
    proc.kill('SIGTERM')
    this.finish(taskId, 'Cancelled.')
  }

  /**
   * Run the agent against one task and refresh when it lands.
   *
   * Resolves when the run finishes — but callers usually shouldn't await it.
   * A real investigation takes minutes; the card badge is the progress UI.
   */
  async run(project: Project, task: Task, opts: { question?: string; onUpdate?: () => void } = {}): Promise<void> {
    const blocked = this.unavailableReason()
    if (blocked) {
      new Notice(blocked)
      return
    }
    if (this.isRunning(task.id)) {
      new Notice(`Claude is already working on "${task.title}".`)
      return
    }
    const repo = this.repoFor(project)
    if (!repo) {
      new Notice(`No repo is mapped to "${project.title}". Set one in Project Manager settings.`)
      return
    }
    const vault = this.vaultPath()
    if (!vault || !task.filePath) {
      new Notice('This task has no file on disk yet. Save it first.')
      return
    }

    const { fs, os, path } = node()
    const startedAt = Date.now()
    const runId = `pm-${task.id}-${startedAt.toString(36)}`
    const unsubscribe = opts.onUpdate ? this.onChange(opts.onUpdate) : null

    this.runs.set(task.id, { phase: 'running', startedAt })
    this.emit()

    // Description lives in the note body and may not be loaded yet — the agent
    // needs it, since it is the actual statement of the problem.
    await this.plugin.store.loadTaskBody(task)

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-claude-'))
    const handoffPath = path.join(dir, 'handoff.json')
    const handoff: Handoff = {
      runId,
      vault,
      taskFile: path.join(vault, task.filePath),
      taskId: task.id,
      taskTitle: task.title,
      taskType: task.type,
      taskStatus: task.status,
      priority: task.priority,
      tags: task.tags,
      description: task.description,
      project: project.title,
      projectFile: path.join(vault, project.filePath),
      repo,
      ...(opts.question ? { question: opts.question } : {})
    }

    try {
      await fs.writeFile(handoffPath, JSON.stringify(handoff, null, 2), 'utf8')
      const envelope = await this.spawnClaude(task.id, handoffPath, dir, repo)
      await this.absorbResult(task, envelope, startedAt)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error(`[PM] Claude run failed for "${task.title}":`, e)
      new Notice(`Claude failed on "${task.title}": ${message}`)
      this.finish(task.id, message)
    } finally {
      this.processes.delete(task.id)
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      // Give the final refresh a tick to run before dropping the listener.
      window.setTimeout(() => unsubscribe?.(), 0)
    }
  }

  private spawnClaude(taskId: string, handoffPath: string, handoffDir: string, repo: string): Promise<ResultEnvelope> {
    const { cp, path } = node()
    const cfg = this.plugin.settings.claude
    const script = path.join(cfg.configDir, 'skills', 'obsidian-pm-task', 'scripts', 'pm_comment.py')

    // Read-only, plus exactly one command that can write — the comment script.
    // In print mode anything outside the allowlist is denied rather than
    // prompting, so this is a hard boundary, not a suggestion.
    const allowed = [
      'Read',
      'Grep',
      'Glob',
      'Bash(git log:*)',
      'Bash(git diff:*)',
      'Bash(git show:*)',
      'Bash(git status:*)',
      'Bash(git blame:*)',
      `Bash(python3 ${script}:*)`
    ].join(' ')

    const args = [
      '-p',
      `/obsidian-pm-task ${handoffPath}`,
      '--output-format',
      'json',
      '--add-dir',
      handoffDir,
      '--allowedTools',
      allowed
    ]
    if (cfg.model) args.push('--model', cfg.model)

    return new Promise((resolve, reject) => {
      const proc = cp.spawn(cfg.binaryPath, args, {
        cwd: repo,
        env: { ...process.env, CLAUDE_CONFIG_DIR: cfg.configDir },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.processes.set(taskId, proc)

      let stdout = ''
      let stderr = ''
      proc.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))

      const timer = window.setTimeout(
        () => {
          proc.kill('SIGTERM')
          reject(new Error(`timed out after ${cfg.timeoutMinutes} min`))
        },
        Math.max(1, cfg.timeoutMinutes) * 60_000
      )

      proc.on('error', (e) => {
        window.clearTimeout(timer)
        // ENOENT here almost always means binaryPath is wrong or unset.
        reject(new Error(`could not start ${cfg.binaryPath}: ${e.message}`))
      })

      proc.on('close', (code) => {
        window.clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(stderr.trim().split('\n').pop() || `claude exited ${String(code)}`))
          return
        }
        try {
          resolve(JSON.parse(stdout) as ResultEnvelope)
        } catch {
          reject(new Error('could not parse the CLI output'))
        }
      })
    })
  }

  /**
   * The agent wrote the comment straight to the note, so the in-memory task is
   * now stale. Re-read it before anything triggers a body rewrite, or the save
   * path would serialize the pre-run body back over the new comment.
   */
  private async absorbResult(task: Task, envelope: ResultEnvelope, startedAt: number): Promise<void> {
    await this.plugin.store.reloadTaskBody(task)
    this.finish(task.id, envelope.is_error ? (envelope.result ?? 'the run reported an error') : undefined)
    if (envelope.is_error) {
      new Notice(`Claude hit an error on "${task.title}".`)
      return
    }
    // Deliberately not reporting `total_cost_usd`. The CLI reports it whatever
    // the auth mode, but this runs on subscription OAuth, so it is an
    // API-equivalent figure and not a charge — printing it as dollars reads
    // like a bill. Elapsed time is the honest number here.
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    new Notice(`Claude commented on "${task.title}" (${elapsed}).`)
  }

  private finish(taskId: string, errorMessage?: string): void {
    if (errorMessage) {
      this.runs.set(taskId, { phase: 'error', startedAt: Date.now(), message: errorMessage })
      window.setTimeout(() => {
        if (this.runs.get(taskId)?.phase === 'error') {
          this.runs.delete(taskId)
          this.emit()
        }
      }, ERROR_LINGER_MS)
    } else {
      this.runs.delete(taskId)
    }
    this.emit()
  }

  private vaultPath(): string | null {
    const adapter = this.plugin.app.vault.adapter
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null
  }

  /** Kill anything still running. Called from the plugin's onunload. */
  shutdown(): void {
    for (const [taskId, proc] of this.processes) {
      proc.kill('SIGTERM')
      this.runs.delete(taskId)
    }
    this.processes.clear()
    this.listeners.clear()
  }
}
