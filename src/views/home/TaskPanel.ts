import { setIcon, setTooltip } from 'obsidian'
import type PMPlugin from '../../main'
import type { Project, Task } from '../../types'
import { flattenTasks } from '../../store/TaskTreeOps'
import { getPriorityConfig, getStatusConfig, isTaskOverdue, isTerminalStatus, safeAsync } from '../../utils'
import { formatDate, relativeDue, today } from '../../dates'
import { openTaskModal } from '../../ui/ModalFactory'

export interface HomeTask {
  task: Task
  project: Project
}

export interface TaskGroup {
  id: string
  label: string
  icon: string
  tone: 'danger' | 'accent' | 'muted'
  tasks: HomeTask[]
}

/** How many tasks each group shows before collapsing into a "+N more" line. */
const GROUP_LIMIT = 6

/**
 * Split every task across all projects into the three buckets the home page shows.
 * A task appears in at most one bucket: overdue wins over due-today, which wins over
 * in-progress, so the counts add up to the number of distinct tasks needing attention.
 */
export function groupHomeTasks(plugin: PMPlugin, projects: Project[]): TaskGroup[] {
  const statuses = plugin.settings.statuses
  const todayIso = today().toString()
  const defaultStatusId = statuses[0]?.id ?? ''

  const overdue: HomeTask[] = []
  const dueToday: HomeTask[] = []
  const inProgress: HomeTask[] = []

  for (const project of projects) {
    for (const { task } of flattenTasks(project.tasks)) {
      if (task.archived || isTerminalStatus(task.status, statuses)) continue
      const entry = { task, project }
      if (isTaskOverdue(task, statuses)) overdue.push(entry)
      else if (task.due === todayIso) dueToday.push(entry)
      else if (task.progress > 0 || (task.status !== defaultStatusId && task.status !== '')) inProgress.push(entry)
    }
  }

  const byDue = (a: HomeTask, b: HomeTask) => (a.task.due || '9999').localeCompare(b.task.due || '9999')
  overdue.sort(byDue)
  dueToday.sort(byDue)
  inProgress.sort(byDue)

  return [
    { id: 'overdue', label: 'Overdue', icon: 'alert-circle', tone: 'danger', tasks: overdue },
    { id: 'today', label: 'Due today', icon: 'calendar-check', tone: 'accent', tasks: dueToday },
    { id: 'progress', label: 'In progress', icon: 'circle-dashed', tone: 'muted', tasks: inProgress }
  ]
}

export function renderTaskPanel(
  parentEl: HTMLElement,
  plugin: PMPlugin,
  projects: Project[],
  onChange: () => void
): void {
  const groups = groupHomeTasks(plugin, projects).filter((g) => g.tasks.length > 0)

  const panel = parentEl.createDiv('pm-home-panel pm-home-tasks')
  const head = panel.createDiv('pm-home-panel-head')
  head.createEl('h2', { cls: 'pm-home-panel-title', text: 'Tasks' })

  const total = groups.reduce((n, g) => n + g.tasks.length, 0)
  if (total === 0) {
    panel.createDiv({ cls: 'pm-home-panel-quiet', text: 'Nothing needs attention. Everything is on track.' })
    return
  }
  head.createDiv({ cls: 'pm-home-panel-count', text: String(total) })

  for (const group of groups) {
    const section = panel.createDiv('pm-home-taskgroup')
    section.addClass(`pm-home-taskgroup--${group.tone}`)

    const label = section.createDiv('pm-home-taskgroup-head')
    setIcon(label.createSpan('pm-home-taskgroup-icon'), group.icon)
    label.createSpan({ cls: 'pm-home-taskgroup-label', text: group.label })
    label.createSpan({ cls: 'pm-home-taskgroup-count', text: String(group.tasks.length) })

    for (const entry of group.tasks.slice(0, GROUP_LIMIT)) {
      renderTaskRow(section, plugin, entry, onChange)
    }
    const hidden = group.tasks.length - GROUP_LIMIT
    if (hidden > 0) {
      section.createDiv({ cls: 'pm-home-taskgroup-more', text: `+${hidden} more` })
    }
  }
}

function renderTaskRow(parentEl: HTMLElement, plugin: PMPlugin, entry: HomeTask, onChange: () => void): void {
  const { task, project } = entry
  const row = parentEl.createDiv('pm-home-task')

  const priority = getPriorityConfig(plugin.settings.priorities, task.priority)
  const status = getStatusConfig(plugin.settings.statuses, task.status)
  row.setCssProps({ '--pm-task-color': priority?.color ?? status?.color ?? 'var(--pm-text-faint)' })

  row.createSpan({ cls: 'pm-home-task-dot' })
  row.createSpan({ cls: 'pm-home-task-title', text: task.title })

  const meta = row.createDiv('pm-home-task-meta')
  meta.createSpan({ cls: 'pm-home-task-project', text: project.title })
  const due = relativeDue(task.due)
  if (due) {
    const chip = meta.createSpan({ cls: 'pm-home-task-due', text: due.text })
    chip.addClass(`pm-home-task-due--${due.tone}`)
    setTooltip(chip, formatDate(task.due))
  } else if (task.due) {
    meta.createSpan({ cls: 'pm-home-task-due', text: formatDate(task.due) })
  }

  row.addEventListener(
    'click',
    safeAsync(async () => {
      await plugin.store.loadProjectBody(project)
      openTaskModal(plugin, project, { task, onSave: onChange })
    })
  )
}
