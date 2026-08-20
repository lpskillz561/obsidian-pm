import { App, Platform, PluginSettingTab, Setting, Notice } from 'obsidian'
import type PMPlugin from './main'
import { PMSettings, DEFAULT_SETTINGS, makeId } from './types'
import { DEFAULT_CALENDAR_COLORS, makeSourceId } from './calendar/types'
import { localTimeZone } from './calendar/ics'
import { flattenTasks } from './store/TaskTreeOps'

/** A short, sensible fallback for runtimes without `Intl.supportedValuesOf`. */
const FALLBACK_TIME_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Australia/Sydney'
]

function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }
  try {
    return intl.supportedValuesOf?.('timeZone') ?? FALLBACK_TIME_ZONES
  } catch {
    return FALLBACK_TIME_ZONES
  }
}

export type { PMSettings }
export { DEFAULT_SETTINGS }

export class PMSettingTab extends PluginSettingTab {
  plugin: PMPlugin

  constructor(app: App, plugin: PMPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.addClass('pm-settings')

    // ── General ──────────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName('Projects folder')
      .setDesc('Vault folder where project files are stored.')
      .addText((text) =>
        text
          .setPlaceholder('Projects')
          .setValue(this.plugin.settings.projectsFolder)
          .onChange(async (v) => {
            this.plugin.settings.projectsFolder = v.trim() || 'Projects'
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Default view')
      .setDesc('Which view opens when you open a project.')
      .addDropdown((dd) =>
        dd
          .addOption('table', 'Table')
          .addOption('gantt', 'Gantt')
          .addOption('kanban', 'Board')
          .setValue(this.plugin.settings.defaultView)
          .onChange(async (v) => {
            this.plugin.settings.defaultView = v as PMSettings['defaultView']
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl).setName('Default gantt granularity').addDropdown((dd) =>
      dd
        .addOption('day', 'Day')
        .addOption('week', 'Week')
        .addOption('month', 'Month')
        .addOption('quarter', 'Quarter')
        .setValue(this.plugin.settings.ganttGranularity)
        .onChange(async (v) => {
          this.plugin.settings.ganttGranularity = v as PMSettings['ganttGranularity']
          await this.plugin.saveSettings()
        })
    )

    new Setting(containerEl)
      .setName('Gantt week label')
      .setDesc('What to display in weekly gantt header cells.')
      .addDropdown((dd) =>
        dd
          .addOption('weekNumber', 'Week number (w15)')
          .addOption('dateRange', 'Date range (apr 7\u201313)')
          .addOption('both', 'Both (w15: apr 7\u201313)')
          .setValue(this.plugin.settings.ganttWeekLabel)
          .onChange(async (v) => {
            this.plugin.settings.ganttWeekLabel = v as PMSettings['ganttWeekLabel']
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Show subtasks on board')
      .setDesc('Display subtasks as individual cards on the kanban board.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.kanbanShowSubtasks).onChange(async (v) => {
          this.plugin.settings.kanbanShowSubtasks = v
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Show description preview on board')
      .setDesc('Display the first few lines of each task description on kanban cards.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.kanbanShowDescriptionPreview).onChange(async (v) => {
          this.plugin.settings.kanbanShowDescriptionPreview = v
          await this.plugin.saveSettings()
          this.plugin.refreshProjectViews()
        })
      )

    new Setting(containerEl)
      .setName('Show tag colors')
      .setDesc('Show a colored dot on each tag, derived from its name. Turn off for plain tags.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showTagColors).onChange(async (v) => {
          this.plugin.settings.showTagColors = v
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Save tasks on close')
      .setDesc('Automatically save tasks when you close the task modal. When off, only clicking save persists changes.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.saveTaskOnClose).onChange(async (v) => {
          this.plugin.settings.saveTaskOnClose = v
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Copy button on inline code')
      .setDesc('Show a copy button beside anything written between backticks in your notes, such as API keys.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.inlineCodeCopyButton).onChange(async (v) => {
          this.plugin.settings.inlineCodeCopyButton = v
          await this.plugin.saveSettings()
          if (!v) this.plugin.inlineCodeCopy.removeAll()
          this.plugin.refreshMarkdownViews()
        })
      )

    // ── Home page ─────────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Home page').setHeading()

    new Setting(containerEl)
      .setName('Open home at startup')
      .setDesc('Open the home page automatically when Obsidian starts.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.openHomeOnStartup).onChange(async (v) => {
          this.plugin.settings.openHomeOnStartup = v
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Greeting name')
      .setDesc('Shown in the home page greeting. Leave empty to greet without a name.')
      .addText((text) =>
        text
          .setPlaceholder('Jarrett')
          .setValue(this.plugin.settings.homeGreetingName)
          .onChange(async (v) => {
            this.plugin.settings.homeGreetingName = v.trim()
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Agenda days')
      .setDesc('How many days of agenda to show, starting today.')
      .addSlider((sl) =>
        sl
          .setLimits(1, 7, 1)
          .setValue(this.plugin.settings.homeAgendaDays)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.homeAgendaDays = v
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Show tasks panel')
      .setDesc('Overdue, due today and in-progress tasks from your projects.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.homeShowTasks).onChange(async (v) => {
          this.plugin.settings.homeShowTasks = v
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Show notes panel')
      .setDesc('Pinned and recently edited notes.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.homeShowNotes).onChange(async (v) => {
          this.plugin.settings.homeShowNotes = v
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Show board')
      .setDesc('Embed a project board across the full width of the home page.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.homeShowKanban).onChange(async (v) => {
          this.plugin.settings.homeShowKanban = v
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Board project')
      .setDesc('Which project’s board appears on the home page.')
      .addDropdown((dd) => {
        dd.addOption('', 'None')
        dd.setValue(this.plugin.settings.homeKanbanProject)
        dd.onChange(async (v) => {
          this.plugin.settings.homeKanbanProject = v
          await this.plugin.saveSettings()
        })
        // Projects load from disk; fill the list in once it resolves and re-apply the
        // saved value, since setValue before the options exist would be dropped.
        void (async () => {
          const projects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
          for (const p of projects) dd.addOption(p.filePath, p.title)
          dd.setValue(this.plugin.settings.homeKanbanProject)
        })()
      })

    // ── Calendars ─────────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Calendars').setHeading()

    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text:
        'Subscribe to read-only iCal feeds. In Google Calendar use Settings → "Secret address in iCal format"; ' +
        'in Outlook use "Publish a calendar" and copy the ICS link.'
    })
    containerEl.createEl('p', {
      cls: 'pm-settings-desc pm-settings-desc--warn',
      text:
        'These URLs are credentials — anyone who has one can read the calendar. They are stored in this ' +
        "plugin's data.json inside the vault, so they travel with any vault sync or backup."
    })

    const calendarContainer = containerEl.createDiv('pm-settings-calendars')
    this.renderCalendarList(calendarContainer)

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText('+ add calendar')
        .setCta()
        .onClick(() => {
          const sources = this.plugin.settings.calendarSources
          sources.push({
            id: makeSourceId(),
            name: sources.length === 0 ? 'Work' : 'Personal',
            url: '',
            color: DEFAULT_CALENDAR_COLORS[sources.length % DEFAULT_CALENDAR_COLORS.length],
            enabled: true
          })
          void this.plugin.saveSettings()
          this.renderCalendarList(calendarContainer)
        })
    )

    new Setting(containerEl)
      .setName('Display timezone')
      .setDesc(
        'Timezone the agenda is shown in. Meetings keep the organiser’s timezone in the feed, ' +
          'so set this to see every meeting on your own clock.'
      )
      .addDropdown((dd) => {
        dd.addOption('', `System default (${localTimeZone()})`)
        for (const zone of supportedTimeZones()) dd.addOption(zone, zone.replace(/_/g, ' '))
        dd.setValue(this.plugin.settings.calendarTimeZone)
        dd.onChange(async (v) => {
          this.plugin.settings.calendarTimeZone = v
          await this.plugin.saveSettings()
        })
      })

    new Setting(containerEl)
      .setName('Refresh every (minutes)')
      .setDesc('How often to re-fetch the feeds. The secret calendar address can itself lag several hours.')
      .addSlider((sl) =>
        sl
          .setLimits(5, 240, 5)
          .setValue(this.plugin.settings.calendarRefreshMinutes)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.calendarRefreshMinutes = v
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Meetings folder')
      .setDesc('Where per-meeting notes are created.')
      .addText((text) =>
        text
          .setPlaceholder('Meetings')
          .setValue(this.plugin.settings.meetingsFolder)
          .onChange(async (v) => {
            this.plugin.settings.meetingsFolder = v.trim() || 'Meetings'
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Meeting note template')
      .setDesc('Vault path to a note whose body is used for new meeting notes. Leave empty for the built-in template.')
      .addText((text) =>
        text
          .setPlaceholder('Templates/Meeting.md')
          .setValue(this.plugin.settings.meetingTemplatePath)
          .onChange(async (v) => {
            this.plugin.settings.meetingTemplatePath = v.trim()
            await this.plugin.saveSettings()
          })
      )

    // ── Notifications ─────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Due date notifications').setHeading()

    new Setting(containerEl)
      .setName('Enable notifications')
      .setDesc('Show a banner when tasks are approaching their due date.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.notificationsEnabled).onChange(async (v) => {
          this.plugin.settings.notificationsEnabled = v
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Lead time (days)')
      .setDesc('How many days before the due date to show the notification.')
      .addSlider((sl) =>
        sl
          .setLimits(1, 14, 1)
          .setValue(this.plugin.settings.notificationLeadDays)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.notificationLeadDays = v
            await this.plugin.saveSettings()
          })
      )

    // ── Scheduling ───────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Scheduling').setHeading()

    new Setting(containerEl)
      .setName('Auto-schedule')
      .setDesc('Automatically adjust dependent task dates when a task changes.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSchedule).onChange(async (v) => {
          this.plugin.settings.autoSchedule = v
          await this.plugin.saveSettings()
        })
      )

    // ── Team Members ──────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Team members').setHeading()

    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text: 'Global list of people available as assignees across all projects.'
    })
    // margin handled by .pm-settings-desc CSS class

    const membersContainer = containerEl.createDiv('pm-settings-members')
    this.renderMembersList(membersContainer)

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText('+ add member')
        .setCta()
        .onClick(() => {
          this.plugin.settings.globalTeamMembers.push('')
          void this.plugin.saveSettings()
          this.renderMembersList(membersContainer)
        })
    )

    // ── Statuses ──────────────────────────────────────────────────────────────
    new Setting(containerEl).setName('Statuses').setHeading()
    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text: 'Customize status labels, colors, and icons. Drag to reorder.'
    })

    const statusContainer = containerEl.createDiv('pm-settings-statuses')
    this.renderStatusList(statusContainer)

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText('+ add status')
        .setCta()
        .onClick(() => {
          const id = 'status-' + makeId().slice(0, 6)
          this.plugin.settings.statuses.push({
            id,
            label: 'New status',
            color: '#8a94a0',
            icon: '',
            complete: false
          })
          void this.plugin.saveSettings()
          this.renderStatusList(statusContainer)
        })
    )

    this.renderClaudeSection(containerEl)
  }

  // ── Agent ────────────────────────────────────────────────────────────────
  private renderClaudeSection(containerEl: HTMLElement): void {
    const claude = this.plugin.settings.claude

    new Setting(containerEl).setName('Claude agent').setHeading()
    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text:
        'Hand a task to a local Claude Code agent: it reads the card, investigates the mapped ' +
        'repo read-only, and posts its findings back as a comment. Desktop only.'
    })

    if (!Platform.isDesktopApp) {
      containerEl.createEl('p', {
        cls: 'pm-settings-desc',
        text: 'Unavailable on mobile — running a local agent needs a desktop app.'
      })
      return
    }

    new Setting(containerEl)
      .setName('Enable')
      .setDesc('Adds the hand-off action to the task menu.')
      .addToggle((t) =>
        t.setValue(claude.enabled).onChange(async (v) => {
          claude.enabled = v
          await this.plugin.saveSettings()
          this.display()
        })
      )

    if (!claude.enabled) return

    new Setting(containerEl)
      .setName('Claude binary')
      .setDesc(
        'Absolute path — a bare command name will not resolve, because Obsidian runs with a minimal PATH. ' +
          'Find yours with `which claude` in a terminal.'
      )
      .addText((text) =>
        text
          .setPlaceholder('Absolute path to the binary')
          .setValue(claude.binaryPath)
          .onChange(async (v) => {
            claude.binaryPath = v.trim()
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Config directory')
      .setDesc(
        'CLAUDE_CONFIG_DIR for the spawned agent — this picks which persona runs, and which skills it has. ' +
          'The obsidian-pm-task skill must live under <dir>/skills/.'
      )
      .addText((text) =>
        text
          .setPlaceholder('Absolute path to the config directory')
          .setValue(claude.configDir)
          .onChange(async (v) => {
            claude.configDir = v.trim().replace(/\/$/, '')
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Assignee name')
      .setDesc('Assigning this name to a task stands for "give it to the agent".')
      .addText((text) =>
        text
          .setPlaceholder('Agent name')
          .setValue(claude.assignee)
          .onChange(async (v) => {
            claude.assignee = v.trim() || 'claude-zixi'
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Run on assignment')
      .setDesc('Start a run as soon as the agent is added as an assignee. Off = only from the task menu.')
      .addToggle((t) =>
        t.setValue(claude.autoRunOnAssign).onChange(async (v) => {
          claude.autoRunOnAssign = v
          await this.plugin.saveSettings()
        })
      )

    new Setting(containerEl)
      .setName('Tool access')
      .setDesc(
        'Full gives the agent everything its config directory provides — all tools, skills and MCP servers — ' +
          'the same as running that persona yourself in a terminal, and it can edit files and run commands. ' +
          'Read-only restricts it to reads, searches and read-only git, which also cuts off MCP servers.'
      )
      .addDropdown((dd) =>
        dd
          .addOption('full', 'Full — same as your terminal')
          .addOption('readonly', 'Read-only')
          .setValue(claude.toolAccess)
          .onChange(async (v) => {
            claude.toolAccess = v as typeof claude.toolAccess
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Model')
      .setDesc(
        'Config default follows the config directory, which is the safest choice — it already carries the ' +
          'context window you picked there. Plain opus is the 200k build, not the 1m one.'
      )
      .addDropdown((dd) =>
        dd
          .addOption('', 'Config default')
          .addOption('haiku', 'Haiku')
          .addOption('sonnet', 'Sonnet')
          .addOption('opus', 'Opus (200k)')
          .addOption('opus[1m]', 'Opus (1m context)')
          .setValue(claude.model)
          .onChange(async (v) => {
            claude.model = v
            await this.plugin.saveSettings()
          })
      )

    new Setting(containerEl)
      .setName('Timeout')
      .setDesc('Minutes before a run is killed. A real investigation often takes 3-5.')
      .addText((text) =>
        text.setValue(String(claude.timeoutMinutes)).onChange(async (v) => {
          const n = parseInt(v, 10)
          if (!isNaN(n) && n > 0) {
            claude.timeoutMinutes = n
            await this.plugin.saveSettings()
          }
        })
      )

    new Setting(containerEl).setName('Project repositories').setHeading()
    containerEl.createEl('p', {
      cls: 'pm-settings-desc',
      text: 'The agent runs with its working directory set to the repo mapped here. Projects with no repo cannot be handed off.'
    })
    const repoContainer = containerEl.createDiv('pm-settings-repos')
    void this.renderRepoList(repoContainer)
  }

  private async renderRepoList(container: HTMLElement): Promise<void> {
    container.empty()
    const projects = await this.plugin.store.loadAllProjects(this.plugin.settings.projectsFolder)
    if (!projects.length) {
      container.createEl('p', { cls: 'pm-settings-desc', text: 'No projects yet.' })
      return
    }
    const repoPaths = this.plugin.settings.claude.repoPaths
    for (const project of projects) {
      new Setting(container)
        .setName(project.title)
        .setDesc(project.filePath)
        .addText((text) =>
          text
            .setPlaceholder('/absolute/path/to/repo')
            .setValue(repoPaths[project.filePath] ?? '')
            .onChange(async (v) => {
              const trimmed = v.trim().replace(/\/$/, '')
              if (trimmed) repoPaths[project.filePath] = trimmed
              else Reflect.deleteProperty(repoPaths, project.filePath)
              await this.plugin.saveSettings()
            })
        )
    }
  }

  private renderMembersList(container: HTMLElement): void {
    container.empty()
    const members = this.plugin.settings.globalTeamMembers
    members.forEach((m, i) => {
      const row = container.createDiv('pm-settings-member-row')
      const input = row.createEl('input', { type: 'text', value: m })
      input.placeholder = 'Name'
      input.addEventListener('change', () => {
        this.plugin.settings.globalTeamMembers[i] = input.value
        void this.plugin.saveSettings()
      })
      const del = row.createEl('button', { text: '✕' })
      del.addClass('pm-settings-del')
      del.addEventListener('click', () => {
        this.plugin.settings.globalTeamMembers.splice(i, 1)
        void this.plugin.saveSettings()
        this.renderMembersList(container)
      })
    })
  }

  private renderCalendarList(container: HTMLElement): void {
    container.empty()
    const sources = this.plugin.settings.calendarSources

    if (sources.length === 0) {
      container.createEl('p', { cls: 'pm-settings-desc', text: 'No calendars subscribed yet.' })
      return
    }

    sources.forEach((source, i) => {
      const row = container.createDiv('pm-settings-calendar-row')

      const enabled = row.createEl('input', { type: 'checkbox', cls: 'pm-settings-calendar-enabled' })
      enabled.checked = source.enabled
      enabled.ariaLabel = 'Enabled'
      enabled.addEventListener('change', () => {
        sources[i].enabled = enabled.checked
        void this.plugin.saveSettings()
      })

      const color = row.createEl('input', { type: 'color', value: source.color })
      color.ariaLabel = 'Calendar color'
      color.addEventListener('change', () => {
        sources[i].color = color.value
        void this.plugin.saveSettings()
      })

      const name = row.createEl('input', { type: 'text', value: source.name, cls: 'pm-settings-calendar-name' })
      name.placeholder = 'Work'
      name.addEventListener('change', () => {
        sources[i].name = name.value
        void this.plugin.saveSettings()
      })

      // Masked: the secret iCal URL is a credential and should not sit on screen in plain text.
      const url = row.createEl('input', { type: 'password', value: source.url, cls: 'pm-settings-calendar-url' })
      url.placeholder = 'https://calendar.google.com/…/basic.ics'
      url.addEventListener('change', () => {
        sources[i].url = url.value.trim()
        void this.plugin.saveSettings()
      })

      const reveal = row.createEl('button', { text: '👁', cls: 'pm-settings-calendar-reveal' })
      reveal.ariaLabel = 'Show or hide the URL'
      reveal.addEventListener('click', () => {
        url.type = url.type === 'password' ? 'text' : 'password'
      })

      const del = row.createEl('button', { text: '✕', cls: 'pm-settings-del' })
      del.addEventListener('click', () => {
        sources.splice(i, 1)
        void this.plugin.saveSettings()
        this.renderCalendarList(container)
      })
    })
  }

  private async remapOrphanTasks(deletedId: string, deletedLabel: string): Promise<void> {
    const statuses = this.plugin.settings.statuses
    if (statuses.length === 0) return
    const defaultStatus = statuses[0]
    const folder = this.plugin.settings.projectsFolder
    const projects = await this.plugin.store.loadAllProjects(folder)
    let remapped = 0
    for (const project of projects) {
      const ids = flattenTasks(project.tasks)
        .filter(({ task }) => task.status === deletedId)
        .map(({ task }) => task.id)
      if (ids.length) {
        await this.plugin.store.updateTasks(project, ids, { status: defaultStatus.id })
        remapped += ids.length
      }
    }
    if (remapped > 0) {
      new Notice(
        `Remapped ${remapped} task${remapped === 1 ? '' : 's'} from '${deletedLabel}' to '${defaultStatus.label}'.`
      )
    }
  }

  private renderStatusList(container: HTMLElement): void {
    container.empty()
    this.plugin.settings.statuses.forEach((s, i) => {
      const row = container.createDiv('pm-settings-status-row')

      // Drag handle
      row.createSpan({ text: '⠿', cls: 'pm-settings-drag-handle' })
      row.draggable = true
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData('text/plain', String(i))
        row.addClass('pm-settings-row--dragging')
      })
      row.addEventListener('dragend', () => {
        row.removeClass('pm-settings-row--dragging')
      })
      row.addEventListener('dragover', (e) => {
        e.preventDefault()
      })
      row.addEventListener('drop', (e) => {
        e.preventDefault()
        const fromIdx = parseInt(e.dataTransfer?.getData('text/plain') ?? '', 10)
        if (isNaN(fromIdx) || fromIdx === i) return
        const statuses = this.plugin.settings.statuses
        const [moved] = statuses.splice(fromIdx, 1)
        statuses.splice(i, 0, moved)
        void this.plugin.saveSettings()
        this.renderStatusList(container)
      })

      // Icon input
      const icon = row.createEl('input', { type: 'text', value: s.icon })
      icon.addClass('pm-settings-status-icon')
      icon.placeholder = ''
      icon.addEventListener('change', () => {
        this.plugin.settings.statuses[i].icon = icon.value
        void this.plugin.saveSettings()
      })

      // Label input
      const label = row.createEl('input', { type: 'text', value: s.label })
      label.addClass('pm-settings-status-label')
      label.addEventListener('change', () => {
        this.plugin.settings.statuses[i].label = label.value
        void this.plugin.saveSettings()
      })

      // Color picker
      const color = row.createEl('input', { type: 'color', value: s.color })
      color.addEventListener('change', () => {
        this.plugin.settings.statuses[i].color = color.value
        void this.plugin.saveSettings()
      })

      // Complete toggle
      const completeLabel = row.createEl('label', { cls: 'pm-settings-complete-toggle' })
      const checkbox = completeLabel.createEl('input', { type: 'checkbox' })
      checkbox.checked = s.complete
      completeLabel.createSpan({ text: 'Done', cls: 'pm-settings-complete-text' })
      checkbox.addEventListener('change', () => {
        this.plugin.settings.statuses[i].complete = checkbox.checked
        void this.plugin.saveSettings()
      })

      // Delete button
      const del = row.createEl('button', { text: '✕', cls: 'pm-settings-del' })
      del.addEventListener('click', () => {
        if (this.plugin.settings.statuses.length <= 1) {
          new Notice('You must have at least one status.')
          return
        }
        const deletedStatus = this.plugin.settings.statuses[i]
        this.plugin.settings.statuses.splice(i, 1)
        void this.plugin.saveSettings()
        this.renderStatusList(container)
        void this.remapOrphanTasks(deletedStatus.id, deletedStatus.label)
      })
    })
  }
}
