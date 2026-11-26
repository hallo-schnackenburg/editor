<script lang="ts">
  import Combobox from './Combobox.svelte'
  import { untrack } from 'svelte'
  import { MODEL, type EntryType } from '@editor/core'
  import { idOf, isGroup, newEntry, setValue, titleOf, typeOf, type NewContext } from './logic.js'
  import LinksField from './LinksField.svelte'
  import type { Workspace } from './workspace.svelte.js'

  let { ws, context, ondone, oncancel }: { ws: Workspace; context: NewContext; ondone: (path: string) => void; oncancel: () => void } = $props()

  const entityTypes = (Object.keys(MODEL.types) as EntryType[]).filter((t) => MODEL.types[t].class === 'entity')
  // What the place that was clicked suggests; the person may change all of it.
  // (The form is made anew for every click on a "+", so the first value is all that is needed.)
  const start = untrack(() => ({ ...context }))
  let type = $state<EntryType>(start.type ?? entityTypes[0])
  let label = $state('')
  let folder = $state(start.folder)
  let parent = $state(start.parent ?? '')
  let kind = $state(start.kind ?? '')
  // The type of an object (image, document, ...): it decides the files and fields, so it is chosen first.
  const objectKinds = MODEL.types.object.fields.kind.options as Record<string, string>
  let objectKind = $state(Object.keys(objectKinds)[0])
  // The group an object is in (a group may be in none: it is a root).
  let group = $state(start.group ?? '')
  const groups = $derived(ws.entries.filter(isGroup).sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'de', { numeric: true })))
  let description = $state('')
  let links = $state<{ label: string; url: string }[]>([])
  let problem = $state<string>()

  const model = $derived(MODEL.types[type])
  const isContent = $derived(model.class === 'content')
  const isObject = $derived(model.class === 'object')
  const isPlace = $derived(type === 'place')
  // The fields every entity has beside its name, so that an entry starts with them.
  const hasDescription = $derived(!isContent && !isObject && 'description' in model.fields)
  const hasLinks = $derived(!isContent && !isObject && 'links' in model.fields)

  const places = $derived(ws.entries.filter((e) => typeOf(e) === 'place').sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'de')))
  const kinds = MODEL.types.place.fields.kind.options as Record<string, string>
  const kindOf = (id: string) => kinds[String(ws.entries.find((e) => idOf(e) === id)?.data?.kind)]

  /** Where it will lie and what its id will be (not for objects: their id is a ULID). */
  const preview = $derived.by(() => {
    if (!label.trim() || isObject) return undefined
    try {
      return newEntry(type, label, folder, undefined, { taken: (id) => ws.entries.some((e) => idOf(e) === id) })
    } catch (error) {
      return { error: (error as Error).message }
    }
  })

  function submit(event: Event) {
    event.preventDefault()
    problem = undefined
    if (isObject && !group && objectKind !== 'group') return void (problem = 'Bitte eine Gruppe wählen.')
    try {
      ws.create(type, label, isObject ? '' : folder, { parent: isPlace ? parent || undefined : undefined, kind: isObject ? objectKind : isPlace ? kind || undefined : undefined, group: isObject ? group || undefined : undefined, numbered: true })
      if (hasDescription && description.trim()) ws.edit(setValue(ws.selected!, 'description', 'string', description.trim()))
      if (hasLinks && links.some((l) => l.label.trim() && l.url.trim())) ws.edit(setValue(ws.selected!, 'links', 'links', links))
      ondone(ws.selectedPath!)
    } catch (error) {
      problem = (error as Error).message
    }
  }
</script>

<form class="new" onsubmit={submit} aria-label="Neuer Eintrag">
<h1>Neu anlegen</h1>

  {#if context.type === undefined}
    <label>
      Typ
      <select bind:value={type}>{#each entityTypes as t}<option value={t}>{MODEL.types[t].label}</option>{/each}</select>
    </label>
  {:else}
    <div class="muted">{model.label}</div>
  {/if}



  <label>
    {isContent || isObject ? 'Titel' : 'Name'}
    <!-- svelte-ignore a11y_autofocus -->
    <input type="text" bind:value={label} autofocus required />
  </label>

  {#if isObject}
    <label>
      Typ
      <select bind:value={objectKind}>{#each Object.entries(objectKinds) as [value, name]}<option {value}>{name}</option>{/each}</select>
    </label>
  {/if}

  {#if isObject}
    <label>
      Gruppe
      <Combobox label="Gruppe" empty="–" value={group} options={groups.map((g) => ({ value: idOf(g), label: titleOf(g) }))} onpick={(v) => (group = v)} />
    </label>
  {/if}

  {#if isPlace}
    <label>
      Teil von
      <Combobox label="Teil von" empty="–" value={parent} options={places.map((p) => ({ value: idOf(p), label: `${titleOf(p)}${kindOf(idOf(p)) ? ` (${kindOf(idOf(p))})` : ''}` }))} onpick={(v) => (parent = v)} />
    </label>
    <label>
      Typ
      <select bind:value={kind}>
        <option value="">–</option>
        {#each Object.entries(kinds) as [value, name]}<option {value}>{name}</option>{/each}
      </select>
    </label>
  {/if}

  {#if hasDescription}
    <label>
      Beschreibung
      <textarea rows="5" bind:value={description}></textarea>
    </label>
  {/if}

  {#if hasLinks}
    <div class="field">
      <span class="lbl">Links</span>
      <LinksField value={links} onchange={(l) => (links = l)} />
    </div>
  {/if}

  {#if preview && 'error' in preview}
    <p class="muted small">{preview.error}</p>
  {:else if preview}
    <p class="muted small mono">{preview.path}<br />ID: {idOf(preview)}</p>
  {/if}

  {#if problem}<p class="error-box">{problem}</p>{/if}
  <div class="row">
    <button class="primary" type="submit">Anlegen</button>
    <button type="button" onclick={oncancel}>Abbrechen</button>
  </div>
</form>

<style>
  .new { padding: 18px 22px 28px; max-width: 34rem; display: flex; flex-direction: column; gap: 12px; }
  h1 { margin: 0; font-size: 1.35rem; }
  label { display: flex; flex-direction: column; gap: 4px; font-weight: 600; }
  .row { display: flex; gap: 8px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .lbl { font-weight: 600; }
  p { margin: 0; }
  .small { font-size: 12px; }
</style>
