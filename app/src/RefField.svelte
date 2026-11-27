<script lang="ts">
  import { MODEL, type EntryType } from '@editor/core'
  import { idOf, titleOf, typeOf, type Entry } from './logic.js'
  import Combobox from './Combobox.svelte'
  import type { Option } from './combo.js'

  let { value, targets, max, entries, exclude = [], onchange }: { value: string[]; targets: readonly string[]; max?: number; entries: Entry[]; exclude?: readonly string[]; onchange: (ids: string[]) => void } = $props()

  const byId = $derived(new Map(entries.map((e) => [idOf(e), e])))
  /** What can be added: grouped by type when there is more than one type to choose from. */
  const options = $derived<Option[]>(
    (targets as readonly EntryType[]).flatMap((type) =>
      entries
        .filter((e) => typeOf(e) === type && !value.includes(idOf(e)) && !exclude.includes(idOf(e)))
        .sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'de'))
        .map((e) => ({ value: idOf(e), label: titleOf(e), ...(targets.length > 1 ? { group: MODEL.types[type].label } : {}) })),
    ),
  )
</script>

<div class="chips">
  {#each value as id (id)}
    {@const target = byId.get(id)}
    {@const kind = target ? typeOf(target) : undefined}
    <span class="chip" class:missing={!target}>
      {target ? titleOf(target) : `${id} (fehlt)`}
      {#if kind && targets.length > 1}<small>{MODEL.types[kind].label}</small>{/if}
      <button type="button" title="Entfernen" onclick={() => onchange(value.filter((v) => v !== id))}>×</button>
    </span>
  {/each}
  {#if max === undefined || value.length < max}
  <Combobox {options} label="Hinzufügen" onpick={(id) => id && onchange([...value, id])} />
  {/if}
</div>

<style>
  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .chip { display: inline-flex; align-items: center; gap: 4px; background: var(--accent-wash); color: var(--accent); border-radius: 999px; padding: 2px 4px 2px 10px; font-size: 14px; }
  .chip small { opacity: 0.65; font-size: 12px; }
  .chip.missing { background: var(--bad-wash); color: var(--bad); }
  .chip button { border: 0; background: none; padding: 0 6px; color: inherit; font-size: 16px; line-height: 1; }
</style>
