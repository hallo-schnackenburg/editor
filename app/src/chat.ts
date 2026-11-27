// What the assistant's tool calls do in the app. Looking things up and moving around happen at once. Changes to entries are made to
// the texts, exactly as if the person had typed them: nothing is saved (that is "Fertig"), and a field the person changed in the
// meantime is left alone. Whatever is hard to take back, or that others see (save, delete, rename, submit, accept ...), is only
// prepared: the chat shows a question with a button, and the action is done when the person presses it, not by the assistant.
// The rights and rules are those of the screens: what a button there does not allow, the assistant cannot do.

import { MODEL, isWhen, readValue, ruleProblem, setField, setText, TEXT_ROLES } from '@editor/core'
import type { ToolCall } from './agent.js'
import { SignedOut } from './api.js'
import { autoAddress, holderOf, idOf, nameFieldOf, planRename, setValue, titleOf, typeOf, withFile, withText, type Entry } from './logic.js'
import type { FileEntry } from './prepare.js'
import type { Workspace } from './workspace.svelte.js'

/** An action that waits for the person's "yes". `run` returns what to tell afterwards. */
export interface Pending {
  label: string
  run(): Promise<string>
  state: 'open' | 'running' | 'done' | 'dismissed'
}

/** `status` is what the app tells (a change made, a call refused), `assistant` what the assistant says, `confirm` a question with a button. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'status' | 'confirm'
  text: string
  pending?: Pending
  /** A change that is made already: one click takes it back. */
  undo?: { run(): Promise<string>; state: 'open' | 'running' | 'done' }
  /** A question with the ways to go on: a click on one sends it as the answer. */
  choices?: { options: string[]; chosen?: string }
}

interface FieldDef {
  label: string
  kind: string
  options?: Record<string, string>
  single?: boolean
}

/**
 * What was done: the messages for the chat, one answer for each call (what the assistant is told), the entry whose form is to be
 * opened (changed, made or opened), and whether the assistant is to go on because it only looked things up.
 */
export interface Outcome {
  messages: ChatMessage[]
  /** What was done, in words, for the log (the chat only says "Erledigt."). */
  log: string[]
  results: string[]
  show?: string
  more: boolean
}

/** The calls that only look or move; if an answer holds nothing else, the assistant sees what came out and goes on. */
const LOOKING = new Set(['search', 'read_entry', 'list_changes', 'read_submission', 'open_entry', 'open_submission', 'show_own_work'])
/** The calls the person is asked about with a button (what others see); the question says it all, so words of the assistant beside them are not shown. */
const ASKING = new Set(['submit_draft', 'accept_submission', 'close_submission', 'comment_submission'])
const MAX_TEXT = 6000

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
const clip = (text: string, max = MAX_TEXT): string => (text.length > max ? `${text.slice(0, max)}\n… (gekürzt)` : text)
const describe = (e: Entry): string => `${typeOf(e) ?? '?'}: ${idOf(e)} — ${titleOf(e)} (${e.path})`

/**
 * Checks a value against the field it is for, and brings it into shape (a single reference may come as a list of one, a list of
 * references as one id). Returns the value, or the reason it cannot be used.
 */
