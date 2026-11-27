// Turns the posts and pages of a WordPress site into contents (YAML files).
//
//   node scripts/import-wordpress.mjs <directory with the REST answers> <contents directory> [--skip=slug,slug] [--include=slug,slug]
//
// The directory holds what `/wp-json/wp/v2/<posts|pages|categories|tags>?per_page=100&page=N` answered, saved as
// `<name>-<N>.json`. Nothing is read from the site itself.
//
// - A post is a content. A page is one only if it has text of its own: pages that only lay out other contents (start page,
//   overviews with cards) are left out, and the report says which and why (`--include` takes one back, `--skip` drops one).
// - Elementor pages are built from widgets: only headings, texts, lists, buttons and images are taken, in their order.
//   Images stay as links to the original (`![caption](url)`) until the media are imported.
// - Every entry gets the internal tags `_wp-<id>` (an import that runs again skips what is there) and `_import` (to look at).
// - The topic folder follows the category (TOPICS below); folders are free to rearrange later.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'
import TurndownService from 'turndown'
import YAML from 'yaml'

/** WordPress category (or parent page) → topic folder and its name. Subject, not website section. */
export const TOPICS = {
  'natur-erleben': ['natur', 'Natur & Umwelt'],
  geschichte: ['geschichte', 'Geschichte'],
  historie: ['geschichte', 'Geschichte'],
  vereine: ['vereine', 'Vereine'],
  veranstaltungen: ['veranstaltungen', 'Veranstaltungen'],
  'kultur-veranstaltungen': ['veranstaltungen', 'Veranstaltungen'],
  kultur: ['kultur', 'Kultur'],
  'leben-im-gruenen': ['tourismus', 'Tourismus'],
  'lage-und-umgebung': ['umgebung', 'Umgebung'],
  'stadt-und-menschen': ['ort', 'Ort und Menschen'],
  aktuelles: ['aktuelles', 'Aktuelles'],
  uncategorized: ['allgemein', 'Allgemein'],
}
/** Which category counts when a post has several: the first of these. */
const PRIORITY = ['vereine', 'veranstaltungen', 'geschichte', 'natur-erleben', 'kultur', 'leben-im-gruenen', 'lage-und-umgebung', 'stadt-und-menschen', 'aktuelles', 'uncategorized']
/** Pages that are no knowledge: the start page, lists, legal texts of the site, thank-you pages, the ferry status test pages. */
const LAYOUT_PAGES = ['startseite', 'start', 'blog', 'aktuelles', 'impressum', 'datenschutz', 'barrierefreiheit', 'kontakt', 'faehre-test', 'fahre-ilka-2']
const LAYOUT_PATTERN = /vielen-dank/
/** A page with this many links (not pictures) to other pages of the site is an overview made of cards. */
const OVERVIEW_LINKS = 5
/** Less text than this (characters of text and headings together) is no content of its own. */
const MIN_TEXT = 400
const TEASER_MAX = 200

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', strongDelimiter: '**' })
turndown.remove(['style', 'script', 'noscript'])

const clean = (text) =>
  text
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
const plain = (html) => clean(cheerio.load(`<div>${html}</div>`)('div').text()).replace(/\s+/g, ' ')
const markdown = (html) => clean(turndown.turndown(html))

/** The picture without the size WordPress put in its name (`x-1024x768.jpg` → `x.jpg`). */
const original = (url) => url.replace(/-\d+x\d+(\.[a-z]+)$/i, '$1')

