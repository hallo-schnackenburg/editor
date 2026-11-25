<script lang="ts">
  import { onMount } from 'svelte'
  import { MODEL, setField, type TextRole } from '@contents-editor/core'
  import { excludedTargets, fieldOfIssue, issueText, nameFieldOf, setRole, setValue, titleOf, typeOf, type FieldKind } from './logic.js'
  import type { Workspace } from './workspace.svelte.js'
  import RefField from './RefField.svelte'
  import LinksField from './LinksField.svelte'
  import LocationField from './LocationField.svelte'
  import DatesField from './DatesField.svelte'
  import RuleField from './RuleField.svelte'
  import FilesField from './FilesField.svelte'
  import TextRoles from './TextRoles.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'

  let { ws, ondone, onrenamed }: { ws: Workspace; ondone: () => void; onrenamed?: (path: string) => void } = $props()

  // The entry is fixed for the life of this form (Main keys it by path); its text changes.
  const entry = $derived(ws.selected!)
  const type = $derived(typeOf(entry))
  const model = $derived(type ? MODEL.types[type] : undefined)
  const dirty = $derived(ws.dirty.some((e) => e.path === entry.path))
  let view = $state<'form' | 'yaml'>('form')
  const shown = $derived(model && entry.data ? view : 'yaml')

  // The editor's own findings, and what the server refused with (the same ones, when it did).
  const all = $derived([...ws.issues, ...ws.refused.filter((r) => !ws.issues.some((i) => i.path === r.path && i.message === r.message))])
  const forField = (name: string) => all.filter((i) => fieldOfIssue(i) === name)
  const general = $derived(all.filter((i) => !model || !fieldOfIssue(i) || !(fieldOfIssue(i)! in model.fields)))
  const editable = $derived(ws.editable)

  const data = (name: string): any => entry.data?.[name]
  // What a kind of object decides: the fields that apply (`applies`), and the subtypes it has.
  type Part = { label: string; kind: string; ref?: readonly string[]; single?: boolean }
  const partsOf = (field: unknown) => Object.entries((field as { parts?: Record<string, Part> }).parts ?? {})
  const applies = (field: unknown) => {
    const kinds = (field as { applies?: readonly string[] }).applies
    return !kinds || kinds.includes(String(data('kind')))
  }
  const kinds = $derived((model as { kinds?: Record<string, { label: string; subtypes: Record<string, string> }> } | undefined)?.kinds)
  // A group has no files of its own.
  const noFiles = $derived((kinds?.[String(data('kind'))] as { files?: { max?: number } } | undefined)?.files?.max === 0 && data('storage') !== 'external')
  const subtypes = $derived(kinds?.[String(data('kind'))]?.subtypes ?? {})
  // The subtype belongs to the kind: when the kind changes, a subtype of the old one goes.
  function setKind(value: string) {
    const first = setField(entry.text, 'kind', value || undefined, entry.data?.kind)
    if (!first.ok) return
    let text = first.text
    const old = entry.data?.subtype
    if (typeof old === 'string' && !(old in (kinds?.[value]?.subtypes ?? {}))) {
      const second = setField(text, 'subtype', undefined, old)
      if (second.ok) text = second.text
    }
    ws.edit(text)
  }
  function setSubtype(value: string) {
    const result = setField(entry.text, 'subtype', value || undefined, entry.data?.subtype)
    if (result.ok) ws.edit(result.text)
  }
  const setPart = (name: string, part: string, value: unknown) => set(name, 'group', { ...(data(name) ?? {}), [part]: value })
  const set = (name: string, kind: FieldKind, value: unknown) => ws.edit(setValue(entry, name, kind, value))
  // An event that is not recurring has neither a schedule nor a rule: they go when "wiederkehrend" is switched off.
  function setFlag(name: string, on: boolean) {
    set(name, 'boolean', on)
    if (type === 'event' && name === 'recurring' && !on) {
      if (data('schedule') !== undefined) set('schedule', 'string', '')
      if (data('rule') !== undefined) set('rule', 'rule', { rrule: '', start: '' })
    }
  }

  // While the name is typed, the file is only shown as it will be; the entry itself moves with "Fertig".
  const labelField = $derived(type ? nameFieldOf(type) : undefined)
  const preview = $derived(ws.previewRename())
  const shownPath = $derived(preview.path ?? entry.path)
  const nameError = $derived(preview.error)

  // A new entry comes with a name to be replaced: the cursor is there, with the name selected.
  onMount(() => {
    if (entry.sha !== undefined || !labelField) return
    const input = document.getElementById(`f-${labelField}`)
    if (input instanceof HTMLInputElement) {
      input.focus()
      input.select()
    }
  })

  async function done() {
    if (await ws.finish((count) => confirm(`Das Umbenennen verschiebt ${count} Einträge und schreibt die Verweise darauf um. Fortfahren?`), { wait: false })) ondone()
  }

  let deleting = $state(false)
  const references = $derived(deleting ? ws.referencesTo(entry.path) : 0)

  async function remove() {
    deleting = false
    if (await ws.remove()) ondone()
  }

