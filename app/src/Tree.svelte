<script lang="ts">
  import { holds, idOf, isDirty, newContextFor, newContextBelow, shortName, titleOf, type Entry, type NewContext } from './logic.js'

  let { entries, folders = {}, selected, filter = '', hint, repeating, onselect, oncreate }: { entries: Entry[]; folders?: Record<string, string>; selected?: string; filter?: string; hint?: (entry: Entry) => string; repeating?: (entry: Entry) => boolean; onselect: (path: string) => void; oncreate?: (context: NewContext) => void } = $props()

  /** A folder. If an entry of the same name lies beside it (entities/places/gummern.yaml beside gummern/), the folder is that entry's: it is named after it and opens on its click. */
  interface Node { name: string; path: string; count: number; folders: Node[]; entries: Entry[]; entry?: Entry }
  type Item = { label: string; node: Node } | { label: string; entry: Entry }

  // What the folders are called on screen (plural). The others, the topics of the contents and the folders of the objects, are capitalized.
  const NAMES: Record<string, string> = {
    contents: 'Inhalte',
    entities: 'Entitäten',
    objects: 'Objekte',
    'entities/events': 'Ereignisse',
    'entities/organizations': 'Organisationen',
    'entities/people': 'Personen',
    'entities/places': 'Orte',
    'entities/things': 'Dinge',
  }
  /** The name of a folder: fixed for the top ones and the types of entities, a topic of the contents as its .folder.yaml names it, else the folder's own name. */
  const nameOf = (node: { name: string; path: string }) => NAMES[node.path] ?? folders[node.path] ?? node.name.charAt(0).toLocaleUpperCase('de') + node.name.slice(1)
  /** What a folder is called: the entry beside it names it, else its own name. */
  const labelOf = (node: Node) => (node.entry ? titleOf(node.entry) : nameOf(node))
  /** Entities first, then contents, then objects. */
  const TOP = ['entities', 'contents', 'objects']

  const needle = $derived(filter.trim().toLowerCase())
  const matches = (e: Entry) => !needle || titleOf(e).toLowerCase().includes(needle) || idOf(e).includes(needle)
  const byPath = $derived(new Map(entries.map((e) => [e.path, e])))

  /** The folders the entries lie in, the entries in them. Only what matches the search; each folder counts what is below it. */
  const root = $derived.by((): Node => {
    const top: Node = { name: '', path: '', count: 0, folders: [], entries: [] }
    for (const e of entries.filter(matches)) {
      let node = top
      node.count++
      let path = ''
      for (const part of e.path.split('/').slice(0, -1)) {
        path = path ? `${path}/${part}` : part
        let next = node.folders.find((f) => f.name === part)
        if (!next) node.folders.push((next = { name: part, path, count: 0, folders: [], entries: [] }))
        next.count++
        node = next
      }
      node.entries.push(e)
    }
    // The fixed folders (entities with its types, contents, objects) and a topic with a name of its own (.folder.yaml) are there while they
    // are empty (not while searching: then they have nothing to find).
    if (!needle) {
      for (const path of [...Object.keys(NAMES), ...Object.keys(folders)]) {
        let node = top
        let at = ''
        for (const part of path.split('/')) {
          at = at ? `${at}/${part}` : part
          let next = node.folders.find((f) => f.name === part)
          if (!next) node.folders.push((next = { name: part, path: at, count: 0, folders: [], entries: [] }))
          node = next
        }
      }
    }
    // The entry beside a folder belongs to it (also when the search did not find it: it gives the folder its name).
    const join = (parent: Node) => {
      for (const f of parent.folders) {
        const beside = byPath.get(`${f.path}.yaml`)
        if (beside) {
          f.entry = beside
          parent.entries = parent.entries.filter((e) => e !== beside)
        }
        join(f)
      }
    }
    join(top)
    return top
  })

  /** What a folder shows: its folders and entries together, by name (the top ones in their own order). */
  const itemsOf = (node: Node): Item[] => {
    const items: Item[] = [...node.folders.map((f): Item => ({ label: labelOf(f), node: f })), ...node.entries.map((e): Item => ({ label: titleOf(e), entry: e }))]
    return node === root ? items.sort((a, b) => TOP.indexOf('node' in a ? a.node.name : '') - TOP.indexOf('node' in b ? b.node.name : '')) : items.sort((a, b) => a.label.localeCompare(b.label, 'de', { numeric: true }))
  }

  // Everything starts closed. A search opens what it finds.
  let opened = $state<Record<string, boolean>>({})
  const isOpen = (path: string) => (needle ? true : !!opened[path])
  const toggle = (path: string) => (opened[path] = !opened[path])

  // An entry that is chosen somewhere else (a link, a new entry) is shown: its folders open.
  $effect(() => {
    if (!selected) return
    const parts = selected.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) opened[parts.slice(0, i).join('/')] = true
  })

  /** A click on a folder opens and closes it; if it has an entry, the first click also chooses that. */
  function pick(node: Node) {
    if (!node.entry) return toggle(node.path)
    opened[node.path] = selected === node.entry.path ? !opened[node.path] : true
    onselect(node.entry.path)
  }