function fitted(def: FieldDef, value: unknown, ids: Set<string>): { value: unknown } | { problem: string } {
  if (isEmpty(value)) return { value: undefined }
  const no = (problem: string) => ({ problem: `${def.label}: ${problem}` })
  switch (def.kind) {
    case 'string':
    case 'date':
      return typeof value === 'string' ? { value } : no('Text erwartet.')
    case 'boolean':
      return typeof value === 'boolean' ? { value } : no('Ja oder Nein erwartet.')
    case 'choice': {
      const options = Object.keys(def.options ?? {})
      return typeof value === 'string' && options.includes(value) ? { value } : no(`„${String(value)}“ ist keine Möglichkeit (${options.join(', ')}).`)
    }
    case 'ref': {
      const list = (Array.isArray(value) ? value : [value]).filter((id): id is string => typeof id === 'string')
      if (list.length === 0) return no('Eine ID erwartet.')
      const missing = list.find((id) => !ids.has(id))
      if (missing !== undefined) return no(`Den Eintrag „${missing}“ gibt es nicht.`)
      return { value: def.single ? list[0] : list }
    }
    case 'tags': {
      const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
      const good = list.filter((t): t is string => typeof t === 'string' && /^[^\s,](?:[^,]*[^\s,])?$/.test(t.trim()) && t.trim().length <= 60).map((t) => t.trim())
      return good.length === list.length ? { value: [...new Set(good)] } : no('Jeder Tag ist ein kurzer Text ohne Komma.')
    }
    case 'links': {
      const links = Array.isArray(value) ? value : []
      const good = links.filter((l) => isRecord(l) && typeof l.label === 'string' && typeof l.url === 'string' && /^https?:\/\/\S+$/.test(l.url))
      return good.length === links.length ? { value: good } : no('Jeder Link braucht eine Bezeichnung und eine Adresse mit http(s)://.')
    }
    case 'location':
      return isRecord(value) && typeof value.lat === 'number' && typeof value.lon === 'number' ? { value: { lat: value.lat, lon: value.lon } } : no('Breite und Länge als Zahlen erwartet.')
    case 'dates': {
      const list = Array.isArray(value) ? value : []
      const good = list.filter((d) => isRecord(d) && isWhen(d.start) && (d.end === undefined || isWhen(d.end)))
      if (good.length !== list.length) return no('Jeder Termin braucht einen Beginn als Datum (2026-04-04) oder mit Uhrzeit (2026-04-04T19:00).')
      return { value: list.map((d) => ({ start: d.start, ...(d.end ? { end: d.end } : {}), ...(typeof d.note === 'string' && d.note ? { note: d.note } : {}), ...(d.cancelled === true ? { cancelled: true } : {}) })) }
    }
    case 'rule': {
      if (!isRecord(value) || typeof value.rrule !== 'string' || typeof value.start !== 'string') return no('Eine Regel besteht aus rrule und start.')
      const problem = ruleProblem({ rrule: value.rrule, start: value.start })
      return problem ? no(`Die Regel stimmt nicht (${problem}).`) : { value: { rrule: value.rrule.trim(), start: value.start } }
    }
    default:
      return no('Dieses Feld kann ich nicht ändern.')
  }
}

/** The entry a reference means: its path, else its id. */
function resolve(ref: string, pool: Entry[]): { entry: Entry } | { problem: string } {
  const wanted = ref.trim()
  const byPath = pool.find((e) => e.path === wanted || e.path === `${wanted}.yaml`)
  if (byPath) return { entry: byPath }
  const byId = pool.filter((e) => idOf(e) === wanted)
  if (byId.length === 1) return { entry: byId[0] }
  if (byId.length > 1) return { problem: `„${wanted}“ ist nicht eindeutig: ${byId.map((e) => e.path).join(', ')}. Nimm den Pfad.` }
  return { problem: `Einen Eintrag „${wanted}“ gibt es nicht.` }
}

