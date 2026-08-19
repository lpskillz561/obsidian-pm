import { Temporal } from '../dates'

/** A subscribed read-only iCal feed (Google "secret address", Outlook "publish calendar"). */
export interface CalendarSource {
  id: string
  name: string
  url: string
  color: string
  enabled: boolean
}

/**
 * One occurrence of a calendar event, already resolved into the local timezone.
 * A recurring series produces many of these, all sharing `uid`.
 */
export interface CalendarEvent {
  uid: string
  /** Stable identity of this single occurrence: `uid` + start instant. Meeting notes key off this. */
  occurrenceKey: string
  sourceId: string
  title: string
  allDay: boolean
  start: Temporal.ZonedDateTime
  end: Temporal.ZonedDateTime
  location: string
  description: string
  organizer: string
  attendees: string[]
  url: string
}

export type RecurFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

/** A parsed RRULE, restricted to the parts we expand. See `rrule.ts` for what is deliberately unsupported. */
export interface RecurrenceRule {
  freq: RecurFreq
  interval: number
  count?: number
  /** Exclusive upper bound as an instant; UNTIL is always compared in absolute time. */
  until?: Temporal.Instant
  /** Weekday codes: MO TU WE TH FR SA SU. Ordinal prefixes (e.g. "2FR") are kept as `{ ordinal, day }`. */
  byDay: Array<{ ordinal: number | null; day: string }>
  byMonthDay: number[]
  byMonth: number[]
  /** True when the rule uses parts we do not expand; such series render as a single event. */
  unsupported: boolean
}

/** A VEVENT after parsing, before recurrence expansion. */
export interface ParsedEvent {
  uid: string
  title: string
  allDay: boolean
  start: Temporal.ZonedDateTime
  end: Temporal.ZonedDateTime
  location: string
  description: string
  organizer: string
  attendees: string[]
  url: string
  rrule: RecurrenceRule | null
  /** Excluded occurrence starts, as instants. */
  exDates: Temporal.Instant[]
  /** Extra occurrence starts, as zoned date-times in the event's own zone. */
  rDates: Temporal.ZonedDateTime[]
  /**
   * Set when this VEVENT overrides a single occurrence of a series. The value is the
   * ORIGINAL start of the occurrence being replaced, not this event's own start.
   */
  recurrenceId: Temporal.Instant | null
}

export function makeSourceId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export const DEFAULT_CALENDAR_COLORS = ['#8b72be', '#79b58d', '#b8a06b', '#c47070', '#6b9bc4', '#b57ba8']
