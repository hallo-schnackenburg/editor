import { describe, expect, it } from 'vitest'
import { checkEvent, firstAdvent, occurrences, ruleProblem } from '../src/recurrence.js'

const days = (event: Parameters<typeof occurrences>[0], from: string, to: string) => occurrences(event, from, to).map((o) => o.start)

describe('the first Advent', () => {
  it('is the fourth Sunday before Christmas', () => {
    const day = (year: number) => firstAdvent(year).toISOString().slice(0, 10)
    expect([2024, 2025, 2026, 2027].map(day)).toEqual(['2024-12-01', '2025-11-30', '2026-11-29', '2027-11-28'])
    // Christmas on a Sunday (2022): the Sunday before it is the fourth Advent.
    expect(day(2022)).toBe('2022-11-27')
  })
})

describe('the dates of a rule', () => {
  it('follows the standard: a fixed day, the last Saturday of a month, every second week', () => {
    expect(days({ rule: { rrule: 'FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=30', start: '2020-04-30' } }, '2025-01-01', '2027-12-31')).toEqual(['2025-04-30', '2026-04-30', '2027-04-30'])
    expect(days({ rule: { rrule: 'FREQ=MONTHLY;BYDAY=-1SA', start: '2026-01-01' } }, '2026-01-01', '2026-03-31')).toEqual(['2026-01-31', '2026-02-28', '2026-03-28'])
    expect(days({ rule: { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=3', start: '2026-01-06' } }, '2026-01-01', '2026-12-31')).toEqual(['2026-01-06', '2026-01-20', '2026-02-03'])
    expect(days({ rule: { rrule: 'FREQ=YEARLY;BYMONTH=6;BYDAY=2SA;UNTIL=20270101', start: '2025-06-01' } }, '2025-01-01', '2030-12-31')).toEqual(['2025-06-14', '2026-06-13'])
  })

  it('keeps the time of the start', () => {
    expect(days({ rule: { rrule: 'FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=30', start: '2020-04-30T19:00' } }, '2026-01-01', '2026-12-31')).toEqual(['2026-04-30T19:00'])
  })

  it('counts days from Easter Sunday: the Saturday before it, Ascension Day, Whitsun and two weeks after', () => {
    const osterfeuer = { rule: { rrule: 'FREQ=YEARLY;BYEASTER=-1', start: '2020-01-01' } }
    expect(days(osterfeuer, '2025-01-01', '2027-12-31')).toEqual(['2025-04-19', '2026-04-04', '2027-03-27'])
    expect(days({ rule: { rrule: 'FREQ=YEARLY;BYEASTER=39', start: '2020-01-01' } }, '2026-01-01', '2026-12-31')).toEqual(['2026-05-14'])
    expect(days({ rule: { rrule: 'FREQ=YEARLY;BYEASTER=63', start: '2020-01-01' } }, '2026-01-01', '2026-12-31')).toEqual(['2026-06-07'])
  })

  it('counts days from the first Advent: the Saturday before it (the Lichterfest), more than one day, interval and end', () => {
    const lichterfest = { rule: { rrule: 'FREQ=YEARLY;BYADVENT=-1', start: '2020-01-01' } }
    expect(days(lichterfest, '2024-01-01', '2026-12-31')).toEqual(['2024-11-30', '2025-11-29', '2026-11-28'])
    expect(days({ rule: { rrule: 'FREQ=YEARLY;BYADVENT=-7,-1', start: '2020-01-01' } }, '2025-01-01', '2025-12-31')).toEqual(['2025-11-23', '2025-11-29'])
    expect(days({ rule: { rrule: 'FREQ=YEARLY;INTERVAL=2;BYADVENT=-1', start: '2024-01-01' } }, '2024-01-01', '2029-12-31')).toEqual(['2024-11-30', '2026-11-28', '2028-12-02'])
    expect(days({ rule: { rrule: 'FREQ=YEARLY;BYADVENT=-1;COUNT=2', start: '2024-01-01' } }, '2024-01-01', '2029-12-31')).toEqual(['2024-11-30', '2025-11-29'])
    expect(days({ rule: { rrule: 'FREQ=YEARLY;BYADVENT=-1;UNTIL=20251231', start: '2024-01-01T18:00' } }, '2024-01-01', '2029-12-31')).toEqual(['2024-11-30T18:00', '2025-11-29T18:00'])
  })

  it('does not give dates before its start', () => {
    expect(days({ rule: { rrule: 'FREQ=YEARLY;BYADVENT=-1', start: '2025-12-01' } }, '2025-01-01', '2026-12-31')).toEqual(['2026-11-28'])
  })
})

describe('the dates of an event', () => {
  const lichterfest = { rule: { rrule: 'FREQ=YEARLY;BYADVENT=-1', start: '2024-01-01' }, dates: [] as { start: string; end?: string; note?: string; cancelled?: boolean }[] }

  it('adds the listed ones to those of the rule, earliest first', () => {
    const event = { ...lichterfest, dates: [{ start: '2025-12-20', note: 'Nachholtermin' }] }
    expect(occurrences(event, '2025-01-01', '2025-12-31')).toEqual([
      { start: '2025-11-29', source: 'rule' },
      { start: '2025-12-20', note: 'Nachholtermin', source: 'date' },
    ])
  })

  it('takes a cancelled day out of the rule, and lets a listed one replace the day of the rule', () => {
    expect(days({ ...lichterfest, dates: [{ start: '2025-11-29', cancelled: true }] }, '2025-01-01', '2025-12-31')).toEqual([])
    const moved = occurrences({ ...lichterfest, dates: [{ start: '2025-11-29T17:00', end: '2025-11-29T21:00' }] }, '2025-01-01', '2025-12-31')
    expect(moved).toEqual([{ start: '2025-11-29T17:00', end: '2025-11-29T21:00', source: 'date' }])
  })

  it('works for an event with dates only', () => {
    const event = { dates: [{ start: '2026-07-10', end: '2026-07-12' }, { start: '2025-07-11' }] }
    expect(days(event, '2026-01-01', '2026-12-31')).toEqual(['2026-07-10'])
    expect(days(event, '2025-01-01', '2026-12-31')).toEqual(['2025-07-11', '2026-07-10'])
  })
})

describe('what is wrong with a rule', () => {
  const problem = (rrule: string, start = '2026-01-01') => ruleProblem({ rrule, start })

  it('accepts rules of the standard and of the anchors', () => {
    for (const rrule of ['FREQ=DAILY', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'FREQ=MONTHLY;BYMONTHDAY=1;COUNT=5', 'FREQ=YEARLY;BYEASTER=-2', 'FREQ=YEARLY;BYADVENT=-1;INTERVAL=2;UNTIL=20301231']) expect(problem(rrule)).toBeUndefined()
  })

  it('names what is not right', () => {
    expect(problem('FREQ=YEARLY', 'bald')).toContain('start')
    expect(problem('')).toContain('not an RRULE')
    expect(problem('BYDAY=MO')).toContain('FREQ')
    expect(problem('FREQ=SOMETIMES')).toContain('not valid')
    expect(problem('FOO=1;FREQ=DAILY')).toContain('not valid')
    expect(problem('FREQ=MONTHLY;BYEASTER=-1')).toContain('FREQ=YEARLY')
    expect(problem('FREQ=YEARLY;BYEASTER=-1;BYMONTH=4')).toContain('cannot be combined with BYMONTH')
    expect(problem('FREQ=YEARLY;BYEASTER=-1;BYADVENT=-1')).toContain('together')
    expect(problem('FREQ=YEARLY;BYADVENT=x')).toContain('numbers of days')
  })
})

describe('checking an event', () => {
  const event = (fields: object) => ({ id: 'osterfeuer', type: 'event', name: 'Osterfeuer', ...fields })

  it('wants a date for a one-off event, and none for a recurring one', () => {
    expect(checkEvent(event({}))).toEqual([{ path: '/dates', message: 'a one-off event needs a date', warning: true }])
    expect(checkEvent(event({ dates: [{ start: '2026-07-10', cancelled: true }] }))).toHaveLength(1)
    expect(checkEvent(event({ dates: [{ start: '2026-07-10' }] }))).toEqual([])
    expect(checkEvent(event({ recurring: true }))).toEqual([])
  })

  it('does not look at a rule or a schedule when the event is not recurring', () => {
    const rule = { rrule: 'FREQ=YEARLY;BYEASTER=-1;BYMONTH=4', start: '2020-01-01' }
    expect(checkEvent(event({ dates: [{ start: '2026-04-04' }], rule, schedule: 'jährlich' }))).toEqual([])
    expect(checkEvent(event({ recurring: true, rule: { rrule: 'FREQ=YEARLY;BYEASTER=-1', start: '2020-01-01' }, schedule: 'jährlich' }))).toEqual([])
  })

  it('checks the dates and the rule', () => {
    expect(checkEvent(event({ recurring: true, dates: [{ start: '2026-02-30' }] }))).toEqual([{ path: '/dates/0/start', message: 'not a date' }])
    expect(checkEvent(event({ recurring: true, dates: [{ start: '2026-07-10', end: '2026-07-09' }] }))).toEqual([{ path: '/dates/0/end', message: 'the end is before the start' }])
    expect(checkEvent(event({ recurring: true, rule: { rrule: 'FREQ=YEARLY;BYEASTER=-1;BYMONTH=4', start: '2020-01-01' } }))[0].path).toBe('/rule')
  })

  it('leaves other entries alone', () => {
    expect(checkEvent({ id: 'x', type: 'place', name: 'X' })).toEqual([])
    expect(checkEvent(null)).toEqual([])
  })
})
