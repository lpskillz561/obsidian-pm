import { TFile } from 'obsidian'
import type PMPlugin from '../../main'
import type { CalendarEvent } from '../../calendar/types'
import { sanitizeFileName } from '../../utils'

/** Frontmatter key linking a note back to one occurrence of a calendar event. */
export const EVENT_KEY = 'pm_event_key'

const BUILT_IN_TEMPLATE = [
  '## Agenda',
  '',
  '## Notes',
  '',
  '## Decisions',
  '',
  '## Action items',
  '',
  '- [ ] ',
  ''
].join('\n')

/** JSON string syntax is a valid YAML double-quoted scalar, so this escapes safely. */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

function yamlList(values: string[]): string {
  return values.length === 0 ? '[]' : `\n${values.map((v) => `  - ${yamlString(v)}`).join('\n')}`
}

function timeLabel(event: CalendarEvent): string {
  if (event.allDay) return 'All day'
  const fmt = (z: typeof event.start) =>
    z.toPlainTime().toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${fmt(event.start)} – ${fmt(event.end)}`
}

export function meetingNotePath(plugin: PMPlugin, event: CalendarEvent): string {
  const folder = plugin.settings.meetingsFolder.replace(/\/+$/, '') || 'Meetings'
  const date = event.start.toPlainDate().toString()
  const time = event.allDay ? '' : ` ${event.start.toPlainTime().toString().slice(0, 5).replace(':', '')}`
  return `${folder}/${sanitizeFileName(`${date}${time} ${event.title}`).trim()}.md`
}

/**
 * Every note that carries a `pm_event_key`, indexed by that key.
 *
 * Built once per render rather than scanning the vault per event: the agenda checks
 * "does this meeting already have notes?" for every row, and a per-row scan is
 * files × events on a timer.
 */
export function buildMeetingNoteIndex(plugin: PMPlugin): Map<string, TFile> {
  const cache = plugin.app.metadataCache
  const index = new Map<string, TFile>()
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    const key: unknown = cache.getFileCache(file)?.frontmatter?.[EVENT_KEY]
    if (typeof key === 'string' && !index.has(key)) index.set(key, file)
  }
  return index
}

/**
 * The note for this occurrence, if one already exists.
 *
 * Looks up by the `pm_event_key` frontmatter rather than by path, so renaming or moving a
 * meeting note does not cause the next click to silently create a duplicate. The path is
 * only a fallback for notes created before the key existed.
 */
export function findMeetingNote(plugin: PMPlugin, event: CalendarEvent, index?: Map<string, TFile>): TFile | null {
  const found = (index ?? buildMeetingNoteIndex(plugin)).get(event.occurrenceKey)
  if (found) return found
  const byPath = plugin.app.vault.getAbstractFileByPath(meetingNotePath(plugin, event))
  return byPath instanceof TFile ? byPath : null
}

async function templateBody(plugin: PMPlugin): Promise<string> {
  const path = plugin.settings.meetingTemplatePath.trim()
  if (!path) return BUILT_IN_TEMPLATE
  const file = plugin.app.vault.getAbstractFileByPath(path.endsWith('.md') ? path : `${path}.md`)
  if (!(file instanceof TFile)) return BUILT_IN_TEMPLATE
  const raw = await plugin.app.vault.read(file)
  // Strip the template's own frontmatter; ours is authoritative.
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

function buildNote(plugin: PMPlugin, event: CalendarEvent, body: string): string {
  const source = plugin.settings.calendarSources.find((s) => s.id === event.sourceId)
  const lines = [
    '---',
    `${EVENT_KEY}: ${yamlString(event.occurrenceKey)}`,
    `title: ${yamlString(event.title)}`,
    `date: ${event.start.toPlainDate().toString()}`,
    `time: ${yamlString(timeLabel(event))}`,
    `calendar: ${yamlString(source?.name ?? '')}`,
    `organizer: ${yamlString(event.organizer)}`,
    `attendees: ${yamlList(event.attendees)}`,
    `location: ${yamlString(event.location)}`,
    'tags:',
    '  - meeting',
    '---',
    '',
    `# ${event.title}`,
    ''
  ]
  return `${lines.join('\n')}\n${body}`
}

/** Open the note for this meeting, creating it from the template on first use. */
export async function openMeetingNote(plugin: PMPlugin, event: CalendarEvent): Promise<TFile> {
  const existing = findMeetingNote(plugin, event)
  if (existing) {
    await plugin.app.workspace.getLeaf('tab').openFile(existing)
    return existing
  }

  const path = meetingNotePath(plugin, event)
  await plugin.store.ensureFolder(path.slice(0, path.lastIndexOf('/')))
  const file = await plugin.app.vault.create(path, buildNote(plugin, event, await templateBody(plugin)))
  await plugin.app.workspace.getLeaf('tab').openFile(file)
  return file
}
