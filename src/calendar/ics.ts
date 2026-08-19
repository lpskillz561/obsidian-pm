import { Temporal } from '../dates'
import type { ParsedEvent, RecurFreq, RecurrenceRule } from './types'

/**
 * A minimal RFC 5545 reader, scoped to what a read-only subscription feed actually contains.
 * Only VEVENT is understood; VTODO, VJOURNAL, VFREEBUSY and VALARM blocks are skipped.
 */

export interface IcsLine {
  name: string
  params: Record<string, string>
  value: string
}

/**
 * Outlook and some Exchange exports emit Windows timezone names rather than IANA ones.
 * Only the common zones are mapped; anything unknown falls back to the local zone.
 */
const WINDOWS_TZ: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'Mountain Standard Time': 'America/Denver',
  'Mountain Standard Time (Mexico)': 'America/Chihuahua',
  'US Mountain Standard Time': 'America/Phoenix',
  'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indianapolis',
  'Atlantic Standard Time': 'America/Halifax',
  'SA Pacific Standard Time': 'America/Bogota',
  'SA Eastern Standard Time': 'America/Cayenne',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'GTB Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Kiev',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Russian Standard Time': 'Europe/Moscow',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Arab Standard Time': 'Asia/Riyadh',
  'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Calcutta',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'New Zealand Standard Time': 'Pacific/Auckland',
  UTC: 'UTC'
}

/** Local IANA timezone. Injectable so tests are not machine-dependent. */
export function localTimeZone(): string {
  return Temporal.Now.timeZoneId()
}

/**
 * Move an occurrence into the zone the UI renders in.
 *
 * A VEVENT keeps its organiser's TZID, so a Teams invite booked from London stays a
 * `Europe/London` ZonedDateTime. Its instant is correct, but `toPlainTime()` would print
 * the organiser's wall clock — 2:30 PM for a meeting an Eastern reader attends at 9:30 AM.
 * Recurrence is expanded in the original zone first (so a series holds its local time
 * across each region's own DST switch); only then is it converted for display.
 *
 * All-day events are anchored at local midnight already and must not be shifted, or a
 * holiday lands on the wrong date.
 */
export function toDisplayZone(zdt: Temporal.ZonedDateTime, allDay: boolean, displayTz: string): Temporal.ZonedDateTime {
  return allDay ? zdt : zdt.withTimeZone(displayTz)
}

/**
 * Undo RFC 5545 line folding. A continuation line begins with a space or tab and belongs
 * to the previous line. Parsing before unfolding truncates any long SUMMARY, URL or
 * DESCRIPTION, which is the single most common way a hand-rolled ICS reader goes wrong.
 */
export function unfold(text: string): string[] {
  const raw = text.split(/\r\n|\n|\r/)
  const out: string[] = []
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1)
    } else {
      out.push(line)
    }
  }
  return out.filter((l) => l.length > 0)
}

/** Split `NAME;PARAM=VALUE;PARAM="quoted:value":the value` respecting quoted parameter values. */
export function parseLine(line: string): IcsLine | null {
  let inQuote = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuote = !inQuote
    else if (c === ':' && !inQuote) {
      colon = i
      break
    }
  }
  if (colon === -1) return null

  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)

  const segments: string[] = []
  let current = ''
  inQuote = false
  for (const c of head) {
    if (c === '"') {
      inQuote = !inQuote
      current += c
    } else if (c === ';' && !inQuote) {
      segments.push(current)
      current = ''
    } else {
      current += c
    }
  }
  segments.push(current)

  const name = (segments.shift() ?? '').toUpperCase()
  if (!name) return null

  const params: Record<string, string> = {}
  for (const seg of segments) {
    const eq = seg.indexOf('=')
    if (eq === -1) continue
    const key = seg.slice(0, eq).toUpperCase()
    let val = seg.slice(eq + 1)
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
    params[key] = val
  }

  return { name, params, value }
}

