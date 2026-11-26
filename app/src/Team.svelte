<script lang="ts">
  import type { Workspace } from './workspace.svelte.js'
  import { describe } from './team.js'

  let { ws }: { ws: Workspace } = $props()

  let open = $state(false)
  let filter = $state<'inbox' | 'all'>('inbox')

  const others = $derived(ws.present.filter((p) => p.login !== ws.user?.login))
  const lines = $derived(filter === 'inbox' ? ws.inbox : ws.activity)
  const nameOf = (login: string) => ws.present.find((p) => p.login === login)?.name ?? login
  const doing = (p: { name: string; path?: string; branch?: string }) => {
    const submission = ws.submissions.find((s) => s.branch === p.branch)
    return [p.name, p.path?.split('/').pop(), submission?.name].filter(Boolean).join(' · ')
  }
  const time = (ms: number) => new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

  function toggle() {
    open = !open
    if (open) void ws.markActivitySeen()
  }
</script>

<div class="team">
  {#each others as person (person.login)}
    <span class="person" title={doing(person)}>
      {#if person.avatar}<img src={person.avatar} alt={person.name} />{:else}{person.name.slice(0, 1)}{/if}
    </span>
  {/each}
  <button class="bell" onclick={toggle} aria-label="Aktivität" aria-expanded={open}>
    ✉{#if ws.unread.length > 0}<span class="badge">{ws.unread.length}</span>{/if}
  </button>
  {#if open}
    <div class="panel">
      <div class="filters">
        <button class:on={filter === 'inbox'} onclick={() => (filter = 'inbox')}>Eingang</button>
        <button class:on={filter === 'all'} onclick={() => (filter = 'all')}>Alles</button>
      </div>
      <ul>
        {#each lines as line (line.id)}
          <li class:new={line.id > ws.activitySeen}>
            <span class="who">{nameOf(line.actor)}</span> {describe(line)}
            <span class="when">{time(line.updated)}</span>
          </li>
        {:else}
          <li class="muted">Nichts</li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .team { display: flex; align-items: center; gap: 6px; position: relative; }
  .person { width: 24px; height: 24px; border-radius: 50%; background: var(--line); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; overflow: hidden; }
  .person img { width: 100%; height: 100%; object-fit: cover; }
  .bell { position: relative; }
  .badge { position: absolute; top: -6px; right: -6px; background: var(--accent, #c33); color: white; border-radius: 8px; font-size: 10px; padding: 0 4px; }
  .panel { position: absolute; top: 100%; right: 0; z-index: 10; width: 360px; max-height: 60vh; overflow: auto; background: var(--bg, white); border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
  .filters { display: flex; gap: 4px; margin-bottom: 6px; }
  .filters .on { font-weight: 600; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 4px 0; font-size: 13px; border-bottom: 1px solid var(--line); }
  li.new { font-weight: 500; }
  .who { font-weight: 600; }
  .when { color: var(--muted); font-size: 11px; margin-left: 6px; }
</style>
