// The helper that fills in the form while the person types. It looks at the open entry a moment after the last change, asks the Worker
// (agent.assist) and enters what comes back into fields that are empty and that the person has not touched. A field the person has
// changed is theirs from then on, also when they empty it again. What the helper entered is marked (`filled`) and can be taken back.

import { MODEL } from '@editor/core'
import type { Agent, AssistAnswer, IndexEntry } from './agent.js'
import { idOf, nameFieldOf, setValue, titleOf, typeOf, type Entry, type FieldKind } from './logic.js'
import type { Workspace } from './workspace.svelte.js'

type FieldDef = { kind: string; multiline?: boolean; single?: boolean }
const defsOf = (entry: Entry): Record<string, FieldDef> | undefined => {
  const type = typeOf(entry)
  return type && MODEL.types[type].class === 'entity' ? (MODEL.types[type].fields as unknown as Record<string, FieldDef>) : undefined
}

/** What the helper never fills: the address of a place is made from its name and parent, and the postal code is the person's. */
const NEVER = new Set(['address', 'postal_code'])
const FILLABLE = new Set(['string', 'choice', 'ref', 'tags'])
/** Names shorter than this are not worth a question. */
const MIN_NAME = 3

export interface Filled {
  /** Where the value comes from, if it is not the helper's own reading of the name (the map). */
  source?: string
  /** When it was entered: a field entered a moment ago pulses once. */
  at: number
}

const empty = (value: unknown): boolean => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)

export class Assistant {
  /** By entry path and field: what the helper entered and the person has not touched since. */
  filled = $state<Record<string, Record<string, Filled>>>({})
  /** Whether a question is on its way (for a quiet sign that the helper is looking). */
  working = $state(false)

  readonly #touched = new Map<string, Set<string>>()
  readonly #asked = new Map<string, string>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #abort: AbortController | undefined

  constructor(
    private readonly ws: Workspace,
    private readonly agent: Agent | undefined,
    private readonly delay = 700,
  ) {}

  /** The person changed this field: it is theirs from now on. */
  touch(path: string, field: string): void {
    if (!this.#touched.has(path)) this.#touched.set(path, new Set())
    this.#touched.get(path)!.add(field)
    if (this.filled[path]?.[field]) {
      const { [field]: _gone, ...rest } = this.filled[path]
      this.filled = { ...this.filled, [path]: rest }
    }
  }

  /** Something in the open entry changed: ask again once it has been quiet for a moment. */
  nudge(path: string): void {
    if (!this.agent?.assist) return
    clearTimeout(this.#timer)
    this.#abort?.abort()
    this.#timer = setTimeout(() => void this.#run(path), this.delay)
  }

  /** The helper enters nothing in this entry any more (it was closed or the person leaves it). */
  stop(): void {
    clearTimeout(this.#timer)
    this.#abort?.abort()
    this.working = false
  }

  /** The fields the helper may fill now: empty, not touched, and of a kind it can fill. `location` is for the second question. */
  openFields(entry: Entry, stage: 'fields' | 'location'): string[] {
    const defs = defsOf(entry)
    const type = typeOf(entry)
    if (!defs || !type) return []
    const touched = this.#touched.get(entry.path)
    const own = nameFieldOf(type)
    return Object.entries(defs)
      .filter(([name, def]) => {
        if (touched?.has(name) || name === own || NEVER.has(name) || def.multiline) return false
        if (stage === 'location' ? name !== 'location' : !FILLABLE.has(def.kind)) return false
        return empty(entry.data?.[name])
      })
      .map(([name]) => name)
  }

  async #run(path: string): Promise<void> {
    const agent = this.agent
    const entry = this.ws.selected
    if (!agent?.assist || !entry || entry.path !== path || !this.ws.editable || !defsOf(entry)) return
    const name = entry.data?.[nameFieldOf(typeOf(entry)!)]
    if (typeof name !== 'string' || name.trim().length < MIN_NAME) return
    const controller = new AbortController()
    this.#abort = controller
    this.working = true
    try {
      for (const stage of ['fields', 'location'] as const) {
        const now = this.ws.selected
        if (!now || now.path !== path || controller.signal.aborted) return
        const open = this.openFields(now, stage)
        if (open.length === 0) continue
        const signature = `${stage}|${JSON.stringify(now.data)}|${open.join(',')}`
        if (this.#asked.get(path + stage) === signature) continue
        this.#asked.set(path + stage, signature)
        const answer = await agent.assist({ stage, type: typeOf(now) ?? null, data: now.data ?? {}, open, index: this.#index() }, controller.signal)
        if (controller.signal.aborted) return
        this.#apply(path, answer)
      }
    } catch {
      // aborted by the next change, or the helper is not available: nothing to show, the person goes on typing
    } finally {
      if (this.#abort === controller) this.working = false
    }
  }

  #index(): IndexEntry[] {
    return this.ws.entries.flatMap((e) => {
      const type = typeOf(e)
      return type && MODEL.types[type].class === 'entity' ? [{ id: idOf(e), type, name: titleOf(e) }] : []
    })
  }

  /** Enters what is still empty and untouched; whatever changed while the answer was on its way is left alone. */
  #apply(path: string, answer: AssistAnswer): void {
    for (const [field, value] of Object.entries(answer.fields)) {
      const now = this.ws.selected
      const def = now && defsOf(now)?.[field]
      if (!now || now.path !== path || !def || this.#touched.get(path)?.has(field) || !empty(now.data?.[field])) continue
      const kind = (def.kind === 'ref' && def.single ? 'string' : def.kind === 'choice' ? 'string' : def.kind) as FieldKind
      try {
        this.ws.edit(setValue(now, field, kind, value))
      } catch {
        continue
      }
      // A place the helper put somewhere goes into the folder of that place, as when the person chooses it.
      if (field === 'parent' && typeOf(now) === 'place' && typeof value === 'string') this.ws.setFolder(value)
      this.filled = { ...this.filled, [path]: { ...this.filled[path], [field]: { at: Date.now(), ...(answer.source?.[field] ? { source: answer.source[field] } : {}) } } }
    }
  }

  /** Takes back what the helper entered in this field. The field is the person's from then on. */
  undo(path: string, field: string): void {
    const now = this.ws.selected
    const def = now && defsOf(now)?.[field]
    if (!now || now.path !== path || !def) return
    const kind = (def.kind === 'ref' && def.single ? 'string' : def.kind === 'choice' ? 'string' : def.kind) as FieldKind
    const blank = kind === 'location' ? { lat: null, lon: null } : kind === 'tags' || (kind === 'ref' && !def.single) ? [] : ''
    try {
      this.ws.edit(setValue(now, field, kind, blank))
    } catch {
      return
    }
    this.touch(path, field)
  }
}