/** Carries out the calls of one answer, one after the other. `openPath` is the entry that was open when the answer came. */
export async function carryOut(calls: ToolCall[], openPath: string | undefined, ws: Workspace): Promise<Outcome> {
  const messages: ChatMessage[] = []
  const results: string[] = []
  let target = openPath
  let show: string | undefined
  let refused = false

  const note = (text: string): void => {
    messages.push({ role: 'status', text })
  }
  const log: string[] = []
  /** Something was done: it goes to the log, and the chat says "Erledigt." once for the answer. */
  const logged = (text: string): void => {
    log.push(text)
  }
  const ids = () => new Set(ws.entries.map(idOf))
  /** The entry a call means: the one it names, or the open one. */
  const which = (ref: string | undefined, pool: Entry[] = ws.entries): { entry: Entry } | { problem: string } => {
    if (ref !== undefined) return resolve(ref, pool)
    const open = target ? ws.entries.find((e) => e.path === target) : undefined
    return open ? { entry: open } : { problem: 'Dafür muss ein Eintrag geöffnet sein.' }
  }
  const ask = (question: string, label: string, run: () => Promise<string>): string => {
    messages.push({ role: 'confirm', text: question, pending: { label, run, state: 'open' } })
    return 'Die Person wird gefragt und bestätigt mit einem Knopf. Sag nicht, dass es schon getan ist.'
  }

  /** A change that is made: told as a line of the chat, with "Rückgängig", which brings the entries back as `before` had them. Only as long as nothing else was changed since. */
  const done = (text: string, before: ReturnType<Workspace['snapshot']>): void => {
    const after = ws.snapshot()
    log.push(text)
    messages.push({
      role: 'status',
      text: 'Erledigt.',
      undo: {
        state: 'open',
        run: async () => {
          if (!ws.unchangedSince(after)) return 'Seitdem wurde weiter geändert; ich nehme nichts zurück.'
          return (await ws.restore(before)) ? 'Zurückgenommen.' : ws.error || 'Das hat nicht geklappt.'
        },
      },
    })
  }

  /** One field of the entry at `path`. `old` is what the assistant saw. */
  function patch(path: string, field: string, value: unknown, old: unknown, making = false): void {
    const entry = ws.entries.find((e) => e.path === path)
    if (!entry) return note('Der Eintrag ist nicht mehr da; ich ändere nichts.')
    const type = typeOf(entry)
    if (!type || !entry.data) return note('Der Eintrag ist noch kein gültiges YAML; ich fasse ihn nicht an. Das siehst du im Reiter „YAML“.')
    const fields = MODEL.types[type].fields as unknown as Record<string, FieldDef>
    // The name decides the id and the file: renaming moves them and rewrites the references, which is asked about.
    if (field === nameFieldOf(type) || field === 'id' || field === 'type') {
      // Beside a renaming of the same answer the hint is noise.
      if (!making && !calls.some((c) => c.tool === 'rename_entry')) note(`„${field === 'id' ? 'ID' : field === 'type' ? 'Typ' : fields[field]?.label}“ ändert man mit „Umbenennen“: Das verschiebt die Datei und schreibt die Verweise um.`)
      return
    }
    const def = fields[field]
    if (!def || def.kind === 'files' || def.kind === 'text') return note(`Das Feld „${field}“ gibt es bei ${MODEL.types[type].label} nicht.`)
    const fit = fitted(def, value, ids())
    if ('problem' in fit) return note(fit.problem)
    try {
      const result = setField(entry.text, field, fit.value, old)
      if (!result.ok) return note(`${def.label}: Das hast du inzwischen geändert; ich lasse es, wie es ist.`)
      if (result.text === entry.text) return
      ws.setTextOf(path, result.text)
      show = path
      logged(fit.value === undefined ? `${def.label} entfernt.` : `${def.label} geändert.`)
    } catch (error) {
      note((error as Error).message)
    }
  }

  /** Puts the files dropped into the chat (by their names) into the `files` of an object; what could not be put in is told. */
  function attach(path: string, names: string[]): string {
    const entry = ws.entries.find((e) => e.path === path)
    if (!entry?.data) return 'Der Eintrag ist noch kein gültiges YAML.'
    let list = (Array.isArray(entry.data.files) ? entry.data.files : []) as FileEntry[]
    const taken: number[] = []
    const problems: string[] = []
    for (const name of names) {
      const staged = ws.staged.find((s) => s.entry && !taken.includes(s.id) && s.name === name)
      if (!staged?.entry) {
        problems.push(`Eine fertig hochgeladene Datei „${name}“ gibt es nicht.`)
        continue
      }
      const next = withFile(list, staged.entry, String(entry.data.kind), entry.data.storage === 'external')
      if ('problem' in next) problems.push(`„${name}“: ${next.problem}`)
      else {
        list = next.files
        taken.push(staged.id)
      }
    }
    if (taken.length > 0) {
      ws.setTextOf(path, setValue(entry, 'files', 'files', list))
      ws.unstage(taken)
      show = path
      logged(`${taken.length === 1 ? 'Eine Datei' : `${taken.length} Dateien`} zu „${titleOf(entry)}“ hinzugefügt.`)
    }
    for (const problem of problems) note(problem)
    return [taken.length > 0 ? `${taken.length} Datei(en) hinzugefügt.` : '', ...problems].filter(Boolean).join(' ')
  }

  /** What the call answers (shown to the person as notes, told to the assistant as text). */
  /** What a rename or move would do, to ask the person about: the question, the button, one line for it, and what the button does. Or why it is not possible. */
  async function prepareMove(call: Extract<ToolCall, { tool: 'rename_entry' | 'move_entry' }>): Promise<string | { line: string; run: () => Promise<string | undefined> }> {
      const found = which(call.entry)
      if ('problem' in found) return note(found.problem), found.problem
      const { entry } = found
      const type = typeOf(entry)
      if (!type || !entry.data) return note('Der Eintrag ist noch kein gültiges YAML.'), 'Kein gültiges YAML.'
      const renaming = call.tool === 'rename_entry'
      if (renaming && call.name.includes('/')) return note('Das ist eine ID oder ein Pfad, kein Name; ich benenne nicht um.'), 'Der Name muss so geschrieben sein, wie ihn Leute lesen ("Elbstraße"), keine ID und kein Pfad.'
      if (!renaming && MODEL.types[type].class !== 'entity') return note('Verschieben kann man nur Dinge mit Ordnern (Orte, Personen ...).'), 'Nur Entitäten haben Ordner.'

      /** The entry with its new name, and what the change would move. */
      const plan = () => {
        const current = ws.entries.find((e) => e.path === entry.path)!
        let renamed = current
        if (renaming) {
          const result = setField(current.text, nameFieldOf(type), call.name, readValue(current.text, nameFieldOf(type)))
          if (!result.ok) throw new Error('Der Name lässt sich nicht setzen.')
          renamed = withText(current, result.text)
        }
        const all = ws.entries.map((e) => (e.path === renamed.path ? renamed : e))
        return { renamed, plan: planRename(renamed, all, (p) => all.some((e) => e.path === p), renaming ? undefined : call.folder) }
      }
      await ws.ensureAround(entry.path)
      let preview: ReturnType<typeof plan>
      try {
        preview = plan()
      } catch (error) {
        return note((error as Error).message), (error as Error).message
      }
      if (!preview.plan && !renaming) return note('Der Eintrag liegt schon dort.'), 'Liegt schon dort.'
      const run = async (): Promise<string | undefined> => {
        const again = plan()
        await ws.select(entry.path)
        if (renaming) ws.edit(again.renamed.text)
        else ws.setFolder(call.folder)
        // Saved together by the caller: one commit, not one per entry.
        return (await ws.finish(() => true, { sync: false })) ? undefined : ws.error || 'Das hat nicht geklappt.'
      }
      return { line: renaming ? `${titleOf(entry)} → ${call.name}` : `${titleOf(entry)} → ${call.folder}`, run }
  }

  /** Renames or moves, made at once and saved in one commit; the chat tells them in one line each, with "Rückgängig". */
  async function performMoves(items: Exclude<Awaited<ReturnType<typeof prepareMove>>, string>[], verb: string, problems: string[] = []): Promise<string> {
    const before = ws.snapshot()
    const lines: string[] = []
    let failure: string | undefined
    for (const item of items) {
      failure = await item.run()
      if (failure) break
      lines.push(item.line)
    }
    if (lines.length > 0 && !failure && !(await ws.sync())) failure = ws.error || 'Das hat nicht geklappt.'
    if (lines.length > 0) done(lines.length === 1 ? `${verb}: ${lines[0]}` : `${verb}:\n${lines.join('\n')}`, before)
    if (failure) note(failure)
    const rest = [...(failure ? [failure] : []), ...problems]
    return lines.length > 0 ? `Erledigt (${verb}): ${lines.join('; ')}.${rest.length > 0 ? ` Nicht gemacht: ${rest.join(' ')}` : ''}` : rest.join(' ')
  }

  /** All renames of one answer together. */
  async function renameAll(renames: Extract<ToolCall, { tool: 'rename_entry' }>[]): Promise<string> {
    const prepared: Exclude<Awaited<ReturnType<typeof prepareMove>>, string>[] = []
    const problems: string[] = []
    for (const call of renames) {
      const one = await prepareMove(call)
      if (typeof one === 'string') problems.push(one)
      else prepared.push(one)
    }
    return prepared.length === 0 ? problems.join(' ') : performMoves(prepared, 'Umbenannt', problems)
  }

  async function one(call: ToolCall): Promise<string | undefined> {
    switch (call.tool) {
      case 'clarify':
        messages.push({ role: 'assistant', text: call.question, choices: { options: call.options } })
        return undefined
      case 'say':
        if (!calls.some((c) => ASKING.has(c.tool))) messages.push({ role: 'assistant', text: call.text })
        return undefined

      // --- looking ---
      case 'search': {
        const words = call.query.toLowerCase().split(/\s+/).filter(Boolean)
        const hits = ws.entries
          .filter((e) => (call.type ? typeOf(e) === call.type : true))
          .filter((e) => {
            const hay = `${e.path} ${titleOf(e)}`.toLowerCase()
            return words.every((w) => hay.includes(w))
          })
          .sort((a, b) => Number(titleOf(b).toLowerCase().includes(words[0] ?? '')) - Number(titleOf(a).toLowerCase().includes(words[0] ?? '')))
        if (hits.length === 0) return 'Nichts gefunden.'
        return [...hits.slice(0, 15).map(describe), ...(hits.length > 15 ? [`… und ${hits.length - 15} weitere`] : [])].join('\n')
      }
      case 'read_entry': {
        const found = resolve(call.entry, ws.entries)
        if ('problem' in found) return found.problem
        await ws.ensure([found.entry.path])
        return clip(ws.entries.find((e) => e.path === found.entry.path)?.text ?? found.entry.text)
      }
      case 'list_changes': {
        const lines = [
          ...ws.changes.map((c) => `${c.kind === 'new' ? 'neu' : c.kind === 'changed' ? 'geändert' : c.kind === 'removed' ? 'gelöscht' : 'umbenannt'}: ${c.entry.path}${c.from ? ` (vorher ${c.from})` : ''}`),
          ...ws.dirty.map((e) => `ungespeichert: ${e.path}`),
        ]
        return lines.length > 0 ? clip(lines.join('\n')) : 'Die Einreichung hat keine Änderungen, und nichts ist ungespeichert.'
      }
      case 'read_submission': {
        const sub = ws.submissions.find((s) => s.number === call.number)
        if (!sub) return `Die Einreichung #${call.number} gibt es nicht.`
        const { detail, comments } = await ws.review.peek(call.number)
        const blocked = ws.review.blockReason(detail)
        const checks = { none: 'keine', pending: 'läuft', success: 'bestanden', failure: 'fehlgeschlagen' }[detail.checks]
        return clip(
          [
            `#${sub.number} „${sub.name}“ von ${sub.author}, ${sub.state}. Automatische Prüfung: ${checks}. ${blocked ? `Nicht annehmbar: ${blocked}` : 'Annehmbar.'}`,
            `Einträge${detail.truncated ? ' (nicht alle)' : ''}:`,
            ...detail.items.slice(0, 40).map((i) => `- ${{ added: 'neu', modified: 'geändert', removed: 'gelöscht' }[i.kind]}: ${i.path}`),
            comments.length > 0 ? 'Kommentare:' : 'Keine Kommentare.',
            ...comments.slice(-10).map((c) => `- ${c.author}: ${c.body.slice(0, 300)}`),
          ].join('\n'),
        )
      }

      // --- moving around ---
      case 'open_entry': {
        const found = resolve(call.entry, ws.entries)
        if ('problem' in found) return found.problem
        await ws.select(found.entry.path)
        target = found.entry.path
        show = found.entry.path
        return `Geöffnet: ${found.entry.path}\n${clip(ws.entries.find((e) => e.path === found.entry.path)?.text ?? found.entry.text)}`
      }
      case 'open_submission': {
        const sub = ws.submissions.find((s) => s.number === call.number)
        if (!sub) return `Die Einreichung #${call.number} gibt es nicht.`
        if (sub.state !== 'draft' && sub.state !== 'submitted') return 'Diese Einreichung ist abgeschlossen; lesen kann ich sie mit read_submission.'
        if (!(await ws.work(sub))) return 'Es gibt noch ungespeicherte Änderungen. Die Person entscheidet erst, ob sie gespeichert oder verworfen werden; gewechselt ist noch nicht.'
        target = undefined
        return `Du arbeitest jetzt in der Einreichung „${sub.name}“ von ${sub.author}; Änderungen werden dort gespeichert.`
      }
      case 'show_own_work':
        if (!(await ws.switchTo(ws.ownDraft?.branch))) return 'Es gibt noch ungespeicherte Änderungen. Die Person entscheidet erst, ob sie gespeichert oder verworfen werden; gewechselt ist noch nicht.'
        target = ws.selectedPath
        return 'Du bist wieder bei deiner eigenen Einreichung.'

      // --- the review (also of the submissions of others) ---
      case 'accept_submission':
      case 'close_submission':
      case 'comment_submission': {
        const sub = ws.submissions.find((s) => s.number === call.number)
        if (!sub) return `Die Einreichung #${call.number} gibt es nicht.`
        const label = `#${sub.number} „${sub.name}“ von ${sub.author}`
        if (call.tool === 'accept_submission') {
          if (sub.state !== 'submitted') return 'Angenommen werden kann nur, was vorgeschlagen ist.'
          const { detail } = await ws.review.peek(sub.number)
          const blocked = ws.review.blockReason(detail)
          if (blocked) {
            note(`${label} lässt sich nicht annehmen: ${blocked}`)
            return `Nicht annehmbar: ${blocked}`
          }
          return ask(`Einreichung ${label} annehmen? Sie wird dann Teil der Datenbank.`, 'Annehmen', async () => {
            return (await ws.review.act('merge', sub.number)) ? `Einreichung #${sub.number} angenommen.` : ws.review.error || 'Das hat nicht geklappt.'
          })
        }
        if (call.tool === 'close_submission') {
          if (sub.state !== 'submitted' && sub.state !== 'draft') return 'Diese Einreichung ist schon abgeschlossen.'
          return ask(`Einreichung ${label} verwerfen?`, 'Verwerfen', async () => {
            return (await ws.review.act('close', sub.number)) ? `Einreichung #${sub.number} verworfen.` : ws.review.error || 'Das hat nicht geklappt.'
          })
        }
        return ask(`Diesen Kommentar unter ${label} schreiben?\n„${call.text}“`, 'Schreiben', async () => {
          return (await ws.review.comment(call.text, sub.number)) ? 'Kommentar geschrieben.' : ws.review.error || 'Das hat nicht geklappt.'
        })
      }
    }

    // Everything else changes the own work.
    if (!ws.editable) {
      if (!refused) note(ws.readonlyReason ?? 'Du kannst hier nichts ändern.')
      refused = true
      return 'Nicht möglich: ' + (ws.readonlyReason ?? 'nur zum Lesen.')
    }

    switch (call.tool) {
      case 'patch':
        if (!target) note('Dafür muss ein Eintrag geöffnet sein.')
        else {
          await ws.ensure([target])
          patch(target, call.field, call.value, call.old)
        }
        return undefined
      case 'set_text': {
        if (target) await ws.ensure([target])
        const entry = target ? ws.entries.find((e) => e.path === target) : undefined
        const type = entry && typeOf(entry)
        if (!entry || !type) note('Dafür muss ein Eintrag geöffnet sein.')
        else if (!('text' in MODEL.types[type].fields)) note(`${MODEL.types[type].label} hat keine Texte.`)
        else if (!(TEXT_ROLES as readonly string[]).includes(call.role)) note(`Die Textart „${call.role}“ gibt es nicht.`)
        else {
          try {
            const text = setText(entry.text, call.role, call.value)
            if (text !== entry.text) {
              ws.setTextOf(entry.path, text)
              show = entry.path
              logged(`Text „${MODEL.textRoles[call.role as keyof typeof MODEL.textRoles].label}“ geändert.`)
            }
          } catch (error) {
            note((error as Error).message)
          }
        }
        return undefined
      }
      case 'create_entry': {
        let path: string
        try {
          // An object needs its kind first (it decides the files and fields): the one the assistant named, else by what the files are.
          const staged = (call.files ?? []).map((n) => ws.staged.find((s) => s.entry && s.name === n)?.entry)
          const kind = call.type === 'object' ? (call.kind ?? (staged.length === 1 && String(staged[0]?.mime ?? '').startsWith('image/') ? 'image' : 'document')) : undefined
          ws.create(call.type, call.name, call.folder, { numbered: true, kind })
          path = ws.selectedPath!
        } catch (error) {
          note((error as Error).message)
          return undefined
        }
        target = path
        show = path
        logged(`${MODEL.types[call.type].label} „${call.name}“ angelegt.`)
        for (const [field, value] of Object.entries(call.fields ?? {})) patch(path, field, value, undefined, true)
        if (call.type === 'object' && call.files?.length) attach(path, call.files)
        // A house that lies in no place yet goes where its name or address says (the parent and the kind; the folder follows).
        const homeless = ws.entries.find((e) => e.path === path)
        const holder = homeless && holderOf(homeless, ws.entries)
        if (homeless && holder) {
          ws.edit(setValue(homeless, 'parent', 'string', idOf(holder.parent)))
          const moved = ws.entries.find((e) => e.path === path)
          if (moved && moved.data?.kind === undefined) ws.edit(setValue(moved, 'kind', 'string', 'building'))
          if (ws.selectedPath === path) ws.setFolder(idOf(holder.parent))
        }
        // A building named like "Gummern 3" in a place gets its address from there (unless the chat gave one).
        const placed = ws.entries.find((e) => e.path === path)
        const address = placed && !('address' in (call.fields ?? {})) ? autoAddress(placed, ws.entries) : undefined
        if (placed && address) ws.edit(setValue(placed, 'address', 'string', address))
        // An entity the chat makes from a name only is to be completed: it gets the internal tag _stub, so that it can be found later.
        const made = ws.entries.find((e) => e.path === path)
        if (made && MODEL.types[call.type].class === 'entity' && 'tags' in MODEL.types[call.type].fields && !('description' in (call.fields ?? {})) && !('tags' in (call.fields ?? {}))) ws.edit(setValue(made, 'tags', 'tags', ['_stub']))
        return undefined
      }
      case 'attach_files': {
        const found = which(call.entry)
        if ('problem' in found) return note(found.problem), found.problem
        if (typeOf(found.entry) !== 'object') return 'Dateien gehören zu Objekten.'
        return attach(found.entry.path, call.files)
      }
      case 'rename_draft':
        await ws.rename(call.name)
        logged(`Einreichung umbenannt in „${call.name}“.`)
        return undefined

      case 'save': {
        const n = ws.dirty.length
        if (n === 0) {
          note('Es gibt nichts zu speichern.')
          return 'Nichts ungespeichert.'
        }
        if (!(await ws.finish(() => true))) return note(ws.error || 'Das hat nicht geklappt.'), ws.error || 'Das hat nicht geklappt.'
        logged(n === 1 ? 'Eine Änderung gespeichert.' : `${n} Änderungen gespeichert.`)
        return 'Gespeichert.'
      }
      case 'discard_unsaved': {
        const found = which(undefined)
        if ('problem' in found) return note(found.problem), found.problem
        const { entry } = found
        if (!ws.dirty.some((e) => e.path === entry.path)) {
          note(`An „${titleOf(entry)}“ ist nichts ungespeichert.`)
          return 'Nichts ungespeichert.'
        }
        await ws.select(entry.path)
        ws.revert()
        logged(`Ungespeichertes an „${titleOf(entry)}“ verworfen.`)
        return 'Verworfen.'
      }
      case 'take_back': {
        const pool = ws.changes.flatMap((c) => [c.entry, ...(c.from ? [{ ...c.entry, path: c.from }] : [])])
        const found = resolve(call.entry, pool)
        if ('problem' in found) return note(found.problem), found.problem
        const change = ws.changes.find((c) => c.entry.path === found.entry.path || c.from === found.entry.path)
        if (!change) return note('Dazu gibt es keine gespeicherte Änderung.'), 'Keine gespeicherte Änderung.'
        await ws.discard(change.entry.path)
        logged(`Änderung an „${titleOf(change.entry)}“ zurückgenommen.`)
        return 'Zurückgenommen.'
      }
      case 'delete_entry': {
        const found = which(call.entry)
        if ('problem' in found) return note(found.problem), found.problem
        const { entry } = found
        const refs = ws.referencesTo(entry.path)
        const before = ws.snapshot()
        await ws.select(entry.path)
        if (!(await ws.remove())) return note(ws.error || 'Das hat nicht geklappt.'), ws.error || 'Das hat nicht geklappt.'
        done(`Gelöscht: ${titleOf(entry)}${refs > 0 ? ` (${refs === 1 ? 'ein Verweis' : `${refs} Verweise`} entfernt)` : ''}`, before)
        return 'Gelöscht.'
      }
      case 'rename_entry':
      case 'move_entry': {
        const prepared = await prepareMove(call)
        if (typeof prepared === 'string') return prepared
        return performMoves([prepared], call.tool === 'rename_entry' ? 'Umbenannt' : 'Verschoben')
      }
      case 'submit_draft': {
        if (!ws.draft && ws.dirty.length === 0) return note('Es gibt keine Einreichung im Entwurf, die sich vorschlagen ließe.'), 'Kein Entwurf.'
        return ask(`Deine Einreichung${ws.draft ? ` „${ws.draft.name}“` : ''} vorschlagen? Danach kann das Team sie annehmen.`, 'Vorschlagen', async () => ((await ws.submit()) ? 'Vorgeschlagen.' : ws.error || 'Das hat nicht geklappt.'))
      }
    }
  }

  // Several renames in one answer are made together, in one commit.
  const renames = calls.filter((c): c is Extract<ToolCall, { tool: 'rename_entry' }> => c.tool === 'rename_entry')
  for (const call of calls) {
    const before = messages.length
    let result: string | undefined
    try {
      if (call.tool === 'rename_entry' && renames.length > 1) result = call === renames[0] ? await renameAll(renames) : 'Steht in der ersten Umbenennung.'
      else result = await one(call)
    } catch (error) {
      if (error instanceof SignedOut) throw error
      result = (error as Error).message
      note(result)
    }
    results.push(result ?? (messages.slice(before).map((m) => m.text).join(' ') || 'ok'))
  }
  // What was done is said once: "Erledigt." (with "Rückgängig" where that is possible), the words are in the log.
  if (log.length > 0 && !messages.some((m) => m.undo)) messages.push({ role: 'status', text: 'Erledigt.' })
  return { messages, log, results, show, more: calls.length > 0 && calls.every((c) => LOOKING.has(c.tool)) }
}
