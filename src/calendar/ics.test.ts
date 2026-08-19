import { describe, expect, it } from 'vitest'
import { Temporal } from '../dates'
import { parseIcs, parseLine, toDisplayZone, unescapeText, unfold } from './ics'

const TZ = 'America/New_York'

/** Build a calendar body from lines; ICS is CRLF-delimited. */
function ics(...lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n')
}

function vevent(...lines: string[]): string {
  return ics('BEGIN:VEVENT', ...lines, 'END:VEVENT')
}

describe('unfold', () => {
  it('joins continuation lines that begin with a space', () => {
    const out = unfold('SUMMARY:Quarterly planning\r\n  with the platform team')
    expect(out).toEqual(['SUMMARY:Quarterly planning with the platform team'])
  })

  it('joins continuation lines that begin with a tab', () => {
    expect(unfold('SUMMARY:one\r\n\ttwo')).toEqual(['SUMMARY:onetwo'])
  })

  it('accepts bare LF as well as CRLF', () => {
    expect(unfold('A:1\nB:2')).toEqual(['A:1', 'B:2'])
  })
})

describe('parseLine', () => {
  it('splits name, params and value', () => {
    expect(parseLine('DTSTART;TZID=America/New_York:20260819T090000')).toEqual({
      name: 'DTSTART',
      params: { TZID: 'America/New_York' },
      value: '20260819T090000'
    })
  })

  it('does not split on a colon inside a quoted parameter', () => {
    const line = parseLine('ATTENDEE;CN="Talley, Jarrett";X-U="a:b":mailto:jt@example.com')
    expect(line?.params['CN']).toBe('Talley, Jarrett')
    expect(line?.params['X-U']).toBe('a:b')
    expect(line?.value).toBe('mailto:jt@example.com')
  })

  it('keeps colons in the value', () => {
    expect(parseLine('URL:https://example.com/a:b')?.value).toBe('https://example.com/a:b')
  })

  it('returns null for a line with no colon', () => {
    expect(parseLine('NOT A PROPERTY')).toBeNull()
  })
})

describe('unescapeText', () => {
  it('reverses RFC 5545 TEXT escaping', () => {
    expect(unescapeText('Standup\\, then review\\; notes\\nline two\\\\end')).toBe(
      'Standup, then review; notes\nline two\\end'
    )
  })
})

describe('toDisplayZone', () => {
  it('renders a meeting organised in another timezone on the reader’s clock', () => {
    // A Teams invite booked from London: 2:30 PM there is 9:30 AM in New York. Left
    // unconverted this is the bug where the agenda showed the organiser's wall clock.
    const [event] = parseIcs(
      vevent('UID:a', 'DTSTART;TZID=Europe/London:20260819T143000', 'DTEND;TZID=Europe/London:20260819T152000'),
      TZ
    )
    expect(event.start.timeZoneId).toBe('Europe/London')
    expect(event.start.toPlainTime().toString()).toBe('14:30:00')

    const shown = toDisplayZone(event.start, event.allDay, TZ)
    expect(shown.toPlainTime().toString()).toBe('09:30:00')
    // Converting must not move the event in absolute time.
    expect(shown.epochMilliseconds).toBe(event.start.epochMilliseconds)
  })

  it('leaves an all-day event on its own date', () => {
    const [event] = parseIcs(vevent('UID:a', 'DTSTART;VALUE=DATE:20260819'), TZ)
    const shown = toDisplayZone(event.start, event.allDay, 'Asia/Tokyo')
    expect(shown.toPlainDate().toString()).toBe('2026-08-19')
  })

  it('is a no-op when the event is already in the display zone', () => {
    const [event] = parseIcs(vevent('UID:a', 'DTSTART;TZID=America/New_York:20260819T093000'), TZ)
    expect(toDisplayZone(event.start, false, TZ).toPlainTime().toString()).toBe('09:30:00')
  })
})

