<script lang="ts">
  import { fieldChanges, lineDiff } from './diff.js'
  import { makeEntry, titleOf } from './logic.js'
  import { tick } from 'svelte'
  import type { SubmissionItem } from './api.js'
  import type { Workspace } from './workspace.svelte.js'

  // What a submission does: every entry it adds, changes and removes, one below the other (before and after), how the check stands, and
  // what was said about it. What can be done with it is with its card in the column on the right.
  let { ws, onopen }: { ws: Workspace; onopen: (path: string) => void } = $props()
  const review = $derived(ws.review)

  const KIND = { added: 'Neu', modified: 'Geändert', removed: 'Gelöscht' } as const
  const ORDER = { added: 0, modified: 1, removed: 2 } as const

  let yaml = $state(true)
  let draft = $state('')
  /** The comment that is being changed, and its text. */
  let editing = $state<{ id: number; text: string }>()

  const when = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
  const nameOf = (i: SubmissionItem) => titleOf(makeEntry(i.path, i.after ?? i.before ?? ''))
  // What is not known yet is read: what is known is shown at once, the spinner is below it.
  const waiting = $derived(review.detailState === 'loading' || ws.loading)
  const items = $derived([...(review.detail?.items ?? [])].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]))

  // The change that was clicked in the list on the right is marked and brought into view.
  $effect(() => {
    const path = review.focus
    void review.detail
    if (!path) return
    void tick().then(() => [...document.querySelectorAll<HTMLElement>('[data-path]')].find((el) => el.dataset.path === path)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  })

  /** Whether an entry can be opened from here: not one that is removed, and not a topic. */
  const openable = (i: SubmissionItem) => i.kind !== 'removed' && !ws.changes.some((c) => c.entry.path === i.path && c.topic)

  // Whatever was typed belongs to the submission that was open.
  $effect(() => {
    void review.selected
    draft = ''
    editing = undefined
  })

  async function change(event: Event) {
    event.preventDefault()
    if (editing && (await review.editComment(editing.id, editing.text))) editing = undefined
  }

  async function send(event: Event) {
    event.preventDefault()
    if (await review.comment(draft)) draft = ''
  }
</script>

{#if review.submission}
  {@const submission = review.submission}
  <div class="sub">
    <header>
      <div>
        <h1>{submission.name}</h1>
        <div class="muted">{submission.author} · {when(submission.updated)}{#if submission.state === 'draft'} · Entwurf{/if}</div>
      </div>
      <div class="actions">
        <button class:on={!yaml} onclick={() => (yaml = false)}>Felder</button>
        <button class:on={yaml} onclick={() => (yaml = true)}>YAML</button>
        <button onclick={() => (review.detailOpen = false)}>Schließen</button>
      </div>
    </header>

    {#if review.error}<p class="error-box">{review.error}</p>{/if}

    {#if review.detail}
      {#if !waiting}
        <p class="checks {review.detail.checks}">
          {#if review.detail.checks === 'success'}✓ Die automatische Prüfung ist bestanden.
          {:else if review.detail.checks === 'failure'}✗ Die automatische Prüfung ist fehlgeschlagen.
          {:else if review.detail.checks === 'pending'}… Die automatische Prüfung läuft noch.
          {:else}Keine automatische Prüfung.{/if}
          {#if review.blocked && review.detail.checks !== 'failure'} {review.blocked}{/if}
        </p>
      {/if}

      {#each items as i (i.path)}
        <section class="item" class:marked={review.focus === i.path} data-path={i.path}>
          <div class="head">
            <span class="kind {i.kind}">{KIND[i.kind]}</span>
            <strong>{nameOf(i)}</strong>
            <span class="muted mono path">{i.path}</span>
            {#if openable(i)}<button class="open" onclick={() => onopen(i.path)}>Öffnen</button>{/if}
          </div>
          {#each review.problems.get(i.path) ?? [] as issue}<p class="error-box"><span class="mono">{issue.path}</span> {issue.message}</p>{/each}
          {#if yaml}
            <pre class="mono">{#each lineDiff(i.before, i.after) as line}<span class="line {line.kind}">{line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}{line.text}
</span>{/each}</pre>
          {:else}
            {#each fieldChanges(i.before, i.after) as field (field.field)}
              <div class="field">
                <div class="label">{field.label}</div>
                {#if field.list}
                  {#each field.list as line}<div class="row {line.kind}">{line.text}</div>{/each}
                {:else}
                  {#if field.before !== undefined}<div class="row del">{field.before}</div>{/if}
                  {#if field.after !== undefined}<div class="row add">{field.after}</div>{/if}
                {/if}
              </div>
            {:else}
              <p class="muted">Keine Unterschiede.</p>
            {/each}
          {/if}
        </section>
      {:else}
        {#if !waiting}<p class="muted">Diese Einreichung enthält noch nichts.</p>{/if}
      {/each}
      {#if review.detail.truncated}<p class="muted">Es sind mehr Einträge betroffen, als hier gezeigt werden.</p>{/if}
    {/if}

    {#if waiting}<div class="wait" role="status" aria-label="Lädt"><span class="spinner" aria-hidden="true"></span></div>{/if}

    {#if review.detail || review.comments.length > 0}
      <h2>Kommentare <span class="muted">{review.comments.length}</span></h2>
      <ul class="comments">
        {#each review.comments as comment (comment.id)}
          <li>
            <div class="muted">
              <strong>{comment.author}</strong> · {when(comment.created)}
              {#if comment.author === ws.user?.login && editing?.id !== comment.id}
                <button class="link" onclick={() => (editing = { id: comment.id, text: comment.body })}>Bearbeiten</button>
                <button class="link" onclick={() => void review.removeComment(comment.id)}>Löschen</button>
              {/if}
            </div>
            {#if editing?.id === comment.id}
              <form onsubmit={change}>
                <textarea rows="3" bind:value={editing.text}></textarea>
                <button type="submit" disabled={!editing.text.trim()}>Speichern</button>
                <button type="button" onclick={() => (editing = undefined)}>Abbrechen</button>
              </form>
            {:else}
              <div class="body">{comment.body}</div>
            {/if}
          </li>
        {/each}
      </ul>
      <form onsubmit={send}>
        <textarea rows="3" bind:value={draft} placeholder="Kommentar schreiben ..."></textarea>
        <button type="submit" disabled={!draft.trim()}>Kommentieren</button>
      </form>
    {/if}
  </div>
{/if}

<style>
  .sub { padding: 16px 20px 32px; }
  .wait { padding: 12px 0; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  h1 { margin: 0 0 2px; font-size: 1.35rem; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 18px 0 4px; }
  .actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .actions button.on { background: var(--accent-wash); color: var(--accent); }
  .checks { margin: 12px 0 0; font-size: 14px; }
  .checks.success { color: var(--ok); }
  .checks.failure { color: var(--bad); }
  .checks.pending, .checks.none { color: var(--muted); }
  .item.marked { background: var(--accent-wash); box-shadow: 0 0 0 6px var(--accent-wash); border-radius: 4px; }
  .item { scroll-margin-top: 16px; margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--line); min-width: 0; }
  .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-bottom: 8px; }
  .path { font-size: 12px; }
  .head .open { margin-left: auto; padding: 2px 10px; font-size: 12px; }
  .kind { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .kind.added { color: var(--ok); }
  .kind.removed { color: var(--bad); }
  .field { margin-bottom: 12px; }
  .label { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
  .row { white-space: pre-wrap; padding: 2px 8px; border-radius: 4px; }
  .row.del { background: var(--bad-wash); text-decoration: line-through; color: var(--bad); }
  .row.add { background: #e9f5ec; margin-top: 2px; }
  pre { margin: 0; overflow: auto; background: var(--wash); border-radius: 6px; padding: 8px 0; }
  .line { display: block; padding: 0 10px; white-space: pre; }
  .line.add { background: #e9f5ec; }
  .line.del { background: var(--bad-wash); }
  .comments { list-style: none; margin: 0 0 10px; padding: 0; display: grid; gap: 10px; }
  .comments .body { white-space: pre-wrap; }
  form { display: grid; gap: 8px; justify-items: start; }
</style>
