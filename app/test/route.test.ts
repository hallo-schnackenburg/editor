import { describe, expect, it } from 'vitest'
import { formatRoute, parseRoute, sameStep, type Route } from '../src/route.js'

const roundtrip = (route: Route) => expect(parseRoute(formatRoute(route))).toEqual(route)

describe('the address', () => {
  it('is none without a hash, and the database with "#/"', () => {
    expect(parseRoute('')).toBeUndefined()
    expect(parseRoute('#')).toBeUndefined()
    expect(parseRoute(undefined)).toBeUndefined()
    expect(parseRoute('#/')).toEqual({ view: 'none' })
  })

  it('says an entry, its form and a submission, and reads back what it wrote', () => {
    roundtrip({ view: 'none' })
    roundtrip({ view: 'entry', path: 'entities/people/sabrina-ulbrich.yaml' })
    roundtrip({ view: 'edit', path: 'objects/ae/01kb4z8m3q7xv2n5r6t9c0d1ae.yaml' })
    roundtrip({ view: 'yaml', path: 'entities/people/a.yaml' })
    roundtrip({ submission: 4, view: 'yaml', path: 'entities/people/a.yaml' })
    roundtrip({ submission: 4, view: 'details' })
    roundtrip({ submission: 4, view: 'details', focus: 'entities/people/a.yaml' })
    roundtrip({ submission: 4, view: 'entry', path: 'contents/ort/die-faehre.yaml' })
    roundtrip({ submission: 4, view: 'edit', path: 'contents/ort/die-faehre.yaml' })
    expect(formatRoute({ submission: 4, view: 'entry', path: 'entities/people/a.yaml' })).toBe('#/einreichung/4/e/entities/people/a.yaml')
    expect(formatRoute({ view: 'none' })).toBe('#/')
  })

  it('says where a new entry is made', () => {
    roundtrip({ view: 'new', context: { type: 'person', folder: '' } })
    roundtrip({ view: 'new', context: { type: 'place', folder: 'gummern', parent: 'gummern', kind: 'building' } })
    roundtrip({ submission: 7, view: 'new', context: { type: 'object', folder: '', group: '01kb4z8m3q7xv2n5r6t9c0d1gr' } })
    roundtrip({ view: 'new', context: { type: 'content', folder: '' } })
    expect(parseRoute('#/neu/nonsense')).toEqual({ view: 'new', context: { type: undefined, folder: '' } })
  })

  it('does not take what is not a path of an entry', () => {
    expect(parseRoute('#/e/../../secret.yaml')).toEqual({ view: 'none' })
    expect(parseRoute('#/e/entities/people/a.txt')).toEqual({ view: 'none' })
    expect(parseRoute('#/e/%zz')).toEqual({ view: 'none' })
    expect(parseRoute('#/einreichung/4/e/x')).toEqual({ submission: 4, view: 'details' })
    expect(parseRoute('#/einreichung/abc')).toEqual({ view: 'none' })
    expect(parseRoute('#/einreichung/4?markiert=../x.yaml')).toEqual({ submission: 4, view: 'details' })
  })

  it('knows what the app changes by itself', () => {
    expect(sameStep({ view: 'edit', path: 'a.yaml' }, { view: 'edit', path: 'b.yaml' })).toBe(true)
    expect(sameStep({ view: 'edit', path: 'a.yaml' }, { submission: 3, view: 'edit', path: 'a.yaml' })).toBe(true)
    expect(sameStep({ view: 'entry', path: 'a.yaml' }, { view: 'entry', path: 'b.yaml' })).toBe(false)
    expect(sameStep({ view: 'entry', path: 'a.yaml' }, { view: 'edit', path: 'a.yaml' })).toBe(false)
  })
})
