import { describe, expect, it } from 'vitest'
import { fold, listed, matching, type Option } from '../src/combo.js'

const options: Option[] = [
  { value: 'a', label: 'Aussichtspunkt Schnackenburg', group: 'Ort' },
  { value: 'b', label: 'Grenzlandmuseum Schnackenburg', group: 'Ort' },
  { value: 'c', label: 'Alte Fähre', group: 'Ort' },
  { value: 'd', label: 'Feuerwehr Schnackenburg', group: 'Organisation' },
]

describe('the searchable dropdown', () => {
  it('folds case, accents, umlauts and ß', () => {
    expect(fold('Fähre Straße')).toBe('faehre strasse')
    expect(fold('Café')).toBe('cafe')
  })

  it('finds by every word of the query, in any order and anywhere in the label', () => {
    expect(matching(options, 'schnack').map((o) => o.value)).toEqual(['a', 'b', 'd'])
    expect(matching(options, 'schnack museum').map((o) => o.value)).toEqual(['b'])
    expect(matching(options, 'faehre').map((o) => o.value)).toEqual(['c'])
    expect(matching(options, 'fahre')).toEqual([])
    expect(matching(options, '  ').map((o) => o.value)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('puts those that begin with the query first', () => {
    expect(matching(options, 'a').map((o) => o.value)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('lists the matches under the headings of their groups, with a number for the keys', () => {
    const rows = listed(options, 'schnack')
    expect(rows.map((r) => ('heading' in r ? r.heading : `${r.index}:${r.option.value}`))).toEqual(['Ort', '0:a', '1:b', 'Organisation', '2:d'])
    expect(listed(options.map((o) => ({ ...o, group: undefined })), '').every((r) => 'option' in r)).toBe(true)
  })
})
