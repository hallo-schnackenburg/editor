// The assistant turns what the person writes into actions. The rest of the app only knows this interface: it sends the message
// with what the assistant needs to see, and gets back a list of tool calls, which chat.ts carries out. Looking things up takes
// several rounds: the answers to the calls go back with the next request (`trail`). The assistant never changes anything itself.
// WorkerAgent asks the model behind the Worker; FakeAgent stands in for the demo and the tests and returns the same kind of
// calls, so everything behind it is real.

import { readValue, type EntryType } from '@editor/core'

/** An entity as the assistant gets to know it, so that it can set references without looking anything up. */
export interface IndexEntry {
  id: string
  type: string
  name: string
}

/** What is going on in the app, as far as it matters to what the person asks. */
export interface AppState {
  /** The name of the submission that is worked on when somebody else started it, or none. */
  viewing: string | null
  draft: { name: string; state: string } | null
  /** The paths of the entries that are changed and not saved yet. */
  unsaved: string[]
  /** How many entries the draft differs from the database in. */
  changes: number
  /** The submissions of the others that are waiting or being worked on. */
  submissions: { number: number; name: string; author: string; state: string }[]
  /** Files dropped into the chat that are uploaded and belong to no object yet. */
  files: { name: string; mime: string; bytes: number }[]
}

/** One round: what the assistant called, and what the app answered to each call. */
export interface TrailStep {
  calls: { id: string; tool: string; input: Record<string, unknown> }[]
  results: { id: string; text: string }[]
}

export interface AgentRequest {
  message: string
  /** The entry that is open, with its text as it is in the editor now (typed and not saved included). */
  entry: { path: string; id: string; text: string } | null
  /** All entities. */
  index: IndexEntry[]
  app: AppState
  /** The conversation so far (oldest first), so that "und der Teaser?" has something to refer to. */
  history: { role: 'user' | 'assistant'; text: string }[]
  /** The rounds of this answer so far. */
  trail: TrailStep[]
}

/**
 * What the assistant asks for. `entry` is an id or a path; without it the open entry is meant. The ones that are hard to take back or
 * that others see are only prepared: the person confirms them with a button.
 */
export type ToolCall = { id?: string } & (
  | { tool: 'say'; text: string }
  // looking things up: the answer goes back to the assistant
  | { tool: 'search'; query: string; type?: EntryType }
  | { tool: 'read_entry'; entry: string }
  | { tool: 'list_changes' }
  | { tool: 'read_submission'; number: number }
  // moving around
  | { tool: 'open_entry'; entry: string }
  | { tool: 'open_submission'; number: number }
  | { tool: 'show_own_work' }
  // changes that stay unsaved until "Fertig"; `patch` and `set_text` concern the open entry, `create_entry` opens the new one
  | { tool: 'patch'; field: string; value: unknown; old?: unknown }
  | { tool: 'set_text'; role: string; value: string }
  | { tool: 'create_entry'; type: EntryType; name: string; folder?: string; fields?: Record<string, unknown>; kind?: string; files?: string[] }
  | { tool: 'attach_files'; files: string[]; entry?: string }
  | { tool: 'rename_draft'; name: string }
  // asked about first
  | { tool: 'save' }
  | { tool: 'discard_unsaved' }
  | { tool: 'take_back'; entry: string }
  | { tool: 'delete_entry'; entry?: string }
  | { tool: 'rename_entry'; entry?: string; name: string }
  | { tool: 'move_entry'; entry?: string; folder: string }
  | { tool: 'submit_draft' }
  | { tool: 'accept_submission'; number: number }
  | { tool: 'close_submission'; number: number }
  | { tool: 'comment_submission'; number: number; text: string }
)

export interface Agent {
  respond(request: AgentRequest): Promise<ToolCall[]>
}

const say = (text: string): ToolCall => ({ tool: 'say', text })

/**
 * The stand-in: understands a few things and says what it cannot do. "Beschreibung: ..." sets the description of the open entry,
 * "öffne X" opens the entry with that name, "speichern", "einreichen", "löschen" prepare those actions. `delay` is how long it
 * "thinks", in milliseconds.
 */
export class FakeAgent implements Agent {
  constructor(private delay = 400) {}

  async respond(request: AgentRequest): Promise<ToolCall[]> {
    if (this.delay > 0) await new Promise((resolve) => setTimeout(resolve, this.delay))
    const message = request.message.trim()
    const lower = message.toLowerCase()

    const open = /^(?:öffne|oeffne|zeig(?:e)?)\s+(?:mir\s+)?(?:den |die |das )?(.+?)\.?$/i.exec(message)
    if (open) {
      const wanted = open[1].toLowerCase()
      const found = request.index.filter((e) => e.name.toLowerCase().includes(wanted) || e.id === wanted)
      if (found.length === 0) return [say(`Einen Eintrag „${open[1]}“ finde ich nicht.`)]
      if (found.length > 1) return [say(`Meinst du: ${found.slice(0, 5).map((e) => e.name).join(', ')}?`)]
      return [{ tool: 'open_entry', entry: found[0].id }]
    }
    if (/^(speichern|fertig)\.?$/.test(lower)) return [{ tool: 'save' }]
    if (/^einreichen\.?$/.test(lower)) return [{ tool: 'submit_draft' }]
    if (/^(löschen|lösche (den|diesen) eintrag)\.?$/.test(lower)) return [{ tool: 'delete_entry' }]

    if (!request.entry) return [say('Öffne zuerst einen Eintrag („öffne Gummern“), dann helfe ich dir damit.')]
    const description = /^beschreibung:\s*(.+)$/is.exec(message)
    if (description) return [{ tool: 'patch', field: 'description', value: description[1].trim(), old: readValue(request.entry.text, 'description') }]
    return [say('Ich bin die Demo-KI und kann nur „Beschreibung: …“ eintragen, „öffne …“, „speichern“, „einreichen“ und „löschen“. Die echte läuft über den Worker.')]
  }
}