describe('parseIcs', () => {
  it('reads a folded summary in full', () => {
    const [event] = parseIcs(
      vevent(
        'UID:a@example.com',
        'DTSTART;TZID=America/New_York:20260819T090000',
        'DTEND;TZID=America/New_York:20260819T100000',
        'SUMMARY:Quarterly planning with the platform',
        '  team and design'
      ),
      TZ
    )
    expect(event.title).toBe('Quarterly planning with the platform team and design')
  })

  it('resolves a TZID start to the right instant', () => {
    const [event] = parseIcs(
      vevent('UID:a', 'DTSTART;TZID=America/New_York:20260819T090000', 'DTEND;TZID=America/New_York:20260819T100000'),
      TZ
    )
    // 09:00 in New York on 19 Aug is 13:00Z (EDT, UTC-4).
    expect(event.start.toInstant().toString()).toBe('2026-08-19T13:00:00Z')
    expect(event.allDay).toBe(false)
  })

  it('resolves a UTC start', () => {
    const [event] = parseIcs(vevent('UID:a', 'DTSTART:20260819T130000Z', 'DTEND:20260819T140000Z'), TZ)
    expect(event.start.toInstant().toString()).toBe('2026-08-19T13:00:00Z')
  })

  it('maps a Windows timezone name to its IANA zone', () => {
    const [event] = parseIcs(
      vevent(
        'UID:a',
        'DTSTART;TZID=Eastern Standard Time:20260819T090000',
        'DTEND;TZID=Eastern Standard Time:20260819T100000'
      ),
      TZ
    )
    expect(event.start.toInstant().toString()).toBe('2026-08-19T13:00:00Z')
  })

  it('falls back to the local zone for an unknown TZID', () => {
    const [event] = parseIcs(vevent('UID:a', 'DTSTART;TZID=Middle Earth/Shire:20260819T090000'), TZ)
    expect(event.start.timeZoneId).toBe(TZ)
  })

  it('treats VALUE=DATE as all-day and defaults the end to the next midnight', () => {
    const [event] = parseIcs(vevent('UID:a', 'DTSTART;VALUE=DATE:20260819', 'SUMMARY:Company holiday'), TZ)
    expect(event.allDay).toBe(true)
    expect(event.start.toPlainDate().toString()).toBe('2026-08-19')
    expect(event.end.toPlainDate().toString()).toBe('2026-08-20')
  })

  it('uses DURATION when there is no DTEND', () => {
    const [event] = parseIcs(vevent('UID:a', 'DTSTART:20260819T130000Z', 'DURATION:PT90M'), TZ)
    expect(event.end.toInstant().toString()).toBe('2026-08-19T14:30:00Z')
  })

  it('drops cancelled events', () => {
    expect(parseIcs(vevent('UID:a', 'DTSTART:20260819T130000Z', 'STATUS:CANCELLED'), TZ)).toEqual([])
  })

  it('drops events with no usable DTSTART', () => {
    expect(parseIcs(vevent('UID:a', 'SUMMARY:No date'), TZ)).toEqual([])
  })

  it('reads attendee display names and falls back to the address', () => {
    const [event] = parseIcs(
      vevent(
        'UID:a',
        'DTSTART:20260819T130000Z',
        'ORGANIZER;CN=Dana Ruiz:mailto:dana@example.com',
        'ATTENDEE;CN=Jarrett Talley:mailto:jt@example.com',
        'ATTENDEE:mailto:sam@example.com'
      ),
      TZ
    )
    expect(event.organizer).toBe('Dana Ruiz')
    expect(event.attendees).toEqual(['Jarrett Talley', 'sam@example.com'])
  })

  it('does not let a nested VALARM leak its properties into the event', () => {
    const [event] = parseIcs(
      vevent(
        'UID:a',
        'DTSTART:20260819T130000Z',
        'SUMMARY:Real title',
        'BEGIN:VALARM',
        'TRIGGER:-PT10M',
        'SUMMARY:Reminder title',
        'END:VALARM'
      ),
      TZ
    )
    expect(event.title).toBe('Real title')
  })

  it('parses two events in one calendar', () => {
    const events = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'UID:a',
        'DTSTART:20260819T130000Z',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:b',
        'DTSTART:20260820T130000Z',
        'END:VEVENT'
      ),
      TZ
    )
    expect(events.map((e) => e.uid)).toEqual(['a', 'b'])
  })

  it('parses RRULE, EXDATE and RECURRENCE-ID', () => {
    const events = parseIcs(
      ics(
        'BEGIN:VEVENT',
        'UID:standup',
        'DTSTART;TZID=America/New_York:20260803T090000',
        'DTEND;TZID=America/New_York:20260803T091500',
        'RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR;COUNT=30',
        'EXDATE;TZID=America/New_York:20260807T090000',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:standup',
        'RECURRENCE-ID;TZID=America/New_York:20260810T090000',
        'DTSTART;TZID=America/New_York:20260810T110000',
        'DTEND;TZID=America/New_York:20260810T111500',
        'END:VEVENT'
      ),
      TZ
    )

    const master = events[0]
    expect(master.rrule?.freq).toBe('WEEKLY')
    expect(master.rrule?.count).toBe(30)
    expect(master.rrule?.byDay.map((b) => b.day)).toEqual(['MO', 'WE', 'FR'])
    expect(master.rrule?.unsupported).toBe(false)
    expect(master.exDates).toHaveLength(1)

    const override = events[1]
    expect(override.recurrenceId?.epochMilliseconds).toBe(
      Temporal.PlainDateTime.from('2026-08-10T09:00:00').toZonedDateTime(TZ).epochMilliseconds
    )
    expect(override.start.toPlainTime().toString()).toBe('11:00:00')
  })

  it('flags a rule using BYSETPOS as unsupported', () => {
    const [event] = parseIcs(vevent('UID:a', 'DTSTART:20260819T130000Z', 'RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1'), TZ)
    expect(event.rrule?.unsupported).toBe(true)
  })

  it('parses a comma-separated EXDATE list', () => {
    const [event] = parseIcs(
      vevent('UID:a', 'DTSTART:20260819T130000Z', 'RRULE:FREQ=DAILY', 'EXDATE:20260820T130000Z,20260821T130000Z'),
      TZ
    )
    expect(event.exDates).toHaveLength(2)
  })
})
