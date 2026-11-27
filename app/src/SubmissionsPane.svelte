<script lang="ts">
  import ChangesPane from './ChangesPane.svelte'
  import type { Workspace } from './workspace.svelte.js'
  import type { Submission } from './api.js'

  // The submissions that can still be changed, in one list, and the database (the main branch) above them. A click makes one the one
  // that is worked on (its details show in the middle, and it opens here: what it changes, and what can be done with it); another click on it folds what is below it away, the next unfolds it.
  let { ws, onopen }: { ws: Workspace; onopen?: () => void } = $props()
  const review = $derived(ws.review)

  let asking = $state<'merge' | 'close'>()
  let renaming = $state(false)
  /** Whether the changes of the active submission are folded away. */
  let folded = $state(false)
  let name = $state('')

  const when = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { dateStyle: 'short' })
  const canPropose = $derived(ws.editable && ws.draft !== undefined && !ws.formOpen)

  // Whatever was asked for belongs to the submission that was active.
  $effect(() => {
    void ws.active?.number
    asking = undefined
    renaming = false
    folded = false
  })

  async function pick(submission: Submission) {
    // The active one is a switch for what is shown below its card (the changes and what can be done): the details in the middle stay.
    if (ws.active?.number === submission.number) {
      folded = !folded
      return
    }
    onopen?.()
    await ws.work(submission)
  }

  async function pickMain() {
    onopen?.()
    await ws.switchTo(undefined)
  }

  async function confirm(action: 'merge' | 'close') {
    await review.act(action, ws.active?.number)
    asking = undefined
  }

  function startRename() {
    name = ws.active?.name ?? ''
    renaming = true
  }

  async function rename(event: Event) {
    event.preventDefault()
    await ws.rename(name)
    renaming = false
  }
</script>

<aside>
  <ul>
    <li class:open={ws.branch === undefined} class:plain={true}>
      <button class="card" onclick={() => void pickMain()}>
        <span class="name">Datenbank</span>
        <span class="meta muted"><span>main</span></span>
      </button>
    </li>
    {#each review.shown as submission (submission.number)}
      {@const current = ws.active?.number === submission.number}
      <li class:open={current} class:expanded={current && !folded}>
        <button class="card" onclick={() => void pick(submission)}>
          <span class="name">{submission.name}</span>
          <span class="meta muted"><span>{submission.author} · {when(submission.updated)}</span>{#if submission.state === 'draft'}<span>Entwurf</span>{/if}</span>
        </button>
        {#if current && !folded}
          <ChangesPane {ws} />
          <div class="actions">
            {#if renaming}
              <form onsubmit={rename}>
                <input type="text" bind:value={name} maxlength="100" aria-label="Name der Einreichung" />
                <button class="primary" type="submit" disabled={!name.trim()}>Speichern</button>
                <button type="button" onclick={() => (renaming = false)}>Abbrechen</button>
              </form>
            {:else if asking}
              <span>{asking === 'merge' ? 'Einreichung annehmen?' : 'Änderungen verwerfen?'}</span>
              <button class="primary" onclick={() => void confirm(asking!)} disabled={!!review.acting}>{review.acting ? 'Einen Moment ...' : 'Ja'}</button>
              <button onclick={() => (asking = undefined)} disabled={!!review.acting}>Nein</button>
            {:else}
              {#if submission.state === 'draft'}<button class="primary" disabled={!canPropose} onclick={() => void ws.submit()}>Vorschlagen</button>{/if}
              {#if submission.state === 'submitted'}
                <span title={review.blocked ?? ''}><button class="primary" disabled={!!review.blocked} onclick={() => (asking = 'merge')}>Annehmen</button></span>
              {/if}
              <button onclick={startRename}>Umbenennen</button>
              <button class="danger" onclick={() => (asking = 'close')}>Verwerfen</button>
              <a href={submission.url} target="_blank" rel="noreferrer">Auf GitHub ansehen</a>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
</aside>

<style>
  aside { background: var(--paper); border: 1px solid var(--line); border-radius: 8px; display: flex; flex-direction: column; min-height: 0; flex: 1; }
  ul { list-style: none; margin: 0; padding: 6px; overflow: auto; display: grid; gap: 6px; align-content: start; }
  li { border: 1px solid transparent; border-radius: 6px; }
  li.open { border-color: var(--accent); }
  .card { display: grid; gap: 2px; width: 100%; text-align: left; border: 0; padding: 7px 8px; border-radius: 6px; background: none; }
  .card:hover { background: var(--wash); }
  li.open .card { background: var(--accent-wash); }
  li.expanded .card { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .name { font-weight: 600; }
  .meta { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px; border-top: 1px solid var(--line); }
  .actions form { display: flex; flex-wrap: wrap; gap: 8px; width: 100%; }
  .actions input { flex: 1; min-width: 8rem; }
  .actions a { margin-left: auto; color: var(--accent); font-size: 13px; }
</style>
