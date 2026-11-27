<script lang="ts">
  import { untrack } from 'svelte'
  import { MODEL, TEXT_ROLES, type EntryType } from '@editor/core'
  import { idOf, nextDates, refsIn, shownTitle, titleOf, typeOf, whenText, type Entry, type NewContext, type PlaceMove } from './logic.js'
  import { ruleText } from './ruletext.js'
  import Chat from './Chat.svelte'
  import Splitter from './Splitter.svelte'
  import EntryForm from './EntryForm.svelte'
  import NewForm from './NewForm.svelte'
  import TopicForm from './TopicForm.svelte'
  import LeaveDialog from './LeaveDialog.svelte'
  import SubmissionDetail from './SubmissionDetail.svelte'
  import SubmissionsPane from './SubmissionsPane.svelte'
  import Tree from './Tree.svelte'
  import { formatRoute, parseRoute, sameStep, type Route } from './route.js'
  import type { Workspace } from './workspace.svelte.js'

  let { ws }: { ws: Workspace } = $props()

  const types = Object.keys(MODEL.types) as EntryType[]
  let filter = $state('')
  /** A submission is open: its details are shown in the middle instead of an entry. */
  const reviewing = $derived(ws.review.detailOpen && ws.review.selected !== undefined)
  /** Where a new entry is being made (the "+" at a folder): the form for it is shown instead of an entry. */
  let creating = $state<NewContext>()
  /** The entry that is open in the form (else it is shown to read); its path follows when the entry is renamed. */
  let editingPath = $state<string>()
  /** The entry whose YAML is shown (to read) instead of its fields. */
  let yamlPath = $state<string>()
  $effect(() => {
    ws.formOpen = !!creating || (!!selected && !!model && editingPath === selected.path && ws.editable)
    return () => (ws.formOpen = false)
  })
  /** The form stays as it is while its entry is renamed (and keeps the focus where it is going), and starts afresh for another entry. */
  let editingKey = $state(0)
  /** The new entry in the form that has something typed and is not saved: leaving it asks first. */
  let leaving = $state<() => void>()
  const unsaved = $derived(ws.selected && editingPath === ws.selected.path && ws.editable && ws.isNew(ws.selected.path) && !ws.isUntouched(ws.selected.path) ? ws.selected : undefined)
  const leave = (next: () => void) => (unsaved ? void (leaving = next) : next())

  const show = (path: string | undefined) => {
    creating = undefined
    yamlPath = undefined
    ws.review.detailOpen = false
    ws.select(path)
  }
  const pick = (path: string | undefined) => {
    if (path !== ws.selectedPath) leave(() => show(path))
  }
  const edit = (path: string) => {
    if (path === ws.selectedPath && editingPath === path) return
    leave(() => {
      show(path)
      editingPath = path
      editingKey++
    })
  }

  /**
   * The "+" at a folder: the entry is made at once, with a name to be replaced, and opens in the same form as any entry (the person
   * types the name there; "Verwerfen" takes it back). Objects (they need a type) and a new topic still ask first.
   */
  /** A place was dragged onto another: it moves there (and is saved), or the reason it did not is shown. */
  async function movePlace(path: string, move: PlaceMove) {
    ws.review.detailOpen = false
    creating = undefined
    editingPath = undefined
    const error = await ws.movePlace(path, move, (count) => confirm(`Das Verschieben bewegt ${count} Einträge und schreibt die Verweise darauf um. Fortfahren?`))
    if (error) ws.error = error
  }

  function create(context: NewContext) {
    leave(() => make(context))
  }

  function make(context: NewContext) {
    ws.review.detailOpen = false
    if (!ws.editable) return void (creating = undefined)
    const type = context.type
    if (type === undefined || type === 'object' || (type === 'content' && context.folder === '')) return void (creating = context)
    try {
      ws.create(type, 'Neu', context.folder, { parent: context.parent, kind: context.kind, numbered: true, placeholder: true })
      creating = undefined
      editingPath = ws.selectedPath
      editingKey++
    } catch (error) {
      ws.error = (error as Error).message
    }
  }

  // The address: where the person is shows in it (every step is one in the history of the browser), and an address (typed, passed on,
  // back and forward) brings the person there. What the address says is the same for everybody.
  const current = $derived<Route>({
    submission: ws.branch === undefined ? undefined : ws.active?.number,
    ...(creating
      ? { view: 'new' as const, context: creating }
      : reviewing || (ws.branch !== undefined && !ws.selectedPath)
        ? { view: 'details' as const, focus: ws.review.focus }
        : ws.selectedPath
          ? { view: editingPath === ws.selectedPath && ws.editable ? ('edit' as const) : yamlPath === ws.selectedPath ? ('yaml' as const) : ('entry' as const), path: ws.selectedPath }
          : { view: 'none' as const }),
  })
  /** The first place is settled (the address that was opened with); until then the address is left as it is. */
  let ready = $state(false)
  /** An address is being applied (it may take a while to switch): what is passing through is not written to the address. */
  let applying = $state(false)
  let last: Route | undefined

  /** The middle as a route says it (the submission is the right one already). */
  function middle(route: Route) {
    const wrong = (message: string) => {
      ws.error = message
      creating = undefined
      editingPath = undefined
      ws.review.detailOpen = ws.branch !== undefined
    }
    if (route.view === 'new' && route.context) {
      editingPath = undefined
      make(route.context)
    } else if ((route.view === 'entry' || route.view === 'edit' || route.view === 'yaml') && route.path) {
      if (ws.entries.length > 0 && !ws.entries.some((e) => e.path === route.path)) return wrong('Diesen Eintrag gibt es nicht (mehr).')
      if (route.view === 'edit' && !ws.editable) route = { ...route, view: 'entry' }
      creating = undefined
      editingPath = undefined
      show(route.path)
      if (route.view === 'edit') {
        editingPath = route.path
        editingKey++
      } else if (route.view === 'yaml') yamlPath = route.path
    } else if (route.view === 'details' && ws.branch !== undefined) {
      creating = undefined
      editingPath = undefined
      ws.review.detailOpen = true
      ws.review.focus = route.focus
    } else {
      creating = undefined
      editingPath = undefined
      show(undefined)
    }
  }

  async function apply(route: Route) {
    applying = true
    try {
      const have = ws.branch === undefined ? undefined : ws.active?.number
      if (route.submission !== have) {
        const target = route.submission === undefined ? undefined : ws.submissions.find((c) => c.number === route.submission && (c.state === 'draft' || c.state === 'submitted'))
        if (route.submission !== undefined && !target) {
          ws.error = `Die Einreichung #${route.submission} gibt es nicht oder sie ist abgeschlossen.`
          route = { view: 'none' }
        }
        // What is not saved asks first (and the address goes back to where the person is).
        if (!(await (target ? ws.work(target) : ws.switchTo(undefined)))) return
      }
      leave(() => middle(route))
    } finally {
      applying = false
      history.replaceState(null, '', formatRoute(current))
    }
  }

  // Back and forward.
  $effect(() => {
    const onPop = () => {
      const route = parseRoute(location.hash)
      if (route && ws.started) void apply(route)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  })

  // The address the page was opened with: what the start could not do by itself (the form of an entry, the form for a new one) is done here.
  $effect(() => {
    if (!ws.started || ready) return
    untrack(() => {
      const route = ws.route
      ws.route = undefined
      if (route && (route.view === 'edit' || route.view === 'new' || route.path)) middle(route)
      ready = true
    })
  })

  // Every step of the person is one in the history; what the app does by itself (the first address, a draft getting its number, a rename) replaces the entry.
  $effect(() => {
    const route = current
    if (!ready || applying) return
    const hash = formatRoute(route)
    if (hash !== location.hash && !(hash === '#/' && (location.hash === '' || location.hash === '#'))) {
      history[last === undefined || sameStep(last, route) ? 'replaceState' : 'pushState'](null, '', hash)
    } else if (hash === '#/' && location.hash === '') history.replaceState(null, '', hash)
    last = route
    try {
      sessionStorage.setItem('contents-editor:address', hash)
    } catch {
      // not kept
    }
  })

  // The sizes of the panes, which the borders between them change; kept for this browser (the storage may be missing or full).
  const LAYOUT = 'contents-editor.layout'
  const SIDE_MIN = 240
  const CENTER_MIN = 384
  const CHAT_MIN = 160
  const stored = (() => {
    try {
      return JSON.parse(localStorage.getItem(LAYOUT) ?? '{}') as Record<string, unknown>
    } catch {
      return {}
    }
  })()
  const size = (value: unknown, fallback: number) => (typeof value === 'number' && value > 0 ? value : fallback)
  let left = $state(size(stored.left, 352))
  let right = $state(size(stored.right, 448))
  let chatHeight = $state(size(stored.chat, 260))
  let chatOpen = $state(stored.chat_open !== false)
  let width = $state(window.innerWidth)
  let height = $state(window.innerHeight)
  // The middle keeps at least what a form needs; the panes at the sides keep at least what a list needs.
  const leftMax = $derived(width - 56 - right - CENTER_MIN)
  const rightMax = $derived(width - 56 - left - CENTER_MIN)
  const chatMax = $derived(height * 0.7)
  $effect(() => {
    try {
      localStorage.setItem(LAYOUT, JSON.stringify({ left, right, chat: chatHeight, chat_open: chatOpen }))
    } catch {
      // not kept; the sizes stay as they are for now
    }
  })

  // The assistant changed or made an entry: its form opens, so that the changes are seen and finished with "Fertig".
  $effect(() => {
    const path = ws.openForm
    if (!path) return
    untrack(() => {
      ws.openForm = undefined
      if (ws.entries.some((e) => e.path === path) && (editingPath !== path || creating)) edit(path)
    })
  })

  // The entries as the browser sees them: parsed once, with what points at each of them.
  const index = $derived.by(() => {
    const byId = new Map<string, Entry>()
    const back = new Map<string, Entry[]>()
    for (const e of ws.entries) byId.set(idOf(e), e)
    for (const e of ws.entries) for (const id of refsIn(e)) back.set(id, [...(back.get(id) ?? []), e])
    return { byId, back }
  })

  /** A second line for the list: what tells entries of one type apart. */
  function hint(e: Entry): string {
    const d = e.data ?? {}
    const type = typeOf(e)
    if (type === 'content') return typeof d.published === 'string' ? d.published : ''
    if (type === 'place') return typeof d.address === 'string' ? d.address : ''
    if (type === 'object') return [MODEL.types.object.subtypes[d.subtype as keyof typeof MODEL.types.object.subtypes] ?? MODEL.types.object.kinds[d.kind as keyof typeof MODEL.types.object.kinds]?.label, d.date].filter(Boolean).join(' · ')
    return ''
  }

  const selected = $derived(ws.selected)
  const type = $derived(selected ? typeOf(selected) : undefined)
  const model = $derived(type ? MODEL.types[type] : undefined)
  const links = $derived((selected && index.back.get(idOf(selected))) || [])
  const incoming = $derived(types.map((t) => ({ type: t, entries: links.filter((e) => typeOf(e) === t) })).filter((g) => g.entries.length > 0))

  const roleLabel = (role: string) => MODEL.textRoles[role as keyof typeof MODEL.textRoles]?.label ?? role
  const fmtBytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`)
  const open = (id: string) => {
    const target = index.byId.get(id)
    if (target) ws.select(target.path)
  }
  let role = $state<string>()
  const roles = $derived(selected?.data?.text && typeof selected.data.text === 'object' ? Object.keys(selected.data.text as object) : [])
  const activeRole = $derived(role && roles.includes(role) ? role : roles[0])
</script>

<svelte:window bind:innerWidth={width} bind:innerHeight={height} />

<div class="panes" style:--left="{Math.max(SIDE_MIN, Math.min(left, leftMax))}px" style:--right="{Math.max(SIDE_MIN, Math.min(right, rightMax))}px">
  <aside>
    <div class="tools">
      <input type="text" placeholder="{ws.entries.length} Einträge durchsuchen ..." bind:value={filter} />
    </div>
    <!-- The new entry that is being made is not in the tree yet: until "Fertig" it only has its form. -->
    <Tree entries={ws.entries.filter((e) => !(ws.isNew(e.path) && e.path === ws.selectedPath))} folders={ws.folders} selected={ws.selectedPath} {filter} {hint} repeating={(e) => typeOf(e) === 'event' && e.data?.recurring === true} canMove={ws.editable} onselect={pick} oncreate={create} onmove={movePlace} />
  </aside>

  <Splitter direction="vertical" value={left} min={SIDE_MIN} max={leftMax} label="Breite der Liste ändern" onchange={(v) => (left = v)} />

  <section class="detail">
    {#if reviewing}
      <SubmissionDetail {ws} onopen={edit} />
    {:else if creating?.type === 'content' && creating.folder === ''}
      <TopicForm {ws} oncancel={() => (creating = undefined)} ondone={() => (creating = undefined)} />
    {:else if creating}
      {#key creating}<NewForm {ws} context={creating} oncancel={() => (creating = undefined)} ondone={(path) => { creating = undefined; editingPath = path; editingKey++ }} />{/key}
    {:else if selected && model && editingPath === selected.path && ws.editable}
      {#key editingKey}<EntryForm {ws} ondone={() => (editingPath = undefined)} onrenamed={(path) => (editingPath = path)} />{/key}
    {:else if selected && model}
      <article>
        <header>
          <div>
            <div class="muted small">{model.label}{#if selected.data?.subtype} · {model.subtypes[selected.data.subtype as keyof typeof model.subtypes] ?? selected.data.subtype}{/if}</div>
            <h1>{titleOf(selected)}{#if selected.data?.recurring === true}<span class="recurring" title="Wiederkehrend" role="img" aria-label="Wiederkehrend">↻</span>{/if}</h1>
            <div class="muted mono small">{selected.path}</div>
          </div>
          <div class="actions">
            <button class:on={yamlPath === selected.path} onclick={() => (yamlPath = yamlPath === selected.path ? undefined : selected.path)}>YAML</button>
            {#if ws.editable}<button class="primary" onclick={() => edit(selected.path)}>Bearbeiten</button>{/if}
          </div>
        </header>

        {#if yamlPath === selected.path}
          <pre class="yaml mono">{selected.text}</pre>
        {:else}
        <dl>
          {#each Object.entries(model.fields) as [name, field]}
            {@const value = selected.data?.[name]}
            {#if value !== undefined && field.kind !== 'text' && name !== 'title' && name !== 'name' && !(name === 'recurring' && value === true)}
              <dt>{field.label}</dt>
              <dd>
                {#if field.kind === 'ref' && (Array.isArray(value) || typeof value === 'string')}
                  <span class="refs">
                    {#each [value].flat() as id}
                      {@const target = index.byId.get(id)}
                      {#if target}
                        <button class="ref" onclick={() => open(id)}>{titleOf(target)}</button>
                      {:else}
                        <span class="ref broken" title="Diesen Eintrag gibt es nicht">{id}</span>
                      {/if}
                    {/each}
                  </span>
                {:else if field.kind === 'links' && Array.isArray(value)}
                  {#each value as l}<div><a href={l.url} title={l.url} target="_blank" rel="noreferrer">{l.label}</a></div>{/each}
                {:else if field.kind === 'dates' && Array.isArray(value)}
                  {#each value.filter((d) => d && typeof d === 'object') as d}
                    <div class:cancelled={d.cancelled}>{whenText(d.start)}{#if d.end} – {whenText(d.end)}{/if}{#if d.note} <span class="muted small">{d.note}</span>{/if}{#if d.cancelled} <span class="muted small">ausgefallen</span>{/if}</div>
                  {/each}
                {:else if field.kind === 'rule' && typeof value === 'object' && value}
                  {@const rule = value as { rrule: string; start: string }}
                  {@const sentence = typeof rule.rrule === 'string' ? ruleText(rule.rrule) : undefined}
                  {#if sentence}<div>{sentence}</div>{:else}<div class="mono">{typeof rule.rrule === 'string' ? rule.rrule : ''}</div>{/if}
                  <div class="muted small">ab {whenText(rule.start)}</div>
                  {#each nextDates(rule) as when}<div>{whenText(when)}</div>{/each}
                {:else if field.kind === 'location'}
                  <span>{(value as { lat: number; lon: number }).lat}, {(value as { lat: number; lon: number }).lon}</span>
                {:else if field.kind === 'choice'}
                  {(field as { options?: Record<string, string> }).options?.[String(value)] ?? String(value)}
                {:else if field.kind === 'boolean'}
                  {value ? 'Ja' : 'Nein'}
                {:else if field.kind === 'files' && Array.isArray(value)}
                  {#each value as f}
                    <div class="file">
                      <span class="mono small">{f.original_name ?? f.path.split('/').pop()}</span>
                      <span class="muted small">{f.mime} · {fmtBytes(f.bytes)}{#if f.width} · {f.width}×{f.height}{/if}{#if f.variants?.length} · {f.variants.length} Variante{f.variants.length > 1 ? 'n' : ''}{/if}</span>
                    </div>
                  {/each}
                {:else}
                  {String(value)}
                {/if}
              </dd>
            {/if}
          {/each}
        </dl>
        {/if}

        {#if roles.length > 0}
          <div class="texts">
            <div class="tabs">
              {#each TEXT_ROLES as r}
                {#if roles.includes(r)}<button class:on={activeRole === r} onclick={() => (role = r)}>{roleLabel(r)}</button>{/if}
              {/each}
              {#each TEXT_ROLES.filter((r) => !roles.includes(r)) as r}<span class="missing" title="Fehlt; wird aus einer anderen Rolle abgeleitet, wenn möglich">{roleLabel(r)}</span>{/each}
            </div>
            <div class="body">{(selected.data!.text as Record<string, string>)[activeRole!]}</div>
          </div>
        {/if}

        {#if incoming.length > 0}
          <div class="incoming">
            <h2>Verweise hierher</h2>
            {#each incoming as g}
              <h3>{MODEL.types[g.type].label}</h3>
              <div class="refs">
                {#each g.entries as e (e.path)}
                  <button class="ref" onclick={() => ws.select(e.path)}>{titleOf(e)}</button>
                {/each}
              </div>
            {/each}
          </div>
        {/if}
      </article>
    {/if}
  </section>

  <Splitter direction="vertical" value={right} min={SIDE_MIN} max={rightMax} invert label="Breite der Änderungen ändern" onchange={(v) => (right = v)} />

  <div class="side">
    <SubmissionsPane {ws} onopen={() => (creating = undefined)} />
    {#if chatOpen}
      <Splitter direction="horizontal" value={chatHeight} min={CHAT_MIN} max={chatMax} invert label="Höhe des Chats ändern" onchange={(v) => (chatHeight = v)} />
    {:else}
      <div class="gap"></div>
    {/if}
    <Chat {ws} height={chatHeight} bind:open={chatOpen} />
  </div>
</div>

{#if leaving && unsaved}
  <LeaveDialog
    name={titleOf(unsaved)}
    saving={ws.saving}
    onsave={async () => {
      const next = leaving!
      if (await ws.finish(undefined, { wait: false })) {
        leaving = undefined
        next()
      }
    }}
    ondiscard={() => {
      const next = leaving!
      ws.revert()
      leaving = undefined
      next()
    }}
    oncancel={() => (leaving = undefined)}
  />
{/if}

{#if ws.switching}
  <LeaveDialog
    name={ws.unsavedWork.map(shownTitle).join(', ')}
    saving={ws.saving}
    onsave={() => void ws.answerSwitch('save')}
    ondiscard={() => void ws.answerSwitch('discard')}
    oncancel={() => void ws.answerSwitch('stay')}
  />
{/if}

<style>
  .cancelled { text-decoration: line-through; opacity: 0.6; }
  .side { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .gap { height: 12px; flex: none; }
  .panes { flex: 1; display: grid; grid-template-columns: var(--left) 12px minmax(0, 1fr) 12px var(--right); padding: 12px 16px; min-height: 0; }
  aside { background: var(--paper); border: 1px solid var(--line); border-radius: 8px; display: flex; flex-direction: column; min-height: 0; }
  .tools { padding: 10px; }
  .detail { background: var(--paper); border: 1px solid var(--line); border-radius: 8px; overflow: auto; }
  article { padding: 18px 22px 28px; max-width: 54rem; }
  .actions { display: flex; gap: 6px; flex: none; }
  .actions .on { background: var(--accent-wash); border-color: var(--accent); }
  .yaml { margin: 0; padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; background: var(--wash); border-radius: 6px; }
  article > header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 14px; }
  h1 { margin: 2px 0 4px; font-size: 1.5rem; }
  .recurring { margin-left: 10px; color: var(--muted); font-size: 1.2rem; font-weight: 400; vertical-align: 0.1em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 24px 0 6px; }
  h3 { font-size: 13px; margin: 10px 0 4px; }
  .small { font-size: 12px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 10px 14px; margin: 0; align-items: baseline; }
  dt { color: var(--muted); font-size: 13px; }
  dd { margin: 0; font-size: 14px; }
  dd a { color: var(--accent); text-decoration: none; }
  dd a:hover { text-decoration: underline; }
  .refs { display: flex; flex-wrap: wrap; gap: 6px; }
  .ref { display: inline-flex; gap: 6px; align-items: center; border-radius: 999px; padding: 2px 10px; font-size: 13px; background: var(--wash); }
  .ref.broken { color: var(--bad); background: var(--bad-wash); padding: 2px 10px; border-radius: 999px; }
  .file { display: flex; flex-direction: column; margin-bottom: 4px; }
  .texts { margin-top: 22px; }
  .tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--line); }
  .tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 5px 10px; }
  .tabs button.on { border-bottom-color: var(--accent); color: var(--accent); }
  .missing { font-size: 13px; padding: 5px 10px; color: #b9bfca; text-decoration: line-through; }
  .body { white-space: pre-wrap; padding: 12px 2px; max-width: 42rem; }
</style>