/** What the widgets of an Elementor page say, in their order, as Markdown. `title` is left out where it is repeated as a heading. */
export function elementorToMarkdown(html, title = '', labels = []) {
  const $ = cheerio.load(html)
  const blocks = []
  let breadcrumb = true // the first inline list of links is the path at the top
  let last = ''
  const push = (text) => {
    const t = clean(text)
    if (t && t !== last) blocks.push(t)
    if (t) last = t
  }
  $('[data-widget_type]').each((_, el) => {
    const w = $(el)
    const kind = String(w.attr('data-widget_type')).split('.')[0]
    const box = w.find('.elementor-widget-container').first()
    switch (kind) {
      case 'heading': {
        const h = w.find('h1,h2,h3,h4,h5,h6').first()
        const text = clean(h.text())
        const low = text.toLowerCase()
        // the first headings often repeat the title or the name of the section
        const opening = !blocks.some((b) => !b.startsWith('#'))
        if (!text || low === title.toLowerCase() || (opening && (title.toLowerCase().includes(low) || low.includes(title.toLowerCase()) || labels.includes(low)))) break
        const level = Number(h.get(0)?.tagName?.[1] ?? 2)
        push(`${'#'.repeat(Math.min(Math.max(level, 2), 4))} ${text}`)
        break
      }
      case 'text-editor':
        push(markdown(box.html() ?? ''))
        break
      case 'icon-list': {
        if (breadcrumb && w.hasClass('elementor-icon-list--layout-inline')) {
          breadcrumb = false
          break
        }
        breadcrumb = false
        const items = w
          .find('li')
          .map((__, li) => {
            const text = clean($(li).text())
            const href = $(li).find('a').attr('href')
            return text ? `- ${href ? `[${text}](${href})` : text}` : ''
          })
          .get()
          .filter(Boolean)
        push(items.join('\n'))
        break
      }
      case 'button': {
        const a = w.find('a').first()
        const text = clean(a.text())
        if (text && a.attr('href')) push(`[${text}](${a.attr('href')})`)
        break
      }
      case 'image':
      case 'gallery':
      case 'n-carousel':
        w.find('img').each((__, img) => {
          const src = $(img).attr('src')
          if (!src || /\/line\.png$/.test(src)) return
          const caption = clean($(img).closest('figure').find('figcaption').text()) || clean($(img).attr('alt') ?? '')
          push(`![${caption}](${original(src)})`)
        })
        break
      case 'flip-box':
      case 'call-to-action':
      case 'image-box':
      case 'counter': {
        const parts = box
          .find('h1,h2,h3,h4,h5,h6,p,.elementor-flip-box__layer__description,.elementor-cta__description,.elementor-image-box-description')
          .map((__, n) => clean($(n).text()))
          .get()
          .filter(Boolean)
        push([...new Set(parts)].join('\n\n'))
        break
      }
      default: // spacer, divider, loop-grid, social-icons, menu-anchor, post navigation, maps, ...: no content
    }
  })
  return blocks.join('\n\n')
}

/** What a page or post says: the widgets if it is an Elementor page, else its HTML as it is. */
export function bodyOf(item, labels = []) {
  const html = item.content?.rendered ?? ''
  const title = plain(item.title?.rendered ?? '')
  return html.includes('data-widget_type') ? elementorToMarkdown(html, title, labels) : markdown(html)
}

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

function topicOf(item, kind, byId) {
  if (kind === 'post') {
    const slugs = (item.categories ?? []).map((id) => byId.categories.get(id)?.slug).filter(Boolean)
    const slug = PRIORITY.find((s) => slugs.includes(s)) ?? slugs[0] ?? 'uncategorized'
    return TOPICS[slug] ?? [slugify(slug), byId.categories.get([...byId.categories.keys()].find((k) => byId.categories.get(k).slug === slug))?.name ?? slug]
  }
  // a page: by the page it hangs below, as far as that is a topic
  for (let parent = byId.pages.get(item.parent); parent; parent = byId.pages.get(parent.parent)) {
    if (TOPICS[parent.slug]) return TOPICS[parent.slug]
  }
  return TOPICS.uncategorized
}

/** Reads `<name>-<N>.json` files of a directory as one list. */
function readAll(dir, name) {
  return readdirSync(dir)
    .filter((f) => new RegExp(`^${name}-\\d+\\.json$`).test(f))
    .sort((a, b) => Number(a.match(/-(\d+)\./)[1]) - Number(b.match(/-(\d+)\./)[1]))
    .flatMap((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
}

const walk = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)])) : [])

