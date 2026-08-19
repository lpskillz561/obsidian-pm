import { Temporal } from '../dates'
import type { ParsedEvent, RecurrenceRule } from './types'

/**
 * Bounded RRULE expansion.
 *
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT, UNTIL, BYDAY
 * (including ordinals like `2FR` and `-1MO`), BYMONTHDAY (including negatives) and
 * BYMONTH, plus EXDATE and RDATE.
 *
 * Deliberately unsupported: BYSETPOS, BYWEEKNO, BYYEARDAY and sub-daily BY* parts. Those
 * are flagged as `unsupported` at parse time and the series renders as a single event —
 * showing one real meeting beats inventing a wrong weekly cadence.
 */

const DAY_CODES: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 }

/** Guard against a malformed rule (e.g. UNTIL far in the future with no window overlap) spinning forever. */
const MAX_PERIODS = 5000

function withTimeOf(date: Temporal.PlainDate, template: Temporal.ZonedDateTime): Temporal.ZonedDateTime {
  return date
    .toPlainDateTime(template.toPlainTime())
    .toZonedDateTime(template.timeZoneId, { disambiguation: 'compatible' })
}

/** Resolve a possibly-negative day-of-month within a given month; null when out of range. */
function dayOfMonth(monthStart: Temporal.PlainDate, day: number): Temporal.PlainDate | null {
  const length = monthStart.daysInMonth
  const resolved = day > 0 ? day : length + day + 1
  if (resolved < 1 || resolved > length) return null
  return monthStart.with({ day: resolved })
}

/** All dates in the month matching a weekday code, in order. */
function weekdaysInMonth(monthStart: Temporal.PlainDate, dow: number): Temporal.PlainDate[] {
  const out: Temporal.PlainDate[] = []
  let d = monthStart.with({ day: 1 })
  d = d.add({ days: (dow - d.dayOfWeek + 7) % 7 })
  while (d.month === monthStart.month) {
    out.push(d)
    d = d.add({ days: 7 })
  }
  return out
}

/** Days selected inside one month by the BYMONTHDAY / BYDAY parts, sorted and de-duplicated. */
function daysInMonthFor(
  rule: RecurrenceRule,
  monthStart: Temporal.PlainDate,
  fallbackDay: number
): Temporal.PlainDate[] {
  const out: Temporal.PlainDate[] = []

  if (rule.byMonthDay.length > 0) {
    for (const day of rule.byMonthDay) {
      const d = dayOfMonth(monthStart, day)
      if (d) out.push(d)
    }
  }

  if (rule.byDay.length > 0) {
    for (const { ordinal, day } of rule.byDay) {
      const dow = DAY_CODES[day]
      if (!dow) continue
      const matches = weekdaysInMonth(monthStart, dow)
      if (ordinal === null) {
        out.push(...matches)
      } else {
        const picked = ordinal > 0 ? matches[ordinal - 1] : matches[matches.length + ordinal]
        if (picked) out.push(picked)
      }
    }
  }

  if (out.length === 0) {
    const d = dayOfMonth(monthStart, fallbackDay)
    if (d) out.push(d)
  }

  const seen = new Set<string>()
  return out
    .filter((d) => {
      const key = d.toString()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => Temporal.PlainDate.compare(a, b))
}

/** The PlainDates this rule selects within period number `period` (0 = the series' own period). */
function datesForPeriod(rule: RecurrenceRule, startDate: Temporal.PlainDate, period: number): Temporal.PlainDate[] {
  if (rule.freq === 'DAILY') {
    const d = startDate.add({ days: period * rule.interval })
    const allowed = rule.byDay.length === 0 || rule.byDay.some(({ day }) => DAY_CODES[day] === d.dayOfWeek)
    return allowed ? [d] : []
  }

  if (rule.freq === 'WEEKLY') {
    const weekStart = startDate.subtract({ days: startDate.dayOfWeek - 1 }).add({ weeks: period * rule.interval })
    const codes = rule.byDay.length > 0 ? rule.byDay.map((b) => DAY_CODES[b.day]) : [startDate.dayOfWeek]
    return codes
      .filter((dow): dow is number => Boolean(dow))
      .sort((a, b) => a - b)
      .map((dow) => weekStart.add({ days: dow - 1 }))
  }

  if (rule.freq === 'MONTHLY') {
    const monthStart = startDate.with({ day: 1 }).add({ months: period * rule.interval })
    if (rule.byMonth.length > 0 && !rule.byMonth.includes(monthStart.month)) return []
    return daysInMonthFor(rule, monthStart, startDate.day)
  }

  const yearStart = startDate.with({ month: 1, day: 1 }).add({ years: period * rule.interval })
  const months = rule.byMonth.length > 0 ? rule.byMonth : [startDate.month]
  const dates: Temporal.PlainDate[] = []
  for (const month of months) {
    if (month < 1 || month > 12) continue
    dates.push(...daysInMonthFor(rule, yearStart.with({ month }), startDate.day))
  }
  return dates.sort((a, b) => Temporal.PlainDate.compare(a, b))
}

/**
 * Rule occurrences in chronological order, starting at the series start.
 * Stops on COUNT, UNTIL, the iteration guard, or the first occurrence past `hardStop`.
 */
function generateStarts(
  rule: RecurrenceRule,
  seriesStart: Temporal.ZonedDateTime,
  hardStop: Temporal.Instant
): Temporal.ZonedDateTime[] {
  const startDate = seriesStart.toPlainDate()
  const out: Temporal.ZonedDateTime[] = []

  for (let period = 0; period < MAX_PERIODS; period++) {
    for (const date of datesForPeriod(rule, startDate, period)) {
      const candidate = withTimeOf(date, seriesStart)
      // Periods before the series start can contain earlier dates (e.g. a BYDAY week
      // that begins before DTSTART); they are not occurrences.
      if (Temporal.ZonedDateTime.compare(candidate, seriesStart) < 0) continue
      if (rule.until && Temporal.Instant.compare(candidate.toInstant(), rule.until) > 0) return out
      out.push(candidate)
      if (rule.count !== undefined && out.length >= rule.count) return out
      if (Temporal.Instant.compare(candidate.toInstant(), hardStop) > 0) return out
    }
  }

  return out
}

/**
 * All occurrence starts of `event` whose span overlaps `[from, to)`, in chronological order.
 * Non-recurring events and unsupported rules yield at most their single start.
 */
export function expandOccurrences(
  event: ParsedEvent,
  from: Temporal.Instant,
  to: Temporal.Instant
): Temporal.ZonedDateTime[] {
  const durationMs = event.end.epochMilliseconds - event.start.epochMilliseconds
  const span = Math.max(durationMs, 0)
  const overlaps = (start: Temporal.ZonedDateTime) => {
    const startMs = start.epochMilliseconds
    return startMs < to.epochMilliseconds && startMs + span > from.epochMilliseconds
  }

  const candidates: Temporal.ZonedDateTime[] = []

  if (event.rrule && !event.rrule.unsupported) {
    candidates.push(...generateStarts(event.rrule, event.start, to))
  } else {
    candidates.push(event.start)
  }

  candidates.push(...event.rDates)

  const excluded = new Set(event.exDates.map((i) => i.epochMilliseconds))
  const seen = new Set<number>()

  return candidates
    .filter((c) => {
      const ms = c.epochMilliseconds
      if (excluded.has(ms) || seen.has(ms)) return false
      seen.add(ms)
      return overlaps(c)
    })
    .sort((a, b) => Temporal.ZonedDateTime.compare(a, b))
}
