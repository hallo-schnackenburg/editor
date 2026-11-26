<script lang="ts">
  import type { Workspace } from './workspace.svelte.js'
  import Browse from './Browse.svelte'
  import Team from './Team.svelte'
  import Active from './Active.svelte'

  let { ws }: { ws: Workspace } = $props()

  // Where the person is (the submission, the details or an entry) is kept for the next load of the page.
  $effect(() => {
    void [ws.branch, ws.review.detailOpen, ws.selectedPath]
    ws.rememberView()
  })

  // What the person works on is told to the others (the hub only passes it on when it changes), and now and then again so that nobody counts as away.
  $effect(() => {
    void [ws.branch, ws.selectedPath]
    ws.reportPresence()
    const again = setInterval(() => ws.reportPresence(), 20_000)
    return () => clearInterval(again)
  })

  $effect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      // Finished entries are saved at once; what is still being typed is only in this page.
      if (ws.dirty.length > 0) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  })
</script>

<div class="app">
  <header>
    <strong>Contents Editor</strong>
    <Active {ws} />
    <span class="spacer"></span>
    <Team {ws} />
    {#if ws.saving}<span class="muted">Speichert ...</span>{/if}
    {#if ws.reading}<span class="muted">Liest Einträge ...</span>{/if}
    <span class="live" class:on={ws.liveOpen} title={ws.liveOpen ? 'Live verbunden' : 'Keine Live-Verbindung: es wird alle Minute nachgefragt.'}>●</span>
    <button onclick={() => void ws.reload()} disabled={ws.loading}>{ws.loading ? 'Lädt ...' : 'Neu laden'}</button>
    <span class="muted">{ws.user?.name}</span>
    <button onclick={() => void ws.logout()}>Abmelden</button>
  </header>
  {#if ws.error}
    <div class="error-box banner">{ws.error} <button class="link" onclick={() => (ws.error = undefined)}>Schließen</button></div>
  {/if}
  <Browse {ws} />
</div>

<style>
  .app { display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 8px 16px; background: var(--paper); border-bottom: 1px solid var(--line); }
  .spacer { flex: 1; }
  .live { color: var(--line); font-size: 12px; }
  .live.on { color: var(--ok); }
  .banner { margin: 8px 16px 0; }
</style>
