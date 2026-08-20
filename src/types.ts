import type { CalendarSource } from './calendar/types'
import { today } from './dates'
import type { TaskIndex } from './store/TaskIndex'

export type TaskStatus = string
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low'
export type GanttGranularity = 'day' | 'week' | 'month' | 'quarter'
export type GanttWeekLabel = 'weekNumber' | 'dateRange' | 'both'
export type ViewMode = 'table' | 'gantt' | 'kanban'
export type DueDateFilter = 'any' | 'overdue' | 'this-week' | 'this-month' | 'no-date'
export type TaskType = 'task' | 'bug' | 'milestone' | 'subtask'

export interface Recurrence {
  interval: 'daily' | 'weekly' | 'monthly' | 'yearly'
  every: number // e.g. every 2 weeks
  endDate?: string // YYYY-MM-DD
}

export interface TimeLog {
  date: string // YYYY-MM-DD
  hours: number
  note: string
}

/**
 * A comment on a task. Lives in a managed `## Comments` section at the end of
 * the task note's body — markdown, because these are read in Obsidian as often
 * as they are read by the plugin, and a wall of escaped YAML is neither.
 */
export interface TaskComment {
  author: string
  at: string // ISO 8601 with offset
  body: string // markdown
  /** Set when an agent wrote the comment; ties it back to a ClaudeRunner run. */
  runId?: string
}

export interface CustomFieldDef {
  id: string
  name: string
  type: 'text' | 'number' | 'date' | 'select' | 'multiselect' | 'person' | 'checkbox' | 'url'
  options?: string[] // for select / multiselect
  icon?: string // emoji or lucide icon name
}

export interface Task {
  id: string
  title: string
  description: string
  type: TaskType // 'task' or 'milestone' (zero-duration)
  status: TaskStatus
  priority: TaskPriority
  start: string // YYYY-MM-DD, empty string = unset
  due: string // YYYY-MM-DD, empty string = unset
  progress: number // 0–100
  completed: string // YYYY-MM-DD, empty string = not completed; stamped when status becomes complete
  assignees: string[]
  tags: string[]
  subtasks: Task[]
  dependencies: string[] // task IDs
  recurrence?: Recurrence
  timeEstimate?: number // hours
  timeLogs?: TimeLog[]
  /** Parsed from the note body's managed `## Comments` section. */
  comments?: TaskComment[]
  customFields: Record<string, unknown>
  /** UI state, persisted per project in plugin settings (data.json), not in frontmatter. */
  collapsed: boolean
  createdAt: string
  updatedAt: string
  filePath?: string // vault path to this task's .md file
  archived?: boolean // runtime only — derived from file location in Archive/ subfolder
}

export interface Project {
  id: string
  title: string
  description: string
  color: string // hex
  icon: string // emoji
  tasks: Task[]
  customFields: CustomFieldDef[]
  teamMembers: string[]
  createdAt: string
  updatedAt: string
  filePath: string // resolved vault path
  savedViews: SavedView[]
  /** Transient id → {task, parentId} index. Rebuilt on load, maintained by store mutators. Not serialized. */
  taskIndex: TaskIndex
}

export interface FilterState {
  text: string
  statuses: TaskStatus[]
  priorities: TaskPriority[]
  assignees: string[]
  tags: string[]
  dueDateFilter: DueDateFilter
  showArchived: boolean
}

export interface SavedView {
  id: string
  name: string
  filter: FilterState
  sortKey: string
  sortDir: 'asc' | 'desc'
  viewMode?: ViewMode
}

export interface PerProjectFilter {
  filter: FilterState
  activeSavedViewId: string | null
}

export interface StatusConfig {
  id: string
  label: string
  color: string
  icon: string
  complete: boolean
}

export interface PriorityConfig {
  id: TaskPriority
  label: string
  color: string
  icon: string
}

/**
 * Handing board tasks to a local Claude Code agent.
 *
 * `claude-zixi` on this machine is a shell function, not a binary
 * (`CLAUDE_CONFIG_DIR=$HOME/.claude-zixi command claude`), and Obsidian's
 * Electron process has a bare PATH that would not find it either way — so we
 * spawn the real binary by absolute path and set the config dir ourselves.
 */
export interface ClaudeSettings {
  enabled: boolean
  /** Absolute path to the `claude` binary. A bare command name will not resolve. */
  binaryPath: string
  /** CLAUDE_CONFIG_DIR for the spawned process — picks the persona and its skills. */
  configDir: string
  /** Assignee name that stands for the agent. Assigning it can trigger a run. */
  assignee: string
  /** Model alias, e.g. 'sonnet'. Empty = whatever the config dir's settings say. */
  model: string
  /**
   * 'full' — the agent gets everything the config directory gives it: all tools,
   * skills and MCP servers, same as running it yourself in a terminal. Needs
   * bypassPermissions, because headless runs auto-deny anything that would
   * otherwise prompt, and nobody is there to answer.
   * 'readonly' — a fixed allowlist: reads, searches, read-only git, and the
   * comment script. Cannot reach MCP servers.
   */
  toolAccess: 'full' | 'readonly'
  timeoutMinutes: number
  /** Run automatically when the agent is added as an assignee, not just on demand. */
  autoRunOnAssign: boolean
  /** Project file path → absolute path of the code repo it maps to. */
  repoPaths: Record<string, string>
}

