import { TFile, setIcon, setTooltip } from 'obsidian'
import type PMPlugin from '../../main'
import { safeAsync } from '../../utils'

const RECENT_LIMIT = 8

function relativeTime(ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function inFolder(path: string, folder: string): boolean {
  const clean = folder.replace(/\/+$/, '')
  return Boolean(clean) && (path === clean || path.startsWith(`${clean}/`))
}

/** Recently edited notes, excluding the plugin's own project files. */
function recentNotes(plugin: PMPlugin): TFile[] {
  const pinned = new Set(plugin.settings.pinnedNotes)
  return plugin.app.vault
    .getMarkdownFiles()
    .filter((f) => !inFolder(f.path, plugin.settings.projectsFolder) && !pinned.has(f.path))
    .sort((a, b) => b.stat.mtime - a.stat.mtime)
    .slice(0, RECENT_LIMIT)
}

export function renderNotesPanel(parentEl: HTMLElement, plugin: PMPlugin, onChange: () => void): void {
  const panel = parentEl.createDiv('pm-home-panel pm-home-notes')
  panel.createDiv('pm-home-panel-head').createEl('h2', { cls: 'pm-home-panel-title', text: 'Notes' })

  const pinned = plugin.settings.pinnedNotes
    .map((path) => plugin.app.vault.getAbstractFileByPath(path))
    .filter((f): f is TFile => f instanceof TFile)

  // Drop pins whose file was deleted, so the list does not silently accumulate ghosts.
  if (pinned.length !== plugin.settings.pinnedNotes.length) {
    plugin.settings.pinnedNotes = pinned.map((f) => f.path)
    void plugin.saveSettings()
  }

  if (pinned.length > 0) {
    const section = panel.createDiv('pm-home-notegroup')
    section.createDiv({ cls: 'pm-home-notegroup-label', text: 'Pinned' })
    for (const file of pinned) renderNoteRow(section, plugin, file, true, onChange)
  }

  const recent = recentNotes(plugin)
  if (recent.length === 0 && pinned.length === 0) {
    panel.createDiv({ cls: 'pm-home-panel-quiet', text: 'No notes in the vault yet.' })
    return
  }

  if (recent.length > 0) {
    const section = panel.createDiv('pm-home-notegroup')
    section.createDiv({ cls: 'pm-home-notegroup-label', text: 'Recent' })
    for (const file of recent) renderNoteRow(section, plugin, file, false, onChange)
  }
}

function renderNoteRow(
  parentEl: HTMLElement,
  plugin: PMPlugin,
  file: TFile,
  isPinned: boolean,
  onChange: () => void
): void {
  const row = parentEl.createDiv('pm-home-note')
  row.toggleClass('pm-home-note--pinned', isPinned)

  setIcon(row.createSpan('pm-home-note-icon'), isPinned ? 'pin' : 'file-text')
  row.createSpan({ cls: 'pm-home-note-title', text: file.basename })

  const folder = file.parent?.path ?? ''
  if (folder && folder !== '/') row.createSpan({ cls: 'pm-home-note-folder', text: folder })
  row.createSpan({ cls: 'pm-home-note-time', text: relativeTime(file.stat.mtime) })

  const toggle = row.createEl('button', { cls: 'pm-home-note-pin' })
  setIcon(toggle, isPinned ? 'pin-off' : 'pin')
  setTooltip(toggle, isPinned ? 'Unpin' : 'Pin to home')
  toggle.addEventListener('click', (e) => {
    e.stopPropagation()
    const pins = plugin.settings.pinnedNotes
    const at = pins.indexOf(file.path)
    if (at >= 0) pins.splice(at, 1)
    else pins.push(file.path)
    void plugin.saveSettings()
    onChange()
  })

  row.addEventListener(
    'click',
    safeAsync(async () => {
      await plugin.app.workspace.getLeaf('tab').openFile(file)
    })
  )
}
