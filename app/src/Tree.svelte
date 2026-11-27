<script lang="ts">
  import { groupIndex, holds, idOf, isDirty, isGroup, newContextFor, newContextBelow, placeMove, shortName, siblingTarget, titleOf, typeOf, type DropTarget, type Entry, type NewContext, type PlaceMove } from './logic.js'

  let { entries, folders = {}, selected, filter = '', hint, repeating, canMove = false, onselect, oncreate, onmove }: { entries: Entry[]; folders?: Record<string, string>; selected?: string; filter?: string; hint?: (entry: Entry) => string; repeating?: (entry: Entry) => boolean; canMove?: boolean; onselect: (path: string) => void; oncreate?: (context: NewContext) => void; onmove?: (path: string, move: PlaceMove) => void } = $props()

  /** A folder. If an entry of the same name lies beside it (entities/places/gummern.yaml beside gummern/), the folder is that entry's: it is named after it and opens on its click. */
  interface Node { name: string; path: string; count: number; folders: Node[]; entries: Entry[]; entry?: Entry }
  type Item = { label: string; node: Node } | { label: string; entry: Entry }

  // What the folders are called on screen (plural). The others, the topics of the contents and the folders of the objects, are capitalized.
  const NAMES: Record<string, string> = {
    contents: 'Inhalte',
    entities: 'Entitäten',
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
  /** Entities first, then contents; the objects follow as the tree of their groups. */
  const TOP = ['entities', 'contents']

  const needle = $derived(filter.trim().toLowerCase())
  const matches = (e: Entry) => !needle || titleOf(e).toLowerCase().includes(needle) || idOf(e).includes(needle)
  const byPath = $derived(new Map(entries.map((e) => [e.path, e])))

  /** The folders the entries lie in, the entries in them. Only what matches the search; each folder counts what is below it. */
  const root = $derived.by((): Node => {
    const top: Node = { name: '', path: '', count: 0, folders: [], entries: [] }
    for (const e of entries.filter((e) => typeOf(e) !== 'object' && matches(e))) {
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

  // --- the objects: a tree of groups (an object can be in several) ---
  const tree = $derived(groupIndex(entries))
  /** With a search: the objects that match and the groups above them. */
  const visible = $derived.by((): Set<string> | undefined => {
    if (!needle) return undefined
    const found = new Set<string>()
    const add = (id: string) => {
      if (found.has(id)) return
      found.add(id)
      for (const up of tree.up.get(id) ?? []) add(up)
    }
    for (const e of tree.byId.values()) if (matches(e)) add(idOf(e))
    return found
  })
  const shown = (e: Entry) => !visible || visible.has(idOf(e))
  const childrenOf = (id: string) => (tree.members.get(id) ?? []).filter(shown)
  /** The objects below a group, each once. */
  const sizeOf = (id: string): number => {
    const seen = new Set<string>()
    const walk = (group: string) => {
      for (const m of tree.members.get(group) ?? []) if (!seen.has(idOf(m))) (seen.add(idOf(m)), walk(idOf(m)))
    }
    walk(id)
    return [...seen].filter((s) => !visible || visible.has(s)).length
  }
  const roots = $derived(tree.roots.filter(shown))
  const loose = $derived(tree.loose.filter(shown))
  const total = $derived([...tree.byId.values()].filter(shown).length)
  let objectsOpen = $state(false)
  let looseOpen = $state(true)
  let openGroups = $state<Record<string, boolean>>({})
  const groupOpen = (id: string) => (needle ? true : !!openGroups[id])

  // An object that is chosen somewhere else shows itself: the groups above it open.
  $effect(() => {
    const e = selected ? byPath.get(selected) : undefined
    if (!e || typeOf(e) !== 'object') return
    objectsOpen = true
    const seen = new Set<string>()
    const up = (id: string) => {
      for (const p of tree.up.get(id) ?? []) if (!seen.has(p)) (seen.add(p), (openGroups[p] = true), up(p))
    }
    up(idOf(e))
  })

  function pickGroup(e: Entry) {
    const id = idOf(e)
    openGroups[id] = selected === e.path ? !openGroups[id] : true
    onselect(e.path)
  }

  // An entry that is chosen somewhere else (a link, a new entry) is shown: its folders open.
  $effect(() => {
    if (!selected) return
    const parts = selected.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) opened[parts.slice(0, i).join('/')] = true
  })

  /** A click on a folder opens and closes it; if it has an entry, the first click also chooses that. */
  // --- moving a place: it is dragged onto the place it is to lie in (a street, a square, a locality), onto the folder "sonstige" of one, or onto "Orte" ---
  let dragging = $state<string>()
  /** Where the dragged place would go if it were dropped here: the key of the row it is over, and whether it would be its sibling (dropped at its edge) or lie in it. */
  let over = $state<string>()
  let overBeside = $state<false | 'top' | 'bottom'>(false)
  let openTimer: ReturnType<typeof setTimeout> | undefined
  const dragged = $derived(dragging ? byPath.get(dragging) : undefined)

  /** What a folder is as a target: its own place, else (the folder "sonstige") the place above it, else "Orte". */
  function targetOf(node: Node, holder?: Entry): DropTarget | undefined {
    if (node.entry) return holds(node.entry) ? { parent: node.entry } : undefined
    if (node.name === 'sonstige') return holds(holder) ? { parent: holder, other: true } : holder ? undefined : { other: true } // of a place, or the one under "Orte"
    if (node.path === 'entities/places') return {}
    return undefined
  }
  const movableOf = (e?: Entry) => canMove && !!e && typeOf(e) === 'place'
  /**
   * What a row is as a target at the place of the pointer: in the middle of a place that holds others, the place itself (the dragged one
   * lies in it); at its upper or lower edge, and anywhere on a place that holds none, the place it lies in (the dragged one becomes its sibling).
   */
  function aim(event: DragEvent, primary: DropTarget | undefined, own: Entry | undefined): { target: DropTarget | undefined; beside: false | 'top' | 'bottom' } {
    const beside = siblingTarget(own, entries)
    if (!beside) return { target: primary, beside: false }
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const at = box.height > 0 ? (event.clientY - box.top) / box.height : 0.5
    if (primary && at >= 0.28 && at <= 0.72) return { target: primary, beside: false }
    return { target: beside, beside: at < 0.5 ? 'top' : 'bottom' }
  }
  const dragProps = (e: Entry | undefined) => (movableOf(e) ? { draggable: true } : {})

  function start(event: DragEvent, e: Entry) {
    if (!event.dataTransfer) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', e.path)
    dragging = e.path
  }
  function end() {
    dragging = undefined
    over = undefined
    clearTimeout(openTimer)
  }
  /** Over a row that can take the dragged place: it shows that, and a closed folder opens after a moment. */
  function hover(event: DragEvent, key: string, primary: DropTarget | undefined, own: Entry | undefined, node?: Node) {
    const { target, beside } = aim(event, primary, own)
    if (!dragged || !target || !placeMove(dragged, target, entries)) {
      if (over === key) over = undefined
      return
    }
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    if (over !== key || overBeside !== beside) {
      over = key
      overBeside = beside
      clearTimeout(openTimer)
      if (!beside && node && node.folders.length + node.entries.length > 0 && !isOpen(node.path)) openTimer = setTimeout(() => (opened[node.path] = true), 700)
    }
  }
  function drop(event: DragEvent, primary: DropTarget | undefined, own: Entry | undefined) {
    event.preventDefault()
    const { target } = aim(event, primary, own)
    const move = dragged && target ? placeMove(dragged, target, entries) : undefined
    const path = dragging
    end()
    if (move && path) onmove?.(path, move)
  }

  function pick(node: Node) {
    if (!node.entry) return toggle(node.path)
    opened[node.path] = selected === node.entry.path ? !opened[node.path] : true
    onselect(node.entry.path)
  }
</script>

{#snippet plus(context: NewContext | undefined, what: string)}
  {#if oncreate && context}<button class="plus" title="Neu: {what}" aria-label="Neu anlegen: {what}" onclick={() => oncreate(context)}>+</button>{/if}
{/snippet}

{#snippet group(e: Entry, depth: number, above: string[])}
  {@const id = idOf(e)}
  <div class="row" class:active={selected === e.path}>
    <button class="entry" style:padding-left="{depth * 14 + 4}px" onclick={() => pickGroup(e)} aria-expanded={groupOpen(id)}>
      <span class="what"><span class="t">{titleOf(e)}</span></span>
      {#if isDirty(e)}<span class="dot" title="Nicht gespeichert">●</span>{/if}
    </button>
    {@render plus({ type: 'object', folder: '', group: id }, titleOf(e))}
    <button class="num" tabindex="-1" aria-hidden="true" onclick={() => pickGroup(e)}>{sizeOf(id)}</button>
  </div>
  {#if groupOpen(id) && !above.includes(id)}
    {#each childrenOf(id) as child (idOf(child))}
      {#if isGroup(child)}{@render group(child, depth + 1, [...above, id])}{:else}{@render entry(child, depth + 1)}{/if}
    {/each}
  {/if}
{/snippet}

{#snippet folder(node: Node, depth: number, parentLabel?: string, holder?: Entry)}
  {@const own = node.entry}
  {@const below = holds(own) ? own : holder}
  {@const target = targetOf(node, holder)}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="row" class:active={own && selected === own.path} class:drop={over === node.path && !overBeside} class:beside-top={over === node.path && overBeside === 'top'} class:beside-bottom={over === node.path && overBeside === 'bottom'} style:--indent="{depth * 14 + 4}px" class:dragging={own && dragging === own.path} {...dragProps(own)} ondragstart={(e) => own && start(e, own)} ondragend={end} ondragover={(e) => hover(e, node.path, target, own, node)} ondragleave={() => over === node.path && (over = undefined)} ondrop={(e) => drop(e, target, own)}>
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
  {@const target = holds(e) ? { parent: e } : undefined}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="row" class:active={selected === e.path} class:drop={over === e.path && !overBeside} class:beside-top={over === e.path && overBeside === 'top'} class:beside-bottom={over === e.path && overBeside === 'bottom'} style:--indent="{depth * 14 + 4}px" class:dragging={dragging === e.path} {...dragProps(e)} ondragstart={(ev) => start(ev, e)} ondragend={end} ondragover={(ev) => hover(ev, e.path, target, e)} ondragleave={() => over === e.path && (over = undefined)} ondrop={(ev) => drop(ev, target, e)}>
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
  {/each}
  {#if tree.byId.size > 0 || !needle}
    {#if total > 0 || !needle}
      <div class="row">
        <button class="folder" onclick={() => (objectsOpen = !objectsOpen)} aria-expanded={needle ? true : objectsOpen}>
          <span class="what"><span class="t">Objekte</span></span>
        </button>
        {@render plus({ type: 'object', folder: '' }, 'Objekte')}
        <button class="num" tabindex="-1" aria-hidden="true" onclick={() => (objectsOpen = !objectsOpen)}>{total}</button>
      </div>
      {#if needle || objectsOpen}
        {#each roots as g (idOf(g))}{@render group(g, 1, [])}{/each}
        {#if loose.length > 0}
          <div class="row">
            <button class="folder" style:padding-left="18px" onclick={() => (looseOpen = !looseOpen)} aria-expanded={looseOpen}>
              <span class="what"><span class="t">Ohne Gruppe</span></span>
            </button>
            <button class="num" tabindex="-1" aria-hidden="true" onclick={() => (looseOpen = !looseOpen)}>{loose.length}</button>
          </div>
          {#if looseOpen}{#each loose as e (idOf(e))}{#if isGroup(e)}{@render group(e, 2, [])}{:else}{@render entry(e, 2)}{/if}{/each}{/if}
        {/if}
      {/if}
    {/if}
  {/if}
  {#if needle && root.folders.length === 0 && total === 0}<p class="muted pad">Nichts gefunden.</p>{/if}
</div>

<style>
  .tree { padding: 4px 6px 12px; overflow: auto; flex: 1; min-height: 0; }
  .row { display: flex; align-items: center; border-radius: 6px; }
  .row:hover { background: var(--wash); }
  .row.active { background: var(--accent-wash); color: var(--accent); }
  .row.drop { background: var(--accent-wash); outline: 2px solid var(--accent); outline-offset: -2px; }
  /* Dropped beside a place: a line with a small circle at its start, at the edge of the row (as in a list in the Finder). */
  .row { position: relative; }
  .row.beside-top::after, .row.beside-bottom::after { content: ''; position: absolute; left: var(--indent); right: 0; height: 2px; background: var(--accent); pointer-events: none; }
  .row.beside-top::before, .row.beside-bottom::before { content: ''; position: absolute; left: calc(var(--indent) - 5px); width: 6px; height: 6px; border: 2px solid var(--accent); border-radius: 50%; background: var(--paper); pointer-events: none; z-index: 1; }
  .row.beside-top::after { top: -1px; }
  .row.beside-top::before { top: -4px; }
  .row.beside-bottom::after { bottom: -1px; }
  .row.beside-bottom::before { bottom: -4px; }
  .row.dragging { opacity: 0.45; }
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
