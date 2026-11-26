<script lang="ts">
  import type { SubmissionState } from './api.js'
  import type { Workspace } from './workspace.svelte.js'

  // The active submission: its name, how it stands and whose it is. Without one the base version is shown.
  let { ws }: { ws: Workspace } = $props()

  const STATE: Record<SubmissionState, string> = { draft: 'Entwurf', submitted: 'Eingereicht', merged: 'Übernommen', closed: 'Geschlossen' }
  const active = $derived(ws.active)
</script>

<span class="chip" class:main={!active} class:done={active?.state === 'merged' || active?.state === 'closed'}>
  {#if active}
    <strong>{active.name}</strong>
    <span class="state">{STATE[active.state]}</span>
    <span class="owner">{active.author}</span>
  {:else}
    <strong>Hauptversion</strong>
  {/if}
</span>

<style>
  .chip { display: inline-flex; align-items: center; gap: 8px; padding: 2px 10px; border: 1px solid var(--accent, #36c); border-radius: 12px; font-size: 13px; }
  .chip.main, .chip.done { border-color: var(--line); color: var(--muted); }
  .state, .owner { color: var(--muted); }
  .owner::before { content: '·'; margin-right: 8px; }
</style>
