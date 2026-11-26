<script lang="ts">
  // Free keywords: the ones the entry has, as chips (internal ones, those that start with an underscore, in a quieter look), and a field to add one,
  // with the tags that are used elsewhere as suggestions.
  let { value, suggestions, onchange }: { value: string[]; suggestions: string[]; onchange: (tags: string[]) => void } = $props()

  let draft = $state('')
  const rest = $derived(suggestions.filter((t) => !value.includes(t)))

  function add(text: string) {
    const tag = text.trim().replace(/,+$/, '').trim()
    draft = ''
    if (tag && !value.includes(tag)) onchange([...value, tag])
  }

  function key(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      add(draft)
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) onchange(value.slice(0, -1))
  }
</script>

<div class="tags">
  {#each value as tag (tag)}
    <span class="tag" class:internal={tag.startsWith('_')}>{tag}<button type="button" aria-label={`${tag} entfernen`} onclick={() => onchange(value.filter((t) => t !== tag))}>×</button></span>
  {/each}
  <input type="text" list="tag-suggestions" bind:value={draft} onkeydown={key} onblur={() => add(draft)} aria-label="Tag hinzufügen" />
  <datalist id="tag-suggestions">{#each rest as tag}<option value={tag}></option>{/each}</datalist>
</div>

<style>
  .tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { display: inline-flex; align-items: center; gap: 4px; padding: 1px 4px 1px 10px; border: 1px solid var(--line); border-radius: 12px; font-size: 13px; }
  .tag.internal { color: var(--muted); border-style: dashed; }
  .tag button { border: 0; background: none; padding: 0 4px; color: var(--muted); }
  input { flex: 1; min-width: 120px; border: 0; outline: 0; background: none; }
</style>
