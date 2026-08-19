import { TFile } from 'obsidian'
import type PMPlugin from '../main'
import type { Project, Task } from '../types'
import { makeTask } from '../types'
import { findTaskById } from '../store/TaskIndex'
import { openProjectPicker } from '../ui/ModalFactory'
import { extractActionItems, stripFrontmatter } from './actionItems'

/** Frontmatter written onto the source note so a card is never created twice. */
export const NOTE_TASK_KEY = 'pm_task_id'
export const NOTE_TASK_PROJECT_KEY = 'pm_task_project'
export const NOTE_EXPORTED_KEY = 'pm_exported_items'

/** The board's first column: the first status not marked complete. */
function firstOpenStatus(plugin: PMPlugin): string {
  const open = plugin.settings.statuses.find((s) => !s.complete)
  return open?.id ?? plugin.settings.statuses[0]?.id ?? 'todo'
}

function readFrontmatter(plugin: PMPlugin, file: TFile): Record<string, unknown> {
  return plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {}
}

/**
 * Resolve the board to add to, then run `run`.
 *
 * Prefers the project already pinned to the home page, so the common case is zero clicks.
 * Falls back to the only project, then to the picker. Callback style rather than a promise
 * because the picker has no cancel signal — an awaited version would leak a pending promise
 * every time the modal is dismissed.
 */
function withProject(plugin: PMPlugin, run: (project: Project) => Promise<void>): void {
  void (async () => {
    const projects = await plugin.store.loadAllProjects(plugin.settings.projectsFolder)
    if (projects.length === 0) {
      plugin.showNotice('No projects yet. Create a project first.')
      return
    }

    const pinned = projects.find((p) => p.filePath === plugin.settings.homeKanbanProject)
    if (pinned) {
      await run(pinned)
      return
    }
    if (projects.length === 1) {
      await run(projects[0])
      return
    }
    openProjectPicker(plugin, projects, (project) => void run(project))
  })()
}

/** A link to the note, honouring the vault's wikilink/markdown link preference. */
function linkTo(plugin: PMPlugin, file: TFile, project: Project): string {
  return plugin.app.fileManager.generateMarkdownLink(file, project.filePath, undefined, file.basename)
}

async function setNoteFields(plugin: PMPlugin, file: TFile, fields: Record<string, unknown>): Promise<void> {
  await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(fields)) {
      // undefined means "remove the key", which is how undo clears the link.
      if (value === undefined) Reflect.deleteProperty(fm, key)
      else fm[key] = value
    }
  })
}

function afterChange(plugin: PMPlugin): void {
  plugin.refreshProjectViews()
  plugin.refreshHomeViews()
}

// ─── Whole note → one card ────────────────────────────────────────────────────

/**
 * Add the note itself to a board as a single card.
 *
 * The note does not move. The card's description links back to it and the note records the
 * task id, so running this again reports the existing card rather than making a duplicate.
 */
export function addNoteToBoard(plugin: PMPlugin, file: TFile): void {
  withProject(plugin, async (project) => {
    const existingId = readFrontmatter(plugin, file)[NOTE_TASK_KEY]
    if (typeof existingId === 'string' && findTaskById(project, existingId)) {
      plugin.showNotice(`Already on ${project.title}.`)
      return
    }

    const task = makeTask({
      title: file.basename,
      description: `From ${linkTo(plugin, file, project)}`,
      status: firstOpenStatus(plugin)
    })

    await plugin.store.insertTask(project, task, null)
    await setNoteFields(plugin, file, { [NOTE_TASK_KEY]: task.id, [NOTE_TASK_PROJECT_KEY]: project.filePath })

    plugin.pushUndo({
      undo: async () => {
        await plugin.store.deleteTask(project, task.id)
        await setNoteFields(plugin, file, { [NOTE_TASK_KEY]: undefined, [NOTE_TASK_PROJECT_KEY]: undefined })
        afterChange(plugin)
      },
      redo: async () => {
        await plugin.store.insertTask(project, task, null)
        await setNoteFields(plugin, file, { [NOTE_TASK_KEY]: task.id, [NOTE_TASK_PROJECT_KEY]: project.filePath })
        afterChange(plugin)
      }
    })

    afterChange(plugin)
    plugin.showNotice(`Added “${task.title}” to ${project.title}.`)
  })
}

// ─── Action items → one card each ─────────────────────────────────────────────

/**
 * Turn every unchecked `- [ ]` line in the note into its own card.
 *
 * Exported item texts are recorded in the note's frontmatter, so running this after adding
 * a few more action items only creates the new ones. Editing an already-exported line's
 * text makes it look new and it will be exported again — predictable, and better than
 * silently dropping a genuinely new item.
 */
export function addActionItemsToBoard(plugin: PMPlugin, file: TFile): void {
  withProject(plugin, async (project) => {
    const body = stripFrontmatter(await plugin.app.vault.read(file))
    const items = extractActionItems(body)
    if (items.length === 0) {
      plugin.showNotice('No unchecked action items in this note.')
      return
    }

    const rawExported = readFrontmatter(plugin, file)[NOTE_EXPORTED_KEY]
    const exported = new Set(Array.isArray(rawExported) ? rawExported.map((v) => String(v)) : [])

    const fresh = items.filter((item) => !exported.has(item.text))
    if (fresh.length === 0) {
      plugin.showNotice(`All ${items.length} action items are already on ${project.title}.`)
      return
    }

    const link = linkTo(plugin, file, project)
    const status = firstOpenStatus(plugin)
    const created: Task[] = []
    for (const item of fresh) {
      const task = makeTask({ title: item.text, description: `From ${link}`, status })
      await plugin.store.insertTask(project, task, null)
      created.push(task)
    }

    const nextExported = [...exported, ...fresh.map((i) => i.text)]
    await setNoteFields(plugin, file, { [NOTE_EXPORTED_KEY]: nextExported })

    plugin.pushUndo({
      undo: async () => {
        await plugin.store.deleteTasks(
          project,
          created.map((t) => t.id)
        )
        // Back to empty means the note was never exported from; drop the key entirely
        // rather than leaving an empty list in the frontmatter.
        await setNoteFields(plugin, file, { [NOTE_EXPORTED_KEY]: exported.size > 0 ? [...exported] : undefined })
        afterChange(plugin)
      },
      redo: async () => {
        for (const task of created) await plugin.store.insertTask(project, task, null)
        await setNoteFields(plugin, file, { [NOTE_EXPORTED_KEY]: nextExported })
        afterChange(plugin)
      }
    })

    afterChange(plugin)
    const skipped = items.length - fresh.length
    const tail = skipped > 0 ? ` (${skipped} already there)` : ''
    plugin.showNotice(`Added ${fresh.length} action item${fresh.length === 1 ? '' : 's'} to ${project.title}${tail}.`)
  })
}
