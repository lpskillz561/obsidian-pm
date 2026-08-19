import { Temporal } from '../../dates'

export interface GreetingStats {
  meetings: number
  overdue: number
  dueToday: number
}

function greetingFor(hour: number): string {
  if (hour < 5) return 'Still up'
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  if (hour < 22) return 'Good evening'
  return 'Good night'
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Oversized time-aware greeting, the full date, and a one-line summary of the day. */
export function renderGreeting(
  parentEl: HTMLElement,
  opts: { name: string; now: Temporal.ZonedDateTime; stats: GreetingStats }
): void {
  const header = parentEl.createDiv('pm-home-hero')

  const greeting = greetingFor(opts.now.hour)
  header.createEl('h1', {
    cls: 'pm-home-greeting',
    text: opts.name ? `${greeting}, ${opts.name}` : greeting
  })

  header.createDiv({
    cls: 'pm-home-date',
    text: opts.now.toPlainDate().toLocaleString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    })
  })

  const parts: string[] = []
  if (opts.stats.meetings > 0) parts.push(plural(opts.stats.meetings, 'meeting'))
  if (opts.stats.dueToday > 0) parts.push(`${opts.stats.dueToday} due today`)
  if (opts.stats.overdue > 0) parts.push(`${opts.stats.overdue} overdue`)

  const stats = header.createDiv('pm-home-stats')
  if (parts.length === 0) {
    stats.createSpan({ cls: 'pm-home-stat', text: 'Nothing on the schedule.' })
    return
  }
  parts.forEach((part, i) => {
    if (i > 0) stats.createSpan({ cls: 'pm-home-stat-sep', text: '·' })
    stats.createSpan({ cls: 'pm-home-stat', text: part })
  })
}
