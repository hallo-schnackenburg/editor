<script lang="ts">
  import { listed, type Option } from './combo.js'

  // A text field that searches its options and shows them in a dropdown (instead of a select box). `value` is the chosen one (a field with
  // one choice); without it the field is for adding: the choice is handed on and the field is empty again.
  let { options, value, placeholder = '', label, empty, onpick }: { options: Option[]; value?: string; placeholder?: string; label: string; empty?: string; onpick: (value: string) => void } = $props()

  let query = $state('')
  let open = $state(false)
  let active = $state(0)
  let input: HTMLInputElement | undefined = $state()

  const chosen = $derived(value === undefined ? undefined : options.find((o) => o.value === value))
  const rows = $derived(listed(options, query))
  const count = $derived(rows.filter((r) => 'option' in r).length)
  const flat = $derived(rows.flatMap((r) => ('option' in r ? [r.option] : [])))

  function show() {
    open = true
    active = 0
  }

  function pick(option: Option | undefined) {
    if (!option) return
    onpick(option.value)
    query = ''
    open = false
    input?.blur()
  }

  function key(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) return show()
      active = count === 0 ? 0 : (active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
      document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' })
    } else if (event.key === 'Enter') {
      if (open) {
        event.preventDefault()
        pick(flat[active])
      }
    } else if (event.key === 'Escape') {
      if (open) event.stopPropagation()
      open = false
      query = ''
    }
  }

  const id = `combo-${Math.random().toString(36).slice(2, 8)}`
</script>

<div class="combo">
  <input
    bind:this={input}
    type="text"
    role="combobox"
    aria-label={label}
    aria-expanded={open}
    aria-controls={id}
    autocomplete="off"
    placeholder={open ? '' : (chosen?.label ?? placeholder)}
    value={open ? query : (chosen?.label ?? '')}
    oninput={(event) => {
      query = event.currentTarget.value
      open = true
      active = 0
    }}
    onfocus={show}
    onclick={() => !open && show()}
    onblur={() => {
      open = false
      query = ''
    }}
    onkeydown={key}
  />
  {#if open}
    <ul {id} role="listbox">
      {#if empty !== undefined && query === ''}
        <li role="option" aria-selected={value === ''} class="plain" onmousedown={(event) => { event.preventDefault(); onpick(''); open = false; input?.blur() }}>{empty}</li>
      {/if}
      {#each rows as row}
        {#if 'heading' in row}
          <li class="heading" role="presentation">{row.heading}</li>
        {:else}
          <li id={`${id}-${row.index}`} role="option" aria-selected={row.index === active} class:active={row.index === active} class:current={row.option.value === value} onmousedown={(event) => { event.preventDefault(); pick(row.option) }} onmousemove={() => (active = row.index)}>{row.option.label}</li>
        {/if}
      {:else}
        <li class="none">Nichts gefunden</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .combo { position: relative; display: inline-block; min-width: 14rem; }
  input { width: 100%; box-sizing: border-box; }
  ul { position: absolute; z-index: 20; top: 100%; left: 0; min-width: 100%; max-height: 260px; overflow: auto; margin: 2px 0 0; padding: 4px; list-style: none; background: var(--bg, white); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 4px 14px rgb(0 0 0 / 0.1); }
  li { padding: 4px 8px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
  li.active { background: var(--accent-wash); }
  li.current { font-weight: 600; }
  li.heading { cursor: default; color: var(--muted); font-size: 12px; padding-top: 8px; }
  li.none, li.plain { color: var(--muted); }
  li.none { cursor: default; }
</style>