</script>

{#snippet plus(context: NewContext | undefined, what: string)}
  {#if oncreate && context}<button class="plus" title="Neu: {what}" aria-label="Neu anlegen: {what}" onclick={() => oncreate(context)}>+</button>{/if}
{/snippet}

{#snippet folder(node: Node, depth: number, parentLabel?: string, holder?: Entry)}
  {@const own = node.entry}
  {@const below = holds(own) ? own : holder}
  <div class="row" class:active={own && selected === own.path}>
    <button class={own ? 'entry' : 'folder'} style:padding-left="{depth * 14 + 4}px" onclick={() => pick(node)} aria-expanded={isOpen(node.path)}>
      <span class="what"><span class="t">{shortName(labelOf(node), parentLabel)}</span></span>
      {#if own && isDirty(own)}<span class="dot" title="Nicht gespeichert">●</span>{/if}
    </button>
    <!-- The plus sits left of the number, so that the numbers stand in one column whether a row has a plus or not. -->
    {@render plus(newContextFor(node.path, node.entry, holder), labelOf(node))}
    <button class="num" tabindex="-1" aria-hidden="true" onclick={() => pick(node)}>{node.count}</button>
  </div>
  {#if isOpen(node.path)}
    {#each itemsOf(node) as item ('node' in item ? item.node.path : item.entry.path)}
      {#if 'node' in item}{@render folder(item.node, depth + 1, own ? titleOf(own) : undefined, below)}{:else}{@render entry(item.entry, depth + 1, own ? titleOf(own) : undefined)}{/if}
    {/each}
  {/if}
{/snippet}

{#snippet entry(e: Entry, depth: number, parentLabel?: string)}
  <div class="row" class:active={selected === e.path}>
    <button class="entry" style:padding-left="{depth * 14 + 4}px" onclick={() => onselect(e.path)}>
      <span class="what">
        <span class="line">
          <span class="t">{shortName(titleOf(e), parentLabel)}</span>
          {#if repeating?.(e)}<svg class="clock" viewBox="0 0 16 16" width="12" height="12" role="img" aria-label="Wiederkehrend"><title>Wiederkehrend</title><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>{/if}
        </span>
        {#if hint?.(e)}<span class="muted h">{hint(e)}</span>{/if}
      </span>
      {#if isDirty(e)}<span class="dot" title="Nicht gespeichert">●</span>{/if}
    </button>
    {@render plus(newContextBelow(e), titleOf(e))}
  </div>
{/snippet}

<div class="tree">
  {#each itemsOf(root) as item ('node' in item ? item.node.path : item.entry.path)}
    {#if 'node' in item}{@render folder(item.node, 0)}{/if}
  {:else}<p class="muted pad">Nichts gefunden.</p>{/each}
</div>

<style>
  .tree { padding: 4px 6px 12px; overflow: auto; flex: 1; min-height: 0; }
  .row { display: flex; align-items: center; border-radius: 6px; }
  .row:hover { background: var(--wash); }
  .row.active { background: var(--accent-wash); color: var(--accent); }
  .row > button { display: flex; gap: 8px; align-items: center; flex: 1; min-width: 0; text-align: left; border: 0; background: none; border-radius: 6px; padding: 3px 6px; }
  .folder { min-height: 26px; }
  .row > .num { flex: none; min-width: 2.5em; justify-content: flex-end; color: var(--muted); font-size: 12px; padding: 3px 6px 3px 0; }
  .row.active > .num { color: inherit; }
  /* The plus shows when the mouse is over the row (or the keyboard is on it). */
  .row > .plus { flex: none; width: 24px; height: 24px; padding: 0; justify-content: center; border-radius: 6px; color: var(--accent); opacity: 0; line-height: 1; font-size: 16px; }
  .row:hover > .plus, .row > .plus:focus-visible { opacity: 1; }
  .what { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .clock { flex: none; color: var(--muted); position: relative; top: 0.5px; }
  .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .h { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { color: var(--bad); }
  .pad { padding: 10px; }
</style>
