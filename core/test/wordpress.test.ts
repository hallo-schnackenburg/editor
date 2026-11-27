import { describe, expect, it } from 'vitest'
// @ts-expect-error the script is plain JavaScript
import { elementorToMarkdown, plan, toYaml } from '../scripts/import-wordpress.mjs'

const widget = (type: string, inner: string) => `<div class="elementor-element elementor-widget" data-widget_type="${type}.default"><div class="elementor-widget-container">${inner}</div></div>`

const page = [
  widget('icon-list', '<ul><li><a href="https://x.de">Start</a></li></ul>').replace('elementor-widget"', 'elementor-widget elementor-icon-list--layout-inline"'),
  widget('heading', '<h1 class="elementor-heading-title">Aussichtstürme</h1>'),
  widget('heading', '<h3 class="elementor-heading-title">Panorama</h3>'),
  widget('text-editor', '<p>Von oben sieht man <strong>weit</strong>.</p>'),
  widget('image', '<figure><img src="https://x.de/u/turm-1024x768.jpg" alt=""/><figcaption>Blick vom Turm</figcaption></figure>'),
  widget('image', '<img src="https://x.de/u/line.png"/>'),
  widget('spacer', '<div></div>'),
].join('\n')

const item = (over: object) => ({ id: 1, slug: 'turm', status: 'publish', date: '2025-01-14T10:00:00', title: { rendered: 'Aussichtst&uuml;rme' }, excerpt: { rendered: '' }, content: { rendered: page }, categories: [], tags: [], parent: 0, ...over })
const data = (posts: object[], pages: object[] = []) => ({ posts, pages, categories: [{ id: 24, slug: 'natur-erleben', name: 'Natur erleben' }], tags: [{ id: 5, slug: 'turm', name: 'Turm' }] })

describe('elementorToMarkdown', () => {
  it('takes headings, texts and pictures in their order, and nothing of the layout', () => {
    expect(elementorToMarkdown(page, 'Aussichtstürme')).toBe('### Panorama\n\nVon oben sieht man **weit**.\n\n![Blick vom Turm](https://x.de/u/turm.jpg)')
  })
})

describe('plan', () => {
  it('makes a content with the tags to find it again, and puts it in the folder of its category', () => {
    const { files } = plan(data([item({ categories: [24], tags: [5] })]))
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('natur/turm.yaml')
    expect(files[0].entry).toMatchObject({ id: 'turm', type: 'content', title: 'Aussichtstürme', published: '2025-01-14', tags: ['Turm', '_wp-1', '_import'] })
    expect(toYaml(files[0].entry)).toContain('body: |')
  })

  it('skips what was imported before', () => {
    const { files, left } = plan(data([item({})]), [{ path: 'natur/turm.yaml', text: 'tags: [_wp-1]' }])
    expect(files).toEqual([])
    expect(left[0].reason).toBe('already imported')
  })

  it('does not take the id of an entity or of another content', () => {
    const { files } = plan(data([item({ slug: 'kapern' }), item({ id: 2, slug: 'turm' })], [item({ id: 3, slug: 'turm', content: { rendered: widget('text-editor', `<p>${'Text. '.repeat(100)}</p>`) } })]), [], { entityIds: ['kapern'] })
    expect(files.map((f: { entry: { id: string } }) => f.entry.id)).toEqual(['kapern-text', 'turm', 'turm-seite'])
  })

  it('leaves out pages that only lay out or list other pages, but not posts', () => {
    const cards = ['a', 'b', 'c', 'd', 'e'].map((x) => widget('button', `<a href="https://schnackenburg.de/${x}/">Mehr ${x}</a>`)).join('')
    const { files, left } = plan(data([], [item({ id: 7, slug: 'natur-erleben', content: { rendered: cards + page } }), item({ id: 8, slug: 'startseite' })]))
    expect(files).toEqual([])
    expect(left.map((l: { id: number }) => l.id)).toEqual([7, 8])
  })

  it('takes no excerpt that WordPress cut out of the text', () => {
    const cut = item({ excerpt: { rendered: '<p>Von oben sieht man weit</p>' }, content: { rendered: widget('text-editor', '<p>Von oben sieht man weit und breit.</p>') } })
    expect(plan(data([cut])).files[0].entry.text.teaser).toBeUndefined()
    const own = item({ excerpt: { rendered: '<p>Ein Turm am Hafen.</p>' } })
    expect(plan(data([own])).files[0].entry.text.teaser).toBe('Ein Turm am Hafen.\n')
  })
})
