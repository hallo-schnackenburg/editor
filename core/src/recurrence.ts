// When an event takes place: the dates that are listed, and the dates a rule gives. The rule is an RRULE as in RFC 5545 with two
// additions for feasts that move: BYEASTER=n (n days after Easter Sunday, negative before) and BYADVENT=n (the same from the first Advent).
// Times are local times (no time zone); a date without a time is a whole day.

import * as rrulePackage from 'rrule'

// Node takes the CommonJS build of the library (everything below `default`), a bundler the ES build (named exports).
const RRule: typeof rrulePackage.RRule = rrulePackage.RRule ?? (Reflect.get(rrulePackage, 'default') as typeof rrulePackage).RRule
import type { Issue } from './types.js'

export interface EventDate {
  start: string
  end?: string
  note?: string
  cancelled?: boolean
}

export interface Rule {
  rrule: string
  start: string
}

/** One date of the calendar of an event. */
export interface Occurrence {
  start: string
  end?: string
  note?: string
  source: 'rule' | 'date'
}

const WHEN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/
const DAY = 86_400_000

/** A date or a date with the time as a point in time (the time of the day is kept as it is, without a time zone). */
function parseWhen(text: string): Date | undefined {
  const m = WHEN.exec(text)
  if (!m) return undefined
  const date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0))
  // 2026-02-30 is no date.
  return date.getUTCFullYear() === +m[1] && date.getUTCMonth() === +m[2] - 1 && date.getUTCDate() === +m[3] && (!m[4] || (+m[4] < 24 && +m[5] < 60)) ? date : undefined
}

/** Whether a text is a date (2026-04-04) or a date with the time (2026-04-04T19:00). */
export const isWhen = (text: unknown): text is string => typeof text === 'string' && parseWhen(text) !== undefined

const two = (n: number) => String(n).padStart(2, '0')
const dayOf = (d: Date) => `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`
const whenOf = (d: Date, withTime: boolean) => (withTime ? `${dayOf(d)}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` : dayOf(d))
const withTime = (text: string) => text.includes('T')

/** The first Advent of a year: the fourth Sunday before Christmas Day (the Sunday before it if Christmas is a Sunday itself). */
export function firstAdvent(year: number): Date {
  const christmas = new Date(Date.UTC(year, 11, 25))
  const weekday = christmas.getUTCDay()
  return new Date(christmas.getTime() - ((weekday === 0 ? 7 : weekday) + 21) * DAY)
}

type Parts = Map<string, string>

function partsOf(rrule: string): Parts | undefined {
  const parts: Parts = new Map()
  for (const part of rrule.trim().replace(/^RRULE:/i, '').split(';')) {
    if (!part) continue
    const at = part.indexOf('=')
    if (at < 1) return undefined
    parts.set(part.slice(0, at).toUpperCase(), part.slice(at + 1))
  }
  return parts
}

/** What goes together with an anchor (Easter, Advent): the rest of the rule may only say how often and until when. */
const WITH_ANCHOR = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYEASTER', 'BYADVENT'])

function offsetsOf(value: string | undefined): number[] | undefined {
  const list = (value ?? '').split(',').map((x) => (/^-?\d{1,3}$/.test(x.trim()) ? Number(x) : NaN))
  return list.length > 0 && list.every((n) => Number.isInteger(n)) ? list : undefined
}

/** What is wrong with a rule, in a short sentence; nothing if it is right. */
export function ruleProblem(rule: Rule): string | undefined {
  if (typeof rule?.start !== 'string' || !parseWhen(rule.start)) return 'the start of the rule is no date'
  if (typeof rule.rrule !== 'string') return 'the rule is not an RRULE'
  const parts = partsOf(rule.rrule)
  if (!parts || parts.size === 0) return 'the rule is not an RRULE'
  if (!parts.has('FREQ')) return 'the rule needs FREQ (DAILY, WEEKLY, MONTHLY or YEARLY)'
  const anchored = parts.has('BYEASTER') || parts.has('BYADVENT')
  if (anchored) {
    if (parts.has('BYEASTER') && parts.has('BYADVENT')) return 'BYEASTER and BYADVENT cannot be used together'
    const key = parts.has('BYEASTER') ? 'BYEASTER' : 'BYADVENT'
    if (!offsetsOf(parts.get(key))) return `${key} needs numbers of days (BYEASTER=-1)`
    if (parts.get('FREQ')?.toUpperCase() !== 'YEARLY') return `${key} goes with FREQ=YEARLY`
    for (const name of parts.keys()) if (!WITH_ANCHOR.has(name)) return `${key} cannot be combined with ${name}`
  }
  if (parts.has('BYADVENT')) {
    // The library does not know this part: how often and until when is checked here.
    if (parts.has('INTERVAL') && !/^[1-9]\d{0,2}$/.test(parts.get('INTERVAL')!)) return 'INTERVAL needs a number'
    if (parts.has('COUNT') && !/^[1-9]\d{0,3}$/.test(parts.get('COUNT')!)) return 'COUNT needs a number'
    if (parts.has('UNTIL') && !untilOf(parts.get('UNTIL'))) return 'UNTIL needs a date (20301231)'
    return undefined
  }
  try {
    const options = RRule.parseString(rule.rrule.trim().replace(/^RRULE:/i, ''))
    const rr = new RRule({ ...options, dtstart: parseWhen(rule.start)! })
    rr.after(parseWhen(rule.start)!, true)
  } catch (error) {
    return `the rule is not valid (${(error as Error).message})`
  }
  return undefined
}

