import { requestUrl } from 'obsidian'
import { Temporal } from '../dates'
import type PMPlugin from '../main'
import { localTimeZone, parseIcs, toDisplayZone } from './ics'
import { expandOccurrences } from './rrule'
import type { CalendarEvent, CalendarSource, ParsedEvent } from './types'

interface CachedFeed {
  url: string
  ics: string
  fetchedAt: number
}

interface CacheFile {
  feeds: Record<string, CachedFeed>
}

export interface SourceError {
  sourceId: string
  name: string
  message: string
}

const CACHE_FILE = 'calendar-cache.json'

/** `webcal://` is just https with a different scheme hint; requestUrl will not follow it. */
function normalizeUrl(url: string): string {
  return url.trim().replace(/^webcal:\/\//i, 'https://')
}

export function makeOccurrenceKey(uid: string, start: Temporal.ZonedDateTime): string {
  return `${uid}@${start.toInstant().epochMilliseconds}`
}

/**
 * Fetches, caches and merges the subscribed iCal feeds.
 *
 * The cache holds raw ICS text rather than parsed events: parsing is cheap, and raw text
 * needs no serialization format of its own, so a change to the parser cannot leave a
 * stale cache in an unreadable shape.
 */
export class CalendarStore {
  private feeds: Record<string, CachedFeed> = {}
  private parsed = new Map<string, ParsedEvent[]>()
  private errors: SourceError[] = []
  private loaded = false
  private inFlight: Promise<void> | null = null
  /** The zone the cached parse was built for; a settings change invalidates it. */
  private parsedTz = ''

  constructor(private plugin: PMPlugin) {}

  /**
   * The zone all times are shown in. Empty setting = follow the machine, which is what
   * most people want; an explicit zone keeps the agenda in one place when travelling.
   */
  get timeZone(): string {
    return this.plugin.settings.calendarTimeZone || localTimeZone()
  }

  /** `now` in the display zone, so the greeting and the now-marker agree with the agenda. */
  now(): Temporal.ZonedDateTime {
    return Temporal.Now.zonedDateTimeISO(this.timeZone)
  }

  get lastFetchedAt(): number | null {
    const stamps = Object.values(this.feeds).map((f) => f.fetchedAt)
    return stamps.length > 0 ? Math.min(...stamps) : null
  }

  get sourceErrors(): readonly SourceError[] {
    return this.errors
  }

  get hasSources(): boolean {
    return this.plugin.settings.calendarSources.some((s) => s.enabled && s.url.trim())
  }

  private get cachePath(): string | null {
    const dir = this.plugin.manifest.dir
    return dir ? `${dir}/${CACHE_FILE}` : null
  }

  /** Read the on-disk cache so the first paint has data before any network call returns. */
  async loadCache(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const path = this.cachePath
    if (!path) return
    try {
      const adapter = this.plugin.app.vault.adapter
      if (!(await adapter.exists(path))) return
      const parsed = JSON.parse(await adapter.read(path)) as CacheFile
      this.feeds = parsed.feeds ?? {}
      this.reparseAll()
    } catch (err) {
      console.error('[PM] could not read the calendar cache', err)
    }
  }

  private async saveCache(): Promise<void> {
    const path = this.cachePath
    if (!path) return
    try {
      await this.plugin.app.vault.adapter.write(path, JSON.stringify({ feeds: this.feeds } satisfies CacheFile))
    } catch (err) {
      console.error('[PM] could not write the calendar cache', err)
    }
  }

  private reparseAll(): void {
    this.parsed.clear()
    const tz = this.timeZone
    this.parsedTz = tz
    for (const [sourceId, feed] of Object.entries(this.feeds)) {
      try {
        this.parsed.set(sourceId, parseIcs(feed.ics, tz))
      } catch (err) {
        console.error('[PM] could not parse a calendar feed', err)
        this.parsed.set(sourceId, [])
      }
    }
  }

  /** Whether the newest data we hold is older than the configured refresh interval. */
  isStale(): boolean {
    const at = this.lastFetchedAt
    if (at === null) return true
    const minutes = this.plugin.settings.calendarRefreshMinutes
    return Date.now() - at > Math.max(minutes, 1) * 60_000
  }

  /** Fetch every enabled source. Concurrent calls share one in-flight refresh. */
  async refresh(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (!force && !this.isStale()) return
    const run = this.doRefresh()
    this.inFlight = run
    try {
      await run
    } finally {
      this.inFlight = null
    }
  }

  private async doRefresh(): Promise<void> {
    const sources = this.plugin.settings.calendarSources.filter((s) => s.enabled && s.url.trim())
    const errors: SourceError[] = []

    await Promise.all(
      sources.map(async (source) => {
        try {
          const res = await requestUrl({ url: normalizeUrl(source.url), method: 'GET', throw: false })
          if (res.status >= 400 || !res.text.includes('BEGIN:VCALENDAR')) {
            // Never include the URL in the message — it is a credential.
            errors.push({
              sourceId: source.id,
              name: source.name,
              message: res.status >= 400 ? `feed returned HTTP ${res.status}` : 'feed did not return a calendar'
            })
            return
          }
          this.feeds[source.id] = { url: source.url, ics: res.text, fetchedAt: Date.now() }
        } catch {
          errors.push({ sourceId: source.id, name: source.name, message: 'could not reach the feed' })
        }
      })
    )

    // Drop cached feeds for sources that were deleted or had their URL changed — a stale
    // feed under a re-pointed source would show someone else's calendar.
    this.feeds = Object.fromEntries(
      Object.entries(this.feeds).filter(([id, feed]) => sources.some((s) => s.id === id && s.url === feed.url))
    )

    this.errors = errors
    this.reparseAll()
    await this.saveCache()
  }

  /**
   * Every occurrence overlapping `[from, to)` across all enabled sources, sorted by start.
   *
   * A VEVENT carrying RECURRENCE-ID replaces one occurrence of its series. The original
   * slot is dropped and the override emitted at its own time; without this a rescheduled
   * standup would render twice, at both the old and the new time.
   */
  eventsForRange(from: Temporal.ZonedDateTime, to: Temporal.ZonedDateTime): CalendarEvent[] {
    // All-day anchoring depends on the display zone, so a zone change needs a reparse.
    if (this.parsedTz !== this.timeZone) this.reparseAll()

    const tz = this.timeZone
    const fromInstant = from.toInstant()
    const toInstant = to.toInstant()
    const out: CalendarEvent[] = []

    for (const source of this.plugin.settings.calendarSources) {
      if (!source.enabled) continue
      const events = this.parsed.get(source.id)
      if (!events) continue

      for (const [, group] of groupByUid(events)) {
        const overrides = new Map<number, ParsedEvent>()
        for (const event of group) {
          if (event.recurrenceId) overrides.set(event.recurrenceId.epochMilliseconds, event)
        }

        for (const master of group) {
          if (master.recurrenceId) continue
          for (const start of expandOccurrences(master, fromInstant, toInstant)) {
            if (overrides.has(start.epochMilliseconds)) continue
            out.push(toCalendarEvent(master, start, source, tz))
          }
        }

        for (const override of overrides.values()) {
          const span = Math.max(override.end.epochMilliseconds - override.start.epochMilliseconds, 0)
          const startMs = override.start.epochMilliseconds
          if (startMs < toInstant.epochMilliseconds && startMs + span > fromInstant.epochMilliseconds) {
            out.push(toCalendarEvent(override, override.start, source, tz))
          }
        }
      }
    }

    return out.sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
      return a.start.epochMilliseconds - b.start.epochMilliseconds
    })
  }
}

function groupByUid(events: ParsedEvent[]): Map<string, ParsedEvent[]> {
  const map = new Map<string, ParsedEvent[]>()
  for (const event of events) {
    const group = map.get(event.uid)
    if (group) group.push(event)
    else map.set(event.uid, [event])
  }
  return map
}

function toCalendarEvent(
  event: ParsedEvent,
  start: Temporal.ZonedDateTime,
  source: CalendarSource,
  displayTz: string
): CalendarEvent {
  const span = Math.max(event.end.epochMilliseconds - event.start.epochMilliseconds, 0)
  // The occurrence key is derived before the zone shift so it stays stable — changing the
  // display timezone must not orphan every existing meeting note.
  const occurrenceKey = makeOccurrenceKey(event.uid, start)
  const displayStart = toDisplayZone(start, event.allDay, displayTz)
  return {
    uid: event.uid,
    occurrenceKey,
    sourceId: source.id,
    title: event.title,
    allDay: event.allDay,
    start: displayStart,
    end: displayStart.add({ milliseconds: span }),
    location: event.location,
    description: event.description,
    organizer: event.organizer,
    attendees: event.attendees,
    url: event.url
  }
}
