import { setIcon, setTooltip, type TFile } from 'obsidian'
import type PMPlugin from '../../main'
import type { CalendarEvent } from '../../calendar/types'
import { Temporal } from '../../dates'
import { safeAsync } from '../../utils'
import { EmptyState } from '../../ui/primitives/EmptyState'
import { buildMeetingNoteIndex, findMeetingNote, openMeetingNote } from './MeetingNotes'

export interface AgendaContext {
  plugin: PMPlugin
  /** The first day shown; the panel renders `homeAgendaDays` days from here. */
  anchor: Temporal.PlainDate
  now: Temporal.ZonedDateTime
  events: CalendarEvent[]
  onShiftDay: (delta: number) => void
  onToday: () => void
  onRefresh: () => void
  refreshing: boolean
}

function formatTime(zdt: Temporal.ZonedDateTime): { time: string; suffix: string } {
  const formatted = zdt.toPlainTime().toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
  // "9:00 AM" in 12-hour locales, "09:00" in 24-hour ones.
  const split = formatted.lastIndexOf(' ')
  if (split === -1) return { time: formatted, suffix: '' }
  return { time: formatted.slice(0, split), suffix: formatted.slice(split + 1) }
}

function dayHeading(date: Temporal.PlainDate, today: Temporal.PlainDate): string {
  const diff = today.until(date, { largestUnit: 'day' }).days
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return date.toLocaleString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

function staleLabel(fetchedAt: number | null): string {
  if (fetchedAt === null) return 'never synced'
  const minutes = Math.floor((Date.now() - fetchedAt) / 60_000)
  if (minutes < 1) return 'synced just now'
  if (minutes < 60) return `synced ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `synced ${hours}h ago`
  return `synced ${Math.floor(hours / 24)}d ago`
}

export function renderAgenda(parentEl: HTMLElement, ctx: AgendaContext): void {
  const panel = parentEl.createDiv('pm-home-panel pm-home-agenda')
  const today = ctx.now.toPlainDate()
  const noteIndex = buildMeetingNoteIndex(ctx.plugin)

  // ── Header ────────────────────────────────────────────────────────────────
  const head = panel.createDiv('pm-home-panel-head')
  head.createEl('h2', { cls: 'pm-home-panel-title', text: dayHeading(ctx.anchor, today) })

  const controls = head.createDiv('pm-home-panel-controls')
  const navButton = (icon: string, tooltip: string, onClick: () => void) => {
    const btn = controls.createEl('button', { cls: 'pm-home-nav-btn' })
    setIcon(btn, icon)
    setTooltip(btn, tooltip)
    btn.addEventListener('click', onClick)
    return btn
  }
  navButton('chevron-left', 'Previous day', () => ctx.onShiftDay(-1))
  if (Temporal.PlainDate.compare(ctx.anchor, today) !== 0) {
    const btn = controls.createEl('button', { cls: 'pm-home-nav-btn pm-home-nav-btn--text', text: 'Today' })
    btn.addEventListener('click', () => ctx.onToday())
  }
  navButton('chevron-right', 'Next day', () => ctx.onShiftDay(1))
  const refresh = navButton('refresh-cw', 'Refresh calendars', () => ctx.onRefresh())
  refresh.toggleClass('pm-home-nav-btn--spinning', ctx.refreshing)

  // ── Sync status ───────────────────────────────────────────────────────────
  const store = ctx.plugin.calendars
  if (store.hasSources) {
    const status = panel.createDiv('pm-home-sync')
    status.createSpan({ cls: 'pm-home-sync-text', text: staleLabel(store.lastFetchedAt) })
    for (const error of store.sourceErrors) {
      const warn = status.createSpan({ cls: 'pm-home-sync-error' })
      setIcon(warn.createSpan('pm-home-sync-error-icon'), 'alert-triangle')
      warn.createSpan({ text: `${error.name}: ${error.message}` })
    }
  }

  // ── Body ──────────────────────────────────────────────────────────────────
  const body = panel.createDiv('pm-home-agenda-body')

  if (!store.hasSources) {
    new EmptyState(body)
      .setIcon('🗓')
      .setTitle('No calendars yet')
      .setBody('Add a secret iCal URL in Settings → Project manager → Calendars to see your day here.')
    return
  }

  const days = Math.max(ctx.plugin.settings.homeAgendaDays, 1)
  let rendered = 0

  for (let offset = 0; offset < days; offset++) {
    const date = ctx.anchor.add({ days: offset })
    const forDay = ctx.events.filter((e) => Temporal.PlainDate.compare(e.start.toPlainDate(), date) === 0)
    if (forDay.length === 0) continue
    rendered += forDay.length

    if (days > 1) {
      body.createDiv({ cls: 'pm-home-agenda-day', text: dayHeading(date, today) })
    }

    const allDay = forDay.filter((e) => e.allDay)
    if (allDay.length > 0) {
      const strip = body.createDiv('pm-home-allday')
      for (const event of allDay) renderAllDayChip(strip, ctx, event)
    }

    const timed = forDay.filter((e) => !e.allDay)
    if (timed.length === 0) continue

    const list = body.createEl('ol', { cls: 'pm-home-timeline' })
    const isToday = Temporal.PlainDate.compare(date, today) === 0
    let nowPlaced = !isToday

    // Dimming past meetings only means something when there is something ahead to look at.
    // Late in the day everything is past, and greying the whole agenda just reads as broken.
    const anyUpcoming = timed.some((e) => e.end.epochMilliseconds > ctx.now.epochMilliseconds)
    const dimPast = isToday && anyUpcoming

    for (const event of timed) {
      if (!nowPlaced && event.start.epochMilliseconds > ctx.now.epochMilliseconds) {
        renderNowMarker(list, ctx.now)
        nowPlaced = true
      }
      renderEvent(list, ctx, event, noteIndex, dimPast)
    }
    if (!nowPlaced) renderNowMarker(list, ctx.now)
  }

  if (rendered === 0) {
    new EmptyState(body)
      .setIcon('☕')
      .setTitle('Nothing scheduled')
      .setBody('No meetings on the calendar for this day.')
  }
}

function colorFor(ctx: AgendaContext, event: CalendarEvent): string {
  return ctx.plugin.settings.calendarSources.find((s) => s.id === event.sourceId)?.color ?? 'var(--pm-accent)'
}

function calendarName(ctx: AgendaContext, event: CalendarEvent): string {
  return ctx.plugin.settings.calendarSources.find((s) => s.id === event.sourceId)?.name ?? ''
}

function renderAllDayChip(parentEl: HTMLElement, ctx: AgendaContext, event: CalendarEvent): void {
  const chip = parentEl.createDiv('pm-home-allday-chip')
  chip.setCssProps({ '--pm-cal-color': colorFor(ctx, event) })
  chip.createSpan({ cls: 'pm-home-allday-dot' })
  chip.createSpan({ cls: 'pm-home-allday-label', text: event.title })
  chip.addEventListener(
    'click',
    safeAsync(async () => void (await openMeetingNote(ctx.plugin, event)))
  )
}

function renderNowMarker(list: HTMLElement, now: Temporal.ZonedDateTime): void {
  const item = list.createEl('li', { cls: 'pm-home-now' })
  const { time, suffix } = formatTime(now)
  item.createDiv({ cls: 'pm-home-now-time', text: suffix ? `${time} ${suffix}` : time })
  item.createDiv('pm-home-now-line')
}

function renderEvent(
  list: HTMLElement,
  ctx: AgendaContext,
  event: CalendarEvent,
  noteIndex: Map<string, TFile>,
  dimPast: boolean
): void {
  const nowMs = ctx.now.epochMilliseconds
  const inProgress = event.start.epochMilliseconds <= nowMs && event.end.epochMilliseconds > nowMs
  const past = dimPast && event.end.epochMilliseconds <= nowMs

  const item = list.createEl('li', { cls: 'pm-home-event' })
  item.setCssProps({ '--pm-cal-color': colorFor(ctx, event) })
  item.toggleClass('pm-home-event--now', inProgress)
  item.toggleClass('pm-home-event--past', past)

  const { time, suffix } = formatTime(event.start)
  const gutter = item.createDiv('pm-home-event-gutter')
  gutter.createDiv({ cls: 'pm-home-event-time', text: time })
  if (suffix) gutter.createDiv({ cls: 'pm-home-event-suffix', text: suffix })

  item.createDiv('pm-home-event-rail')

  const card = item.createDiv('pm-home-event-card')
  const titleRow = card.createDiv('pm-home-event-titlerow')
  titleRow.createSpan({ cls: 'pm-home-event-title', text: event.title })
  if (findMeetingNote(ctx.plugin, event, noteIndex)) {
    const mark = titleRow.createSpan({ cls: 'pm-home-event-hasnote' })
    setIcon(mark, 'file-text')
    setTooltip(mark, 'Notes exist for this meeting')
  }

  const meta = card.createDiv('pm-home-event-meta')
  const { time: endTime, suffix: endSuffix } = formatTime(event.end)
  meta.createSpan({ text: `until ${endSuffix ? `${endTime} ${endSuffix}` : endTime}` })
  const calendar = calendarName(ctx, event)
  if (calendar) meta.createSpan({ cls: 'pm-home-event-cal', text: calendar })
  if (event.location) meta.createSpan({ cls: 'pm-home-event-loc', text: event.location })
  if (event.attendees.length > 0) {
    meta.createSpan({ text: `${event.attendees.length} attending` })
    setTooltip(meta, event.attendees.join(', '))
  }

  const action = card.createEl('button', { cls: 'pm-home-event-action', text: 'Take notes' })
  const open = safeAsync(async () => void (await openMeetingNote(ctx.plugin, event)))
  action.addEventListener('click', (e) => {
    e.stopPropagation()
    open()
  })
  card.addEventListener('click', () => open())
}
