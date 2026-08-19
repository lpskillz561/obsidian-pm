import { describe, expect, it } from 'vitest'
import { Temporal } from '../dates'
import { parseIcs } from './ics'
import { expandOccurrences } from './rrule'
import type { ParsedEvent } from './types'

const TZ = 'America/New_York'

function parseOne(...lines: string[]): ParsedEvent {
  const text = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  return parseIcs(text, TZ)[0]
}

function instant(local: string): Temporal.Instant {
  return Temporal.PlainDateTime.from(local).toZonedDateTime(TZ).toInstant()
}

/** Occurrence dates as YYYY-MM-DD, which is what these assertions are actually about. */
function days(event: ParsedEvent, from: string, to: string): string[] {
  return expandOccurrences(event, instant(from), instant(to)).map((z) => z.toPlainDate().toString())
}

// 2026-08-03 is a Monday.
const STANDUP = [
  'UID:standup',
  'DTSTART;TZID=America/New_York:20260803T090000',
  'DTEND;TZID=America/New_York:20260803T091500'
]

describe('expandOccurrences', () => {
  it('returns a single start for a non-recurring event inside the window', () => {
    const event = parseOne(...STANDUP)
    expect(days(event, '2026-08-01T00:00', '2026-08-15T00:00')).toEqual(['2026-08-03'])
  })

  it('returns nothing for an event outside the window', () => {
    const event = parseOne(...STANDUP)
    expect(days(event, '2026-09-01T00:00', '2026-09-02T00:00')).toEqual([])
  })

  it('includes an event that began before the window but is still running', () => {
    const event = parseOne(
      'UID:allhands',
      'DTSTART;TZID=America/New_York:20260803T090000',
      'DTEND;TZID=America/New_York:20260803T170000'
    )
    expect(days(event, '2026-08-03T12:00', '2026-08-03T13:00')).toEqual(['2026-08-03'])
  })

  it('expands a weekly BYDAY series', () => {
    const event = parseOne(...STANDUP, 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR')
    expect(days(event, '2026-08-01T00:00', '2026-08-15T00:00')).toEqual([
      '2026-08-03',
      '2026-08-05',
      '2026-08-07',
      '2026-08-10',
      '2026-08-12',
      '2026-08-14'
    ])
  })

  it('removes an EXDATE occurrence', () => {
    const event = parseOne(
      ...STANDUP,
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
      'EXDATE;TZID=America/New_York:20260807T090000'
    )
    expect(days(event, '2026-08-01T00:00', '2026-08-15T00:00')).toEqual([
      '2026-08-03',
      '2026-08-05',
      '2026-08-10',
      '2026-08-12',
      '2026-08-14'
    ])
  })

  it('honours COUNT', () => {
    const event = parseOne(...STANDUP, 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=3')
    expect(days(event, '2026-08-01T00:00', '2026-08-31T00:00')).toEqual(['2026-08-03', '2026-08-05', '2026-08-07'])
  })

  it('honours UNTIL', () => {
    const event = parseOne(...STANDUP, 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260806T235959Z')
    expect(days(event, '2026-08-01T00:00', '2026-08-31T00:00')).toEqual(['2026-08-03', '2026-08-05'])
  })

  it('honours INTERVAL on a weekly rule', () => {
    const event = parseOne(...STANDUP, 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')
    expect(days(event, '2026-08-01T00:00', '2026-09-05T00:00')).toEqual(['2026-08-03', '2026-08-17', '2026-08-31'])
  })

  it('does not emit dates earlier in the first week than DTSTART', () => {
    // DTSTART is a Wednesday but the rule also selects Monday; the Monday before
    // the series began is not an occurrence.
    const event = parseOne('UID:x', 'DTSTART;TZID=America/New_York:20260805T090000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE')
    expect(days(event, '2026-08-01T00:00', '2026-08-13T00:00')).toEqual(['2026-08-05', '2026-08-10', '2026-08-12'])
  })

  it('expands a daily rule', () => {
    const event = parseOne('UID:x', 'DTSTART;TZID=America/New_York:20260819T090000', 'RRULE:FREQ=DAILY')
    expect(days(event, '2026-08-19T00:00', '2026-08-22T00:00')).toEqual(['2026-08-19', '2026-08-20', '2026-08-21'])
  })

  it('expands a monthly rule on the same day of month', () => {
    const event = parseOne('UID:x', 'DTSTART;TZID=America/New_York:20260815T090000', 'RRULE:FREQ=MONTHLY')
    expect(days(event, '2026-08-01T00:00', '2026-11-01T00:00')).toEqual(['2026-08-15', '2026-09-15', '2026-10-15'])
  })

  it('expands a monthly rule with an ordinal BYDAY', () => {
    const event = parseOne('UID:x', 'DTSTART;TZID=America/New_York:20260828T160000', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR')
    expect(days(event, '2026-08-01T00:00', '2026-11-01T00:00')).toEqual(['2026-08-28', '2026-09-25', '2026-10-30'])
  })

  it('skips months that are too short for the BYMONTHDAY', () => {
    const event = parseOne('UID:x', 'DTSTART;TZID=America/New_York:20260131T090000', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=31')
    expect(days(event, '2026-01-01T00:00', '2026-05-01T00:00')).toEqual(['2026-01-31', '2026-03-31'])
  })

  it('expands a yearly rule', () => {
    const event = parseOne('UID:x', 'DTSTART;VALUE=DATE:20260419', 'RRULE:FREQ=YEARLY')
    expect(days(event, '2026-01-01T00:00', '2029-01-01T00:00')).toEqual(['2026-04-19', '2027-04-19', '2028-04-19'])
  })

  it('adds RDATE occurrences', () => {
    const event = parseOne(...STANDUP, 'RDATE;TZID=America/New_York:20260806T090000')
    expect(days(event, '2026-08-01T00:00', '2026-08-15T00:00')).toEqual(['2026-08-03', '2026-08-06'])
  })

  it('treats a rule with unsupported parts as a single event rather than guessing', () => {
    const event = parseOne(...STANDUP, 'RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1')
    expect(days(event, '2026-08-01T00:00', '2026-12-01T00:00')).toEqual(['2026-08-03'])
  })

  it('keeps the local wall-clock time across a DST transition', () => {
    // US DST ends 2026-11-01; a 09:00 series stays at 09:00 local either side of it.
    const event = parseOne('UID:x', 'DTSTART;TZID=America/New_York:20261026T090000', 'RRULE:FREQ=WEEKLY;BYDAY=MO')
    const starts = expandOccurrences(event, instant('2026-10-26T00:00'), instant('2026-11-10T00:00'))
    expect(starts.map((s) => s.toPlainTime().toString())).toEqual(['09:00:00', '09:00:00', '09:00:00'])
    expect(starts.map((s) => s.offset)).toEqual(['-04:00', '-05:00', '-05:00'])
  })
})
