<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import type { Agent } from './agent.js'
  import type { Api } from './api.js'
  import { defaultStore } from './known.js'
  import { defaultTextStore } from './texts.js'
  import { Workspace } from './workspace.svelte.js'
  import Main from './Main.svelte'
  import { TabLock } from './tablock.svelte.js'

  let { api, agent }: { api: Api; agent?: Agent } = $props()
  const ws = new Workspace(untrack(() => api), untrack(() => agent), defaultStore(), defaultTextStore())
  // Only one tab works at a time (tablock.svelte.ts): two would keep their own copies and save over each other. The others say so.
  const lock = new TabLock()
  onMount(() => lock.start())
  let started = false
  $effect(() => {
    if (lock.state === 'owner' && !started) {
      started = true
      void ws.start()
    }
  })

  const failed = new URLSearchParams(location.search).get('login')
  const who = new URLSearchParams(location.search).get('user')
</script>

{#if lock.state === 'other'}
  <main class="center">
    <h1>Der Editor ist schon in einem anderen Tab geöffnet</h1>
    <p class="muted">Damit sich nichts überschreibt, arbeitet immer nur ein Tab.</p>
    <button class="signin" onclick={() => lock.take()}>Hier weiterarbeiten</button>
  </main>
{:else if lock.state === 'checking' || ws.user === undefined}
  <main class="center"><p class="muted">Einen Moment ...</p></main>
{:else if ws.user === null}
  <main class="center">
    <h1>Contents Editor</h1>
    <p class="muted">Die Inhalte von Schnackenburg bearbeiten.</p>
    {#if failed === 'denied'}
      <p class="error-box">{who ?? 'Dieses Konto'} darf in diesem Repository nichts ändern.</p>
    {:else if failed}
      <p class="error-box">Die Anmeldung hat nicht geklappt. Bitte noch einmal.</p>
    {/if}
    {#if ws.error}<p class="error-box">{ws.error}</p>{/if}
    <a class="signin" href="/api/auth/login">Mit GitHub anmelden</a>
  </main>
{:else}
  <Main {ws} />
{/if}

<style>
  .center { margin: 18vh auto 0; max-width: 26rem; padding: 0 16px; text-align: center; display: flex; flex-direction: column; gap: 12px; align-items: center; }
  h1 { margin: 0; font-size: 1.5rem; }
  p { margin: 0; }
  .signin { background: var(--accent); color: #fff; padding: 9px 18px; border-radius: 6px; text-decoration: none; border: 0; cursor: pointer; font: inherit; }
</style>