/** The dates of a rule between two days (inclusive), as points in time. */
function ruleDates(rule: Rule, from: Date, to: Date): Date[] {
  const start = parseWhen(rule.start)!
  const parts = partsOf(rule.rrule)!
  if (!parts.has('BYADVENT')) {
    const options = RRule.parseString(rule.rrule.trim().replace(/^RRULE:/i, ''))
    return new RRule({ ...options, dtstart: start }).between(from, new Date(to.getTime() + DAY - 1), true)
  }
  // The first Advent is no rule of the standard: the dates are made year by year.
  const offsets = offsetsOf(parts.get('BYADVENT'))!
  const interval = Math.max(1, Number(parts.get('INTERVAL') ?? 1) || 1)
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : Infinity
  const until = untilOf(parts.get('UNTIL'))
  const found: Date[] = []
  const time = start.getTime() % DAY
  for (let year = start.getUTCFullYear(); year <= to.getUTCFullYear() + 1 && found.length < count; year++) {
    if ((year - start.getUTCFullYear()) % interval !== 0) continue
    const days = offsets.map((n) => new Date(firstAdvent(year).getTime() + n * DAY + time)).sort((a, b) => a.getTime() - b.getTime())
    for (const day of days) {
      if (day < start) continue
      if (until && day > until) return inRange(found, from, to)
      if (found.length < count) found.push(day)
    }
  }
  return inRange(found, from, to)
}

const inRange = (dates: Date[], from: Date, to: Date) => dates.filter((d) => d >= from && d.getTime() < to.getTime() + DAY)

function untilOf(text: string | undefined): Date | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(text ?? '')
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 23, m[5] ? +m[5] : 59)) : undefined
}

/**
 * The dates of an event between two days (inclusive), earliest first: those of the rule, with the listed ones added. A listed date that is
 * cancelled takes that day out of the rule; a listed date on a day of the rule replaces it (so it can have another time or a note).
 */
export function occurrences(event: { rule?: Rule; dates?: EventDate[] }, from: string, to: string): Occurrence[] {
  const first = parseWhen(from)
  const last = parseWhen(to)
  if (!first || !last) return []
  const listed = (event.dates ?? []).filter((d) => parseWhen(d.start))
  const taken = new Set(listed.map((d) => d.start.slice(0, 10)))
  const out: Occurrence[] = []
  if (event.rule && !ruleProblem(event.rule)) {
    const timed = withTime(event.rule.start)
    for (const date of ruleDates(event.rule, first, last)) if (!taken.has(dayOf(date))) out.push({ start: whenOf(date, timed), source: 'rule' })
  }
  for (const d of listed) {
    const day = parseWhen(d.start.slice(0, 10))!
    if (d.cancelled || day < first || day > last) continue
    out.push({ start: d.start, ...(d.end ? { end: d.end } : {}), ...(d.note ? { note: d.note } : {}), source: 'date' })
  }
  return out.sort((a, b) => a.start.localeCompare(b.start))
}

/** What an event needs: a one-off event has a date; the dates and the rule must make sense (a rule of an event that is not recurring is not looked at). */
export function checkEvent(entry: unknown): Issue[] {
  if (typeof entry !== 'object' || entry === null) return []
  const e = entry as { type?: unknown; recurring?: unknown; schedule?: unknown; rule?: unknown; dates?: unknown }
  if (e.type !== 'event') return []
  const issues: Issue[] = []
  const recurring = e.recurring === true
  const dates = Array.isArray(e.dates) ? (e.dates as EventDate[]) : []
  if (!recurring && dates.filter((d) => !d?.cancelled).length === 0) issues.push({ path: '/dates', message: 'a one-off event needs a date', warning: true })
  dates.forEach((d, i) => {
    if (typeof d?.start !== 'string' || !parseWhen(d.start)) issues.push({ path: `/dates/${i}/start`, message: 'not a date' })
    else if (d.end !== undefined && (typeof d.end !== 'string' || !parseWhen(d.end))) issues.push({ path: `/dates/${i}/end`, message: 'not a date' })
    else if (d.end !== undefined && d.end < d.start) issues.push({ path: `/dates/${i}/end`, message: 'the end is before the start' })
  })
  if (recurring && typeof e.rule === 'object' && e.rule !== null) {
    const rule = e.rule as Partial<Rule>
    if (typeof rule.rrule === 'string' && typeof rule.start === 'string') {
      const problem = ruleProblem({ rrule: rule.rrule, start: rule.start })
      if (problem) issues.push({ path: '/rule', message: problem })
    }
  }
  return issues
}