/** Reverse the TEXT escaping of RFC 5545 §3.3.11. */
export function unescapeText(value: string): string {
  return value.replace(/\\([nN;,\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

function resolveZone(tzid: string | undefined, fallback: string): string {
  if (!tzid) return fallback
  const mapped = WINDOWS_TZ[tzid] ?? tzid
  try {
    Temporal.PlainDateTime.from('2000-01-01T00:00:00').toZonedDateTime(mapped)
    return mapped
  } catch {
    return fallback
  }
}

/** `20260819T090000` / `20260819` / `20260819T130000Z` → an ISO string Temporal accepts. */
function toIso(compact: string): string {
  const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
  if (compact.length <= 8) return date
  const time = `${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15) || '00'}`
  return `${date}T${time}`
}

export interface IcsDate {
  allDay: boolean
  zdt: Temporal.ZonedDateTime
}

/**
 * Resolve a DTSTART/DTEND/RECURRENCE-ID value. Handles the three encodings a real feed
 * uses: a floating or TZID-qualified local time, a UTC instant (`Z` suffix), and a
 * `VALUE=DATE` all-day date. Returns null rather than throwing on malformed input so a
 * single bad event cannot take down the whole feed.
 */
export function parseIcsDate(line: IcsLine, localTz: string): IcsDate | null {
  const value = line.value.trim()
  if (!value) return null
  try {
    if (line.params['VALUE'] === 'DATE' || value.length === 8) {
      const zdt = Temporal.PlainDate.from(toIso(value)).toZonedDateTime(localTz)
      return { allDay: true, zdt }
    }
    if (value.endsWith('Z')) {
      const instant = Temporal.Instant.from(`${toIso(value.slice(0, -1))}Z`)
      return { allDay: false, zdt: instant.toZonedDateTimeISO(localTz) }
    }
    const zone = resolveZone(line.params['TZID'], localTz)
    return { allDay: false, zdt: Temporal.PlainDateTime.from(toIso(value)).toZonedDateTime(zone) }
  } catch {
    return null
  }
}

/** Parse an ISO 8601 duration as used by the DURATION property (e.g. `PT1H30M`, `-P1D`). */
export function parseIcsDuration(value: string): Temporal.Duration | null {
  try {
    return Temporal.Duration.from(value)
  } catch {
    return null
  }
}

const FREQS: RecurFreq[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']
/** Rule parts we do not expand. A series using any of them is rendered as a single event. */
const UNSUPPORTED_PARTS = ['BYSETPOS', 'BYWEEKNO', 'BYYEARDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND']

export function parseRRule(value: string, localTz: string): RecurrenceRule | null {
  const parts: Record<string, string> = {}
  for (const chunk of value.split(';')) {
    const eq = chunk.indexOf('=')
    if (eq === -1) continue
    parts[chunk.slice(0, eq).toUpperCase()] = chunk.slice(eq + 1)
  }

  const freq = (parts['FREQ'] ?? '').toUpperCase() as RecurFreq
  if (!FREQS.includes(freq)) return null

  const interval = Number.parseInt(parts['INTERVAL'] ?? '1', 10)
  const count = parts['COUNT'] ? Number.parseInt(parts['COUNT'], 10) : undefined

  let until: Temporal.Instant | undefined
  if (parts['UNTIL']) {
    const parsed = parseIcsDate({ name: 'UNTIL', params: {}, value: parts['UNTIL'] }, localTz)
    if (parsed) until = parsed.zdt.toInstant()
  }

  const byDay = (parts['BYDAY'] ?? '')
    .split(',')
    .filter(Boolean)
    .map((token) => {
      const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(token.trim().toUpperCase())
      if (!m) return null
      return { ordinal: m[1] ? Number.parseInt(m[1], 10) : null, day: m[2] }
    })
    .filter((d): d is { ordinal: number | null; day: string } => d !== null)

  const numbers = (key: string) =>
    (parts[key] ?? '')
      .split(',')
      .filter(Boolean)
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => Number.isFinite(n))

  return {
    freq,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 1,
    ...(count !== undefined && Number.isFinite(count) ? { count } : {}),
    ...(until ? { until } : {}),
    byDay,
    byMonthDay: numbers('BYMONTHDAY'),
    byMonth: numbers('BYMONTH'),
    unsupported: UNSUPPORTED_PARTS.some((p) => p in parts)
  }
}

/** Pull the display name out of an ATTENDEE/ORGANIZER line, falling back to the mailto address. */
export function personName(line: IcsLine): string {
  const cn = line.params['CN']
  if (cn) return unescapeText(cn)
  return line.value.replace(/^mailto:/i, '').trim()
}

/**
 * Parse a whole calendar into VEVENTs. Cancelled events are dropped. Events missing a
 * usable DTSTART are dropped; everything else degrades to a sensible default rather than
 * failing the feed.
 */
export function parseIcs(text: string, localTz: string = localTimeZone()): ParsedEvent[] {
  const events: ParsedEvent[] = []
  let current: IcsLine[] | null = null
  let depth = 0

  for (const raw of unfold(text)) {
    const line = parseLine(raw)
    if (!line) continue

    if (line.name === 'BEGIN') {
      if (line.value.toUpperCase() === 'VEVENT' && depth === 0) {
        current = []
        depth = 1
      } else if (current) {
        depth++
      }
      continue
    }
    if (line.name === 'END') {
      if (current) {
        depth--
        if (depth === 0) {
          const parsed = buildEvent(current, localTz)
          if (parsed) events.push(parsed)
          current = null
        }
      }
      continue
    }
    // Skip nested components (VALARM); their properties are not the event's.
    if (current && depth === 1) current.push(line)
  }

  return events
}

function buildEvent(lines: IcsLine[], localTz: string): ParsedEvent | null {
  const first = (name: string) => lines.find((l) => l.name === name)
  const all = (name: string) => lines.filter((l) => l.name === name)

  const status = first('STATUS')?.value.toUpperCase()
  if (status === 'CANCELLED') return null

  const dtStartLine = first('DTSTART')
  if (!dtStartLine) return null
  const start = parseIcsDate(dtStartLine, localTz)
  if (!start) return null

  let end: Temporal.ZonedDateTime
  const dtEndLine = first('DTEND')
  const durationLine = first('DURATION')
  const parsedEnd = dtEndLine ? parseIcsDate(dtEndLine, localTz) : null
  if (parsedEnd) {
    end = parsedEnd.zdt
  } else if (durationLine) {
    const duration = parseIcsDuration(durationLine.value)
    end = duration ? start.zdt.add(duration) : start.zdt
  } else {
    end = start.allDay ? start.zdt.add({ days: 1 }) : start.zdt
  }

  const rruleLine = first('RRULE')
  const rrule = rruleLine ? parseRRule(rruleLine.value, localTz) : null

  const exDates: Temporal.Instant[] = []
  for (const line of all('EXDATE')) {
    for (const value of line.value.split(',')) {
      const parsed = parseIcsDate({ ...line, value }, localTz)
      if (parsed) exDates.push(parsed.zdt.toInstant())
    }
  }

  const rDates: Temporal.ZonedDateTime[] = []
  for (const line of all('RDATE')) {
    if (line.params['VALUE'] === 'PERIOD') continue
    for (const value of line.value.split(',')) {
      const parsed = parseIcsDate({ ...line, value }, localTz)
      if (parsed) rDates.push(parsed.zdt)
    }
  }

  const recurrenceLine = first('RECURRENCE-ID')
  const recurrenceParsed = recurrenceLine ? parseIcsDate(recurrenceLine, localTz) : null

  const organizerLine = first('ORGANIZER')

  return {
    uid: first('UID')?.value.trim() || `${start.zdt.toInstant().toString()}-${first('SUMMARY')?.value ?? ''}`,
    title: unescapeText(first('SUMMARY')?.value ?? '').trim() || '(no title)',
    allDay: start.allDay,
    start: start.zdt,
    end,
    location: unescapeText(first('LOCATION')?.value ?? '').trim(),
    description: unescapeText(first('DESCRIPTION')?.value ?? '').trim(),
    organizer: organizerLine ? personName(organizerLine) : '',
    attendees: all('ATTENDEE').map(personName).filter(Boolean),
    url: first('URL')?.value.trim() ?? '',
    rrule,
    exDates,
    rDates,
    recurrenceId: recurrenceParsed ? recurrenceParsed.zdt.toInstant() : null
  }
}