</script>

<article>
  <header>
    <div class="title">
      <h1>{entry.sha === undefined && model && labelField && !entry.data?.[labelField] ? `Neu: ${model.label}` : titleOf(entry)}</h1>
      <div class="muted"><span>{model?.label ?? 'Unbekannter Typ'}</span> · <span class="mono">{shownPath}</span></div>
    </div>
    <div class="actions">
      <button onclick={() => { const gone = entry.sha === undefined; ws.revert(); if (gone) ondone() }} disabled={!dirty || !editable}>Verwerfen</button>
      <button class="danger" onclick={() => (deleting = true)} disabled={!editable}>Löschen</button>
      <button class="primary" onclick={done}>Fertig</button>
    </div>
  </header>

  <nav>
    <button class:on={shown === 'form'} onclick={() => (view = 'form')} disabled={!model || !entry.data}>Formular</button>
    <button class:on={shown === 'yaml'} onclick={() => (view = 'yaml')}>YAML</button>
    {#if entry.sha === undefined}<span class="muted new">neu</span>{:else if dirty}<span class="muted new">geändert</span>{/if}
  </nav>

  <!-- The general findings are not shown for now (too technical); a save that is refused says so. -->
  {#if false && general.length}
    <ul class="error-box issues">
      {#each general as issue}<li><span class="mono">{issue.path}</span> {issue.message}</li>{/each}
    </ul>
  {/if}

  {#if shown === 'yaml'}
    <textarea class="mono yaml" spellcheck="false" readonly={!editable} value={entry.text} oninput={(event) => ws.edit(event.currentTarget.value)}></textarea>
  {:else if model}
    <fieldset class="fields" disabled={!editable}>
      {#if type === 'place'}
        <div class="field">
          <label for="f-folder">Ordner</label>
          <select id="f-folder" value={ws.folderOpen} onchange={(event) => ws.setFolder(event.currentTarget.value)}>
            <option value="">Orte</option>
            {#each ws.folderChoices('place') as folder}<option value={folder} selected={folder === ws.folderOpen}>{ws.folders[`entities/places/${folder}`] ? `${ws.folders[`entities/places/${folder}`]} (${folder})` : folder.replace(/(^|\/)(.)/g, (_, sep, c) => sep + c.toUpperCase())}</option>{/each}
          </select>
          {#if nameError}<div class="issue">{nameError}</div>{/if}
        </div>
      {/if}
      {#each Object.entries(model.fields) as [name, field] (name)}
        {@const kind = field.kind as FieldKind}
        {#if !(type === 'event' && (name === 'schedule' || name === 'rule') && data('recurring') !== true) && applies(field) && !(name === 'files' && noFiles)}
        <div class="field" class:bad={forField(name).length > 0}>
          {#if kind !== 'text'}
            <label for={`f-${name}`}>{field.label}{#if field.required}<span class="req" title="Pflichtfeld"> *</span>{/if}</label>
          {/if}
          {#if kind === 'string' && (field as { multiline?: boolean }).multiline}
            <textarea id={`f-${name}`} rows="5" value={data(name) ?? ''} oninput={(event) => set(name, kind, event.currentTarget.value)}></textarea>
          {:else if kind === 'string'}
            <input id={`f-${name}`} type="text" value={data(name) ?? ''} oninput={(event) => set(name, kind, event.currentTarget.value)} />
          {:else if kind === 'choice'}
            <select id={`f-${name}`} value={data(name) ?? ''} onchange={(event) => (name === 'kind' && kinds ? setKind(event.currentTarget.value) : set(name, 'string', event.currentTarget.value))}>
              <option value="">–</option>
              {#each Object.entries((field as { options?: Record<string, string> }).options ?? {}) as [value, label]}<option {value}>{label}</option>{/each}
            </select>
          {:else if kind === 'date'}
            <input id={`f-${name}`} type="date" value={data(name) ?? ''} oninput={(event) => set(name, kind, event.currentTarget.value)} />
          {:else if kind === 'boolean'}
            <input id={`f-${name}`} type="checkbox" checked={data(name) === true} onchange={(event) => setFlag(name, event.currentTarget.checked)} />
          {:else if kind === 'ref'}
            {#if (field as { single?: boolean }).single}
              <!-- One id, a string: the same chooser, with room for one. -->
              <RefField value={data(name) ? [data(name)] : []} targets={(field as { ref: readonly string[] }).ref} max={1} entries={ws.entries} exclude={excludedTargets(entry, name, ws.entries)} onchange={(ids) => set(name, 'string', ids[0] ?? '')} />
            {:else}
              <RefField value={data(name) ?? []} targets={(field as { ref: readonly string[] }).ref} max={(field as { max?: number }).max} entries={ws.entries} exclude={excludedTargets(entry, name, ws.entries)} onchange={(ids) => set(name, kind, ids)} />
            {/if}
          {:else if kind === 'links'}
            <LinksField value={data(name) ?? []} onchange={(links) => set(name, kind, links)} />
          {:else if kind === 'location'}
            <LocationField value={data(name)} onchange={(value) => set(name, kind, value)} />
          {:else if kind === 'dates'}
            <DatesField value={data(name) ?? []} onchange={(dates) => set(name, kind, dates)} />
          {:else if kind === 'rule'}
            <RuleField value={data(name)} onchange={(rule) => set(name, kind, rule)} />
          {:else if kind === 'text'}
            <TextRoles value={data(name) ?? {}} onchange={(role: TextRole, text: string) => ws.edit(setRole(entry, role, text))} />
          {:else if kind === 'group'}
            <div class="parts">
              {#each partsOf(field) as [part, spec] (part)}
                <div class="part">
                  <label for={`f-${name}-${part}`}>{spec.label}</label>
                  {#if spec.kind === 'ref' && spec.single}
                    <RefField value={data(name)?.[part] ? [data(name)[part]] : []} targets={spec.ref ?? []} max={1} entries={ws.entries} exclude={[]} onchange={(ids) => setPart(name, part, ids[0] ?? '')} />
                  {:else if spec.kind === 'ref'}
                    <RefField value={data(name)?.[part] ?? []} targets={spec.ref ?? []} entries={ws.entries} exclude={[]} onchange={(ids) => setPart(name, part, ids)} />
                  {:else}
                    <input id={`f-${name}-${part}`} type="text" value={data(name)?.[part] ?? ''} oninput={(event) => setPart(name, part, event.currentTarget.value)} />
                  {/if}
                </div>
              {/each}
            </div>
          {:else if kind === 'files'}
            <FilesField value={data(name) ?? []} kind={String(data('kind'))} external={data('storage') === 'external'} base={ws.user?.files} upload={(...args) => ws.upload(...args)} onchange={(files) => set(name, 'files', files)} />
          {:else}
            <span class="muted">Dieses Feld lässt sich nur im YAML ändern.</span>
          {/if}
          {#each forField(name) as issue}<div class="issue">{issueText(issue.message)}</div>{/each}
          {#if nameError && name === labelField && type !== 'place'}<div class="issue">{nameError}</div>{/if}
        </div>
        {#if name === 'kind' && Object.keys(subtypes).length > 0}
          <div class="field" class:bad={all.some((i) => i.path === '/subtype')}>
            <label for="f-subtype">Untertyp</label>
            <select id="f-subtype" value={data('subtype') ?? ''} onchange={(event) => setSubtype(event.currentTarget.value)}>
              <option value="">–</option>
              {#each Object.entries(subtypes) as [value, label]}<option {value}>{label}</option>{/each}
            </select>
            {#each all.filter((i) => i.path === '/subtype') as issue}<div class="issue">{issueText(issue.message)}</div>{/each}
          </div>
        {/if}
        {/if}
      {/each}
    </fieldset>
  {/if}
</article>

{#if deleting}
  <ConfirmDialog
    title="„{titleOf(entry)}“ löschen?"
    text={references > 0 ? `${references === 1 ? 'Ein Eintrag verweist' : `${references} Einträge verweisen`} darauf. Die Verweise werden entfernt.` : ''}
    confirm="Löschen"
    danger
    onconfirm={remove}
    oncancel={() => (deleting = false)}
  />
{/if}

<style>
  article { padding: 16px 20px 40px; max-width: 54rem; }
  header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  h1 { margin: 0 0 2px; font-size: 1.35rem; }
  .actions { display: flex; gap: 8px; flex-shrink: 0; }
  nav { display: flex; gap: 6px; align-items: center; margin: 14px 0; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
  nav button { border: 0; background: none; padding: 4px 10px; border-radius: 6px; }
  nav button.on { background: var(--accent-wash); color: var(--accent); }
  .new { margin-left: 8px; font-size: 13px; }
  .issues { margin: 0 0 14px; padding: 8px 12px 8px 28px; }
  .fields { display: flex; flex-direction: column; gap: 16px; border: 0; padding: 0; margin: 0; min-width: 0; }
  .field > label { display: block; font-weight: 600; margin-bottom: 4px; }
  .req { color: var(--bad); }
  .issue { color: var(--bad); font-size: 13px; margin-top: 3px; }
  .field.bad input[type='text'], .field.bad input[type='date'], .field.bad select { border-color: var(--bad); }
  .parts { display: flex; flex-direction: column; gap: 10px; padding-left: 12px; border-left: 2px solid var(--line); }
  .part > label { display: block; font-weight: 500; margin-bottom: 3px; }
  .yaml { min-height: 28rem; }
  input[type='checkbox'] { width: auto; }
  select { width: auto; min-width: 12rem; }
</style>
