// Where the person is, as the address of the page. What the address says is the same for everybody who opens it; the hash is used (not a
// path), so that no server has to answer for these addresses. It lets back and forward work, and the address be passed on.
//
//   #/                                      the database, nothing open
//   #/e/<path>                              an entry of the database
//   #/bearbeiten/<path>                     the form of an entry
//   #/yaml/<path>                           the YAML of an entry, to read
//   #/neu/<type>?ordner=&eltern=&art=&gruppe=   the form for a new entry (what a "+" in the lists knows)
//   #/einreichung/<n>                       the details of a submission (it is the active one); `?markiert=<path>` marks one of its changes
//   #/einreichung/<n>/e/<path>              the same three, in a submission
//   #/einreichung/<n>/bearbeiten/<path>
//   #/einreichung/<n>/neu/<type>
//
// No hash at all is not an address: the person comes back to where they were last.

import { ENTRY_TYPES, type EntryType } from '@editor/core'
import type { NewContext } from './logic.js'

export interface Route {
  /** The number of the submission that is worked on; none: the database. */
  submission?: number
  /** What the middle shows: nothing, the details of the submission, an entry (to read, or its form), or the form for a new one. */
  view: 'none' | 'details' | 'entry' | 'edit' | 'yaml' | 'new'
  /** `entry`, `edit`, `yaml`: the path of the entry. */
  path?: string
  /** `details`: the change that is marked. */
  focus?: string
  /** `new`: where it is made. */
  context?: NewContext
}

const ENTRY_PATH = /^[A-Za-z0-9._\-/]+\.yaml$/
const known = (path: string | undefined): path is string => !!path && ENTRY_PATH.test(path) && !path.split('/').some((part) => part === '..' || part === '.')

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined // not a valid escape: the page is still known
  }
}

/** The route of an address (`location.hash`); undefined if there is none (the bare address). */
export function parseRoute(hash: string | null | undefined): Route | undefined {
  const text = (hash ?? '').replace(/^#/, '')
  if (text === '') return undefined
  const [path, query = ''] = text.split('?', 2)
  const parts = path.split('/').filter((part, i) => part !== '' || i > 0).filter((part) => part !== '')
  const params = new URLSearchParams(query)
  let submission: number | undefined
  if (parts[0] === 'einreichung' && /^\d{1,9}$/.test(parts[1] ?? '')) {
    submission = Number(parts[1])
    parts.splice(0, 2)
  }
  const rest = parts.map((part) => decode(part) ?? '')
  const route = (r: Route): Route => (submission === undefined ? r : { ...r, submission })
  const entryPath = rest.slice(1).join('/')
  const entryViews = { e: 'entry', bearbeiten: 'edit', yaml: 'yaml' } as const
  if (rest[0] === 'e' || rest[0] === 'bearbeiten' || rest[0] === 'yaml') return known(entryPath) ? route({ view: entryViews[rest[0]], path: entryPath }) : route({ view: submission === undefined ? 'none' : 'details' })
  if (rest[0] === 'neu') {
    const type = rest[1] as EntryType | undefined
    const context: NewContext = { type: type && ENTRY_TYPES.includes(type) ? type : undefined, folder: params.get('ordner') ?? '' }
    for (const [name, key] of [['eltern', 'parent'], ['art', 'kind'], ['gruppe', 'group']] as const) {
      const value = params.get(name)
      if (value) context[key] = value
    }
    return route({ view: 'new', context })
  }
  const focus = params.get('markiert')
  return route({ view: submission === undefined ? 'none' : 'details', ...(submission !== undefined && known(focus ?? undefined) ? { focus: focus! } : {}) })
}

const encoded = (path: string) => path.split('/').map(encodeURIComponent).join('/')

/** The address of a route. */
export function formatRoute(route: Route): string {
  const base = route.submission === undefined ? '#' : `#/einreichung/${route.submission}`
  if (route.view === 'entry' && route.path) return `${base}/e/${encoded(route.path)}`
  if (route.view === 'edit' && route.path) return `${base}/bearbeiten/${encoded(route.path)}`
  if (route.view === 'yaml' && route.path) return `${base}/yaml/${encoded(route.path)}`
  if (route.view === 'new') {
    const c = route.context
    const query = new URLSearchParams()
    if (c?.folder) query.set('ordner', c.folder)
    if (c?.parent) query.set('eltern', c.parent)
    if (c?.kind) query.set('art', c.kind)
    if (c?.group) query.set('gruppe', c.group)
    return `${base}/neu${c?.type ? `/${c.type}` : ''}${query.size > 0 ? `?${query}` : ''}`
  }
  if (route.view === 'details' && route.submission !== undefined) return route.focus ? `${base}?markiert=${encoded(route.focus)}` : base
  return route.submission === undefined ? '#/' : base
}

/** Whether going from one route to the other is something the app did itself (the first address, a draft getting its number, an entry that was renamed), not a step of the person's. */
export function sameStep(from: Route, to: Route): boolean {
  if (from.view !== to.view) return false
  if (from.view === 'edit' && from.submission === to.submission) return true // renamed
  return from.submission === undefined && to.submission !== undefined && from.path === to.path
}
