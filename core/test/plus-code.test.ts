import { describe, expect, it } from 'vitest'
import { decodePlusCode, findPlusCode } from '../src/index.js'

const SCHNACKENBURG = { lat: 53.037, lon: 11.568 }

describe('decodePlusCode', () => {
  it('decodes full codes (examples of the specification)', () => {
    const a = decodePlusCode('7FG49QCJ+2VX')!
    expect(a.lat).toBeCloseTo(20.3701125, 6)
    expect(a.lon).toBeCloseTo(2.782234375, 6)
    const b = decodePlusCode('8FVC9G8F+6W')!
    expect(b.lat).toBeCloseTo(47.3656, 3)
    expect(b.lon).toBeCloseTo(8.5248, 3)
  })

  it('does not care for case or spaces around', () => {
    expect(decodePlusCode(' 8fvc9g8f+6w ')).toEqual(decodePlusCode('8FVC9G8F+6W'))
  })

  it('completes short codes from the reference', () => {
    const zurich = decodePlusCode('9G8F+6W', { lat: 47.4, lon: 8.6 })!
    expect(zurich.lat).toBeCloseTo(47.3656, 3)
    expect(zurich.lon).toBeCloseTo(8.5248, 3)
  })

  it('puts a short code next to Schnackenburg', () => {
    const position = decodePlusCode('2HP8+RV', SCHNACKENBURG)!
    expect(Math.abs(position.lat - SCHNACKENBURG.lat)).toBeLessThan(0.05)
    expect(Math.abs(position.lon - SCHNACKENBURG.lon)).toBeLessThan(0.05)
  })

  it('takes the area nearest to the reference, also across a cell border', () => {
    const near = decodePlusCode('2222+22', { lat: 52.99, lon: 11.5 })
    expect(near).toBeDefined()
    const full = decodePlusCode('9F4M2HP8+RV')!
    const short = decodePlusCode('2HP8+RV', { lat: full.lat + 0.04, lon: full.lon - 0.04 })!
    expect(short.lat).toBeCloseTo(full.lat, 6)
    expect(short.lon).toBeCloseTo(full.lon, 6)
  })

  it('needs a reference for a short code, and refuses what is no code', () => {
    expect(decodePlusCode('2HP8+RV')).toBeUndefined()
    expect(decodePlusCode('Schnackenburg')).toBeUndefined()
    expect(decodePlusCode('2HP8+R')).toBeUndefined()
    expect(decodePlusCode('2HP8+RB', SCHNACKENBURG)).toBeUndefined()
    expect(decodePlusCode('', SCHNACKENBURG)).toBeUndefined()
  })
})

describe('findPlusCode', () => {
  it('finds the code in a text', () => {
    expect(findPlusCode('2HP8+RV Schnackenburg')).toBe('2HP8+RV')
    expect(findPlusCode('Der Turm: 9F4M2HP8+RV, bitte')).toBe('9F4M2HP8+RV')
  })

  it('finds nothing in other texts', () => {
    expect(findPlusCode('Aussichtsturm Schnackenburg')).toBeUndefined()
    expect(findPlusCode('1+1 ist 2')).toBeUndefined()
    expect(findPlusCode('C++ Kurs')).toBeUndefined()
  })
})
