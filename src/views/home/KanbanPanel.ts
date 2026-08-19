import { setIcon, setTooltip } from 'obsidian'
import type PMPlugin from '../../main'
import type { Project } from '../../types'
import { makeDefaultFilter } from '../../types'
import { flattenTasks } from '../../store/TaskTreeOps'
import { isTerminalStatus, safeAsync } from '../../utils'
import { EmptyState } from '../../ui/primitives/EmptyState'
import { KanbanView } from '../KanbanView'

/**
 * Embeds a project's board on the home page.
 *
 * This drives the real `KanbanView` rather than re-implementing cards, so drag-to-change-
 * status, the task context menu and description previews all behave exactly as they do in
 * the full project view. The board is rendered unfiltered — the home page is a glance, and
 * a hidden filter here would quietly misrepresent the column counts.
 */
export function renderKanbanPanel(
  parentEl: HTMLElement,
  plugin: PMPlugin,
  projects: Project[],
  onChange: () => void
): void {
  const path = plugin.settings.homeKanbanProject
  const panel = parentEl.createDiv('pm-home-panel pm-home-kanban')

  const head = panel.createDiv('pm-home-panel-head')
  const project = projects.find((p) => p.filePath === path)
  head.createEl('h2', { cls: 'pm-home-panel-title', text: project ? project.title : 'Board' })

  if (!path) {
    new EmptyState(panel.createDiv('pm-home-kanban-empty'))
      .setIcon('🗂')
      .setTitle('No board selected')
      .setBody('Pick a project under Settings → Project manager → Home page → Board project.')
    return
  }

  if (!project) {
    new EmptyState(panel.createDiv('pm-home-kanban-empty'))
      .setIcon('🗂')
      .setTitle('Board project not found')
      .setBody(`No project at "${path}". It may have been renamed or moved.`)
    return
  }

  const remaining = flattenTasks(project.tasks).filter(
    ({ task }) => !task.archived && !isTerminalStatus(task.status, plugin.settings.statuses)
  ).length
  if (remaining > 0) head.createDiv({ cls: 'pm-home-panel-count', text: String(remaining) })

  const controls = head.createDiv('pm-home-panel-controls')
  const openBtn = controls.createEl('button', { cls: 'pm-home-nav-btn' })
  setIcon(openBtn, 'external-link')
  setTooltip(openBtn, 'Open the full board')
  openBtn.addEventListener(
    'click',
    safeAsync(async () => {
      await plugin.router.openProjectByPath(project.filePath)
    })
  )

  const board = panel.createDiv('pm-home-kanban-board')
  new KanbanView(
    board,
    project,
    plugin,
    () => {
      onChange()
      return Promise.resolve()
    },
    makeDefaultFilter()
  ).render()
}
