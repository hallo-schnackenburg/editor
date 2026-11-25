<script lang="ts">
  import { MODEL, type EntryType } from '@editor/core'
  import { idOf, titleOf, typeOf, type Entry } from './logic.js'

  let { value, targets, max, entries, exclude = [], onchange }: { value: string[]; targets: readonly string[]; max?: number; entries: Entry[]; exclude?: readonly string[]; onchange: (ids: string[]) => void } = $props()

  const byId = $derived(new Map(entries.map((e) => [idOf(e), e])))
  const options = $derived(
    (targets as readonly EntryType[]).map((type) => ({
      type,
      label: MODEL.types[type].label,
      entries: entries.filter((e) => typeOf(e) === type && !value.includes(idOf(e)) && !exclude.includes(idOf(e))).sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'de')),
    })).filter((g) => g.entries.length > 0),
  )
</script>

<div class="chips">
  {#each value as id (id)}
    {@const target = byId.get(id)}
    <span class="chip" class:missing={!target}>
      {target ? titleOf(target) : `${id} (fehlt)`}
      <button type="button" title="Entfernen" onclick={() => onchange(value.filter((v) => v !== id))}>×</button>
    </span>
  {/each}
  {#if max === undefined || value.length < max}
  <select
    value=""
    onchange={(event) => {
      const id = event.currentTarget.value
      if (id) onchange([...value, id])
      event.currentTarget.value = ''
    }}
  >
    <option value="">+ hinzufügen</option>
    {#each options as group}
      <optgroup label={group.label}>
        {#each group.entries as e}<option value={idOf(e)}>{titleOf(e)}</option>{/each}
      </optgroup>
    {/each}
  </select>
  {/if}
</div>

<style>
  .chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .chip { display: inline-flex; align-items: center; gap: 4px; background: var(--accent-wash); color: var(--accent); border-radius: 999px; padding: 2px 4px 2px 10px; font-size: 14px; }
  .chip.missing { background: var(--bad-wash); color: var(--bad); }
  .chip button { border: 0; background: none; padding: 0 6px; color: inherit; font-size: 16px; line-height: 1; }
  select { width: auto; min-width: 9rem; }
</style>