export interface PMSettings {
  projectsFolder: string
  defaultView: ViewMode
  ganttGranularity: GanttGranularity
  ganttWeekLabel: GanttWeekLabel
  statuses: StatusConfig[]
  priorities: PriorityConfig[]
  globalTeamMembers: string[]
  notificationsEnabled: boolean
  notificationLeadDays: number
  autoSchedule: boolean
  kanbanShowSubtasks: boolean
  kanbanShowDescriptionPreview: boolean
  showTagColors: boolean
  saveTaskOnClose: boolean
  /** Show a copy button beside inline code (`like this`) in notes. */
  inlineCodeCopyButton: boolean
  projectFilters: Record<string, PerProjectFilter>
  /** Collapsed task ids per project file path. UI state — lives here so toggles don't rewrite task files. */
  collapsedTasks: Record<string, string[]>

  // ── Home page ──────────────────────────────────────────────────────────────
  /**
   * Subscribed iCal feeds. NOTE: these URLs are credentials — anyone holding one can read
   * the calendar — and they live in data.json inside the vault, so they travel with any
   * vault sync or backup. They are masked in settings and never written to the console.
   */
  calendarSources: CalendarSource[]
  /** Vault folder for per-meeting notes. */
  meetingsFolder: string
  /** Optional template note used as the body of a new meeting note. Empty = built-in template. */
  meetingTemplatePath: string
  openHomeOnStartup: boolean
  /** Name used in the home page greeting. Empty = greet without a name. */
  homeGreetingName: string
  /**
   * IANA zone the agenda is rendered in. Empty = follow the machine. An explicit zone
   * matters because a VEVENT keeps its organiser's TZID, so meetings booked from other
   * regions would otherwise show that region's wall clock.
   */
  calendarTimeZone: string
  calendarRefreshMinutes: number
  /** How many days of agenda the home page shows, starting today. */
  homeAgendaDays: number
  /** Vault paths pinned to the home page. Ours, not Obsidian's bookmarks. */
  pinnedNotes: string[]
  homeShowTasks: boolean
  homeShowNotes: boolean
  homeShowKanban: boolean
  /** Vault path of the project whose board is embedded on the home page. */
  homeKanbanProject: string

  // ── Agent ──────────────────────────────────────────────────────────────────
  claude: ClaudeSettings
}

export const DEFAULT_CLAUDE_SETTINGS: ClaudeSettings = {
  enabled: false,
  binaryPath: '',
  configDir: '',
  assignee: 'claude-zixi',
  model: '',
  toolAccess: 'full',
  timeoutMinutes: 15,
  autoRunOnAssign: true,
  repoPaths: {}
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_STATUSES: StatusConfig[] = [
  { id: 'todo', label: 'To Do', color: '#8a94a0', icon: '', complete: false },
  { id: 'in-progress', label: 'In Progress', color: '#8b72be', icon: '', complete: false },
  { id: 'blocked', label: 'Blocked', color: '#c47070', icon: '', complete: false },
  { id: 'review', label: 'In Review', color: '#b8a06b', icon: '', complete: false },
  { id: 'done', label: 'Done', color: '#79b58d', icon: '', complete: true },
  { id: 'cancelled', label: 'Cancelled', color: '#767491', icon: '', complete: true }
]

export const DEFAULT_PRIORITIES: PriorityConfig[] = [
  { id: 'critical', label: 'Critical', color: '#c47070', icon: '' },
  { id: 'high', label: 'High', color: '#b8a06b', icon: '' },
  { id: 'medium', label: 'Medium', color: '#8a94a0', icon: '' },
  { id: 'low', label: 'Low', color: '#79b58d', icon: '' }
]

export const DEFAULT_SETTINGS: PMSettings = {
  projectsFolder: 'Projects',
  defaultView: 'table',
  ganttGranularity: 'week',
  ganttWeekLabel: 'weekNumber',
  statuses: DEFAULT_STATUSES,
  priorities: DEFAULT_PRIORITIES,
  globalTeamMembers: [],
  kanbanShowSubtasks: false,
  kanbanShowDescriptionPreview: false,
  showTagColors: true,
  notificationsEnabled: true,
  notificationLeadDays: 2,
  autoSchedule: true,
  saveTaskOnClose: true,
  inlineCodeCopyButton: true,
  projectFilters: {},
  collapsedTasks: {},
  calendarSources: [],
  meetingsFolder: 'Meetings',
  meetingTemplatePath: '',
  openHomeOnStartup: true,
  homeGreetingName: '',
  calendarTimeZone: '',
  calendarRefreshMinutes: 30,
  homeAgendaDays: 1,
  pinnedNotes: [],
  homeShowTasks: true,
  homeShowNotes: true,
  homeShowKanban: true,
  homeKanbanProject: '',
  claude: DEFAULT_CLAUDE_SETTINGS
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function makeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString()
  return {
    id: makeId(),
    title: 'New Task',
    description: '',
    type: 'task',
    status: 'todo',
    priority: 'medium',
    start: today().toString(),
    due: '',
    progress: 0,
    completed: '',
    assignees: [],
    tags: [],
    subtasks: [],
    dependencies: [],
    customFields: {},
    collapsed: false,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

export function makeProject(title: string, filePath: string): Project {
  const now = new Date().toISOString()
  return {
    id: makeId(),
    title,
    description: '',
    color: '#8b72be',
    icon: '📋',
    tasks: [],
    customFields: [],
    teamMembers: [],
    createdAt: now,
    updatedAt: now,
    filePath,
    savedViews: [],
    taskIndex: new Map()
  }
}

export function makeDefaultFilter(): FilterState {
  return {
    text: '',
    statuses: [],
    priorities: [],
    assignees: [],
    tags: [],
    dueDateFilter: 'any',
    showArchived: false
  }
}
