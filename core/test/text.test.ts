import { describe, expect, it } from 'vitest'
import { checkText, resolveText, servingRole, unserved } from '../src/text.js'
import { example } from './fixtures.js'

describe('serving a role', () => {
  const texts = example('osterfeuer-tradition').text

  it('uses the text written for the role', () => expect(resolveText(texts, 'teaser')?.role).toBe('teaser'))

  it('falls back along the chain, and only to a text that fits', () => {
    expect(servingRole({ summary: 'x'.repeat(150) }, 'teaser')).toBe('summary') // the summary is short enough for a teaser
    expect(servingRole({ summary: 'x'.repeat(250) }, 'teaser')).toBeUndefined() // too long for 200 characters: nothing fits, never cut
  })

  it('does not loop where the chains point at each other', () => {
    expect(servingRole({ body: 'Text' }, 'teaser')).toBeUndefined()
    expect(servingRole({ teaser: 'T' }, 'summary')).toBe('teaser')
    expect(servingRole({ summary: 'S' }, 'teaser')).toBe('summary')
  })

})

describe('unserved roles', () => {
  it('are what the editor has to point out', () => {
    expect(unserved({ body: 'x' })).toEqual(['teaser', 'summary'])
    expect(unserved(example('osterfeuer-tradition').text)).toEqual([])
  })
})

describe('checkText', () => {
  it('reports a text over the limit of its role', () => {
    expect(checkText({ teaser: 'x'.repeat(201), body: 'x'.repeat(5000) })).toEqual([{ path: '/text/teaser', message: '201 characters; at most 200' }])
    expect(checkText(example('osterfeuer-tradition').text)).toEqual([])
  })
})