/** Plans the import. `existing` are the files that are there already ({ path, text }). Returns what to write and what is left out. */
export function plan({ posts, pages, categories, tags }, existing = [], { skip = [], include = [], entityIds = [] } = {}) {
  const byId = { categories: new Map(categories.map((c) => [c.id, c])), tags: new Map(tags.map((t) => [t.id, t])), pages: new Map(pages.map((p) => [p.id, p])) }
  const done = new Set(existing.flatMap((f) => [...f.text.matchAll(/_wp-(\d+)/g)].map((m) => m[1])))
  const used = new Set(existing.map((f) => f.path.replace(/^.*\//, '').replace(/\.yaml$/, '')))
  const labels = categories.map((c) => plain(c.name).toLowerCase())
  const files = []
  const left = []
  const titles = new Map()
  const items = [...posts.map((item) => ({ item, kind: 'post' })), ...pages.map((item) => ({ item, kind: 'page' }))]
  for (const { item, kind } of items) {
    const title = plain(item.title?.rendered ?? '') || item.slug
    const why = (reason) => left.push({ kind, id: item.id, slug: item.slug, title, reason })
    if (item.status !== 'publish') {
      why(`status ${item.status}`)
      continue
    }
    if (done.has(String(item.id))) {
      why('already imported')
      continue
    }
    if (skip.includes(item.slug)) {
      why('skipped by request')
      continue
    }
    const body = bodyOf(item, labels)
    if (kind === 'page' && !include.includes(item.slug)) {
      const noImages = body.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      const cards = (noImages.match(/\]\(https:\/\/schnackenburg\.de\/[^)]*\)/g) ?? []).length
      const reason = LAYOUT_PAGES.includes(item.slug) || LAYOUT_PATTERN.test(item.slug)
        ? 'no knowledge (layout, legal text, thank-you or test page)'
        : cards >= OVERVIEW_LINKS
          ? `an overview of other pages (${cards} links)`
          : noImages.length < MIN_TEXT
            ? `little text of its own (${noImages.length} characters)`
            : ''
      if (reason) {
        why(reason)
        continue
      }
    }
    if (!body) {
      why('no text')
      continue
    }
    const [folder, folderTitle] = topicOf(item, kind, byId)
    let slug = item.slug
    // an id is one of a content or an entity, never of both
    if (entityIds.includes(slug)) slug = `${slug}-text`
    if (used.has(slug)) slug = `${slug}-${kind === 'page' ? 'seite' : 'beitrag'}`
    used.add(slug)
    const excerpt = plain(item.excerpt?.rendered ?? '')
    const text = { body: `${body}\n` }
    // WordPress makes an excerpt by cutting the text where it ends; that is no teaser (nothing is cut here)
    const cut = excerpt && plain(body).includes(`${excerpt} `)
    if (excerpt && excerpt.length <= TEASER_MAX && !cut && !/(\[…\]|…)$/.test(excerpt)) text.teaser = `${excerpt}\n`
    const entry = {
      id: slug,
      type: 'content',
      title,
      published: String(item.date).slice(0, 10),
      text,
      tags: [...new Set([...(item.tags ?? []).map((id) => byId.tags.get(id)?.name).filter(Boolean).map((n) => plain(n)), `_wp-${item.id}`, '_import'])],
    }
    files.push({ path: `${folder}/${slug}.yaml`, folder, folderTitle, entry, kind, wp: item.id })
    for (const key of [`title:${title.toLowerCase()}`, `body:${body}`]) titles.set(key, [...(titles.get(key) ?? []), slug])
  }
  const duplicates = [...titles.values()].filter((s) => s.length > 1)
  return { files, left, duplicates }
}

export const toYaml = (entry) => YAML.stringify(entry, { lineWidth: 0, blockQuote: 'literal' })

function main(argv) {
  const [dir, out] = argv.filter((a) => !a.startsWith('--'))
  const opt = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=')[1]?.split(',').filter(Boolean) ?? []
  if (!dir || !out) {
    console.error('usage: import-wordpress.mjs <directory with the REST answers> <contents directory> [--skip=slug,..] [--include=slug,..]')
    process.exit(2)
  }
  const data = { posts: readAll(dir, 'posts'), pages: readAll(dir, 'pages'), categories: readAll(dir, 'categories'), tags: readAll(dir, 'tags') }
  const existing = walk(out).filter((p) => p.endsWith('.yaml')).map((p) => ({ path: p, text: readFileSync(p, 'utf8') }))
  // the entities next to the contents directory: their ids are taken
  const entities = join(out, '..', 'entities')
  const entityIds = walk(entities).filter((p) => p.endsWith('.yaml')).map((p) => p.slice(entities.length + 1).replace(/^[^/]+\//, '').replace(/\.yaml$/, ''))
  const { files, left, duplicates } = plan(data, existing, { skip: opt('skip'), include: opt('include'), entityIds })
  for (const f of files) {
    mkdirSync(join(out, f.folder), { recursive: true })
    const folderFile = join(out, f.folder, '.folder.yaml')
    if (!existsSync(folderFile)) writeFileSync(folderFile, `title: ${JSON.stringify(f.folderTitle)}\n`)
    writeFileSync(join(out, f.path), toYaml(f.entry))
  }
  console.log(`${files.length} contents written to ${out}`)
  const folders = {}
  for (const f of files) folders[f.folder] = (folders[f.folder] ?? 0) + 1
  console.log(Object.entries(folders).map(([k, v]) => `  ${k}: ${v}`).join('\n'))
  if (left.length) console.log(`\nLeft out (${left.length}):\n${left.map((l) => `  ${l.kind} ${l.id} ${l.slug}: ${l.reason}`).join('\n')}`)
  if (duplicates.length) console.log(`\nThe same title or text more than once (look at these):\n${duplicates.map((d) => `  ${d.join(', ')}`).join('\n')}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
