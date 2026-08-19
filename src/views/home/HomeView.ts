import { ItemView, WorkspaceLeaf } from 'obsidian'
import type PMPlugin from '../../main'
import type { Project } from '../../types'
import { Temporal } from '../../dates'
import { renderGreeting } from './GreetingHeader'
import { renderAgenda } from './AgendaPanel'
import { groupHomeTasks, renderTaskPanel } from './TaskPanel'
import { renderNotesPanel } from './NotesPanel'
import { renderKanbanPanel } from './KanbanPanel'

export const PM_HOME_VIEW_TYPE = 'pm-home'

/** How often the "now" marker and relative times are refreshed. */
const TICK_MS = 60_000

export class HomeView extends ItemView {
  private plugin: PMPlugin
  private scrollEl!: HTMLElement
  private anchor: Temporal.PlainDate | null = null
  private refreshing = false
  private renderToken = 0
  private reloadDebounceTimer: number | null = null

  constructor(leaf: WorkspaceLeaf, plugin: PMPlugin) {
    super(leaf)
    this.plugin = plugin
    this.navigation = false
  }

  getViewType(): string {
    return PM_HOME_VIEW_TYPE
  }
  getDisplayText(): string {
    return 'Home'
  }
  getIcon(): string {
    return 'home'
  }

  async onOpen(): Promise<void> {
    this.containerEl.addClass('pm-view')
    const root = this.contentEl
    root.empty()
    root.addClass('pm-root', 'pm-home-root')
    this.scrollEl = root.createDiv('pm-home-scroll')

    await this.plugin.calendars.loadCache()
    this.render()
    this.registerVaultListeners()
    this.registerInterval(window.setInterval(() => this.tick(), TICK_MS))

    // Cached data is on screen already; a stale-check refresh fills in behind it.
    void this.refreshCalendars(false)
  }

  onClose(): Promise<void> {
    if (this.reloadDebounceTimer !== null) {
      window.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = null
    }
    return Promise.resolve()
  }

  private tick(): void {
    if (this.plugin.calendars.isStale()) {
      void this.refreshCalendars(false)
      return
    }
    this.render()
  }

  private async refreshCalendars(force: boolean): Promise<void> {
    if (!this.plugin.calendars.hasSources) return
    this.refreshing = true
    this.render()
    try {
      await this.plugin.calendars.refresh(force)
    } finally {
      this.refreshing = false
      this.render()
    }
  }

  private registerVaultListeners(): void {
    const scheduleReload = () => {
      if (this.reloadDebounceTimer !== null) window.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = window.setTimeout(() => {
        this.reloadDebounceTimer = null
        this.render()
      }, 400)
    }
    this.registerEvent(this.app.vault.on('create', scheduleReload))
    this.registerEvent(this.app.vault.on('modify', scheduleReload))
    this.registerEvent(this.app.vault.on('delete', scheduleReload))
    this.registerEvent(this.app.vault.on('rename', scheduleReload))
  }

  render(): void {
    const token = ++this.renderToken
    void this.renderAsync(token)
  }

  private async renderAsync(token: number): Promise<void> {
    const settings = this.plugin.settings
    const needsProjects = settings.homeShowTasks || settings.homeShowKanban
    const projects: Project[] = needsProjects ? await this.plugin.store.loadAllProjects(settings.projectsFolder) : []
    if (token !== this.renderToken) return

    // Re-renders happen on a timer and on vault writes; keeping the scroll position
    // stops the page jumping under the user mid-read.
    const scrollTop = this.scrollEl.scrollTop
    this.scrollEl.empty()

    const now = this.plugin.calendars.now()
    // Anchor lazily: at construction time the settings (and so the zone) may not be read yet.
    this.anchor ??= now.toPlainDate()
    const anchor = this.anchor
    const days = Math.max(settings.homeAgendaDays, 1)
    const from = anchor.toZonedDateTime(now.timeZoneId)
    const to = anchor.add({ days }).toZonedDateTime(now.timeZoneId)
    const events = this.plugin.calendars.eventsForRange(from, to)

    const column = this.scrollEl.createDiv('pm-home-column')

    const groups = groupHomeTasks(this.plugin, projects)
    renderGreeting(column, {
      name: settings.homeGreetingName,
      now,
      stats: {
        meetings: events.filter(
          (e) => !e.allDay && Temporal.PlainDate.compare(e.start.toPlainDate(), now.toPlainDate()) === 0
        ).length,
        overdue: groups.find((g) => g.id === 'overdue')?.tasks.length ?? 0,
        dueToday: groups.find((g) => g.id === 'today')?.tasks.length ?? 0
      }
    })

    const grid = column.createDiv('pm-home-grid')

    renderAgenda(grid.createDiv('pm-home-main'), {
      plugin: this.plugin,
      anchor,
      now,
      events,
      refreshing: this.refreshing,
      onShiftDay: (delta) => {
        this.anchor = anchor.add({ days: delta })
        this.render()
      },
      onToday: () => {
        this.anchor = this.plugin.calendars.now().toPlainDate()
        this.render()
      },
      onRefresh: () => void this.refreshCalendars(true)
    })

    const side = grid.createDiv('pm-home-side')
    if (settings.homeShowTasks) renderTaskPanel(side, this.plugin, projects, () => this.render())
    if (settings.homeShowNotes) renderNotesPanel(side, this.plugin, () => this.render())

    // Outside the centred column on purpose: the board gets the whole view width so every
    // status column is visible at once, rather than being clipped by the reading measure.
    if (settings.homeShowKanban) {
      renderKanbanPanel(this.scrollEl.createDiv('pm-home-wide'), this.plugin, projects, () => this.render())
    }

    this.scrollEl.scrollTop = scrollTop
  }
}
