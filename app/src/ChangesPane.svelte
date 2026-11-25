<script lang="ts">
  import { MODEL } from '@editor/core'
  import { shownTitle, titleOf, typeOf } from './logic.js'
  import type { Workspace } from './workspace.svelte.js'

  // What the submission that is worked on changes in the database, one line each; a click opens the entry.
  let { ws, onopen }: { ws: Workspace; onopen: (path: string) => void } = $props()

  /** The id of an entry as it shows in a list: its path without the type folder and the ending. */
  const idPart = (path = '') => path.split('/').slice(2).join('/').replace(/\.yaml$/, '')

  function discard(path: string, kind: string, title: string) {
    if (kind === 'removed' || confirm(kind === 'renamed' ? `Die Umbenennung von „${title}“ verwerfen (mit allem, was dazugehört)?` : `Die Änderung an „${title}“ verwerfen?`)) void ws.discard(path)
  }
</script>

<div class="list">
  {#each ws.changes as change (change.kind + change.entry.path)}
    {@const type = typeOf(change.entry)}
    {@const missing = ws.problems.get(change.entry.path)}
    <div class="item" class:on={ws.selectedPath === change.entry.path}>
      <button class="open" disabled={change.kind === 'removed' || change.topic} onclick={() => onopen(change.entry.path)}>
        <span class="what">
          <span class="t" class:gone={change.kind === 'removed'}>{shownTitle(change.entry)}</span>
          <span class="muted h">{change.topic ? 'Thema' : type ? MODEL.types[type].label : ''}{#if change.kind === 'renamed'} · {idPart(change.from)} → {idPart(change.entry.path)}{#if change.moved}, {change.moved} darunter{/if}{#if change.references}, {change.references} Verweis{change.references > 1 ? 'e' : ''}{/if}{/if}{#if missing} · {missing.join(', ')}{/if}</span>
        </span>
      </button>
      <button class="x" title={change.kind === 'removed' ? 'Wieder herstellen' : 'Änderung verwerfen'} aria-label="Verwerfen" onclick={() => discard(change.entry.path, change.kind, titleOf(change.entry))}>{change.kind === 'removed' ? '↺' : '×'}</button>
    </div>
  {/each}
</div>

<style>
  .list { padding: 4px 6px; border-top: 1px solid var(--line); }
  .list:empty { display: none; }
  .item { display: flex; align-items: center; border-radius: 6px; }
  .item:hover { background: var(--wash); }
  .item.on { background: var(--accent-wash); }
  .item > button { border: 0; background: none; padding: 5px 6px; }
  .open { display: flex; gap: 8px; align-items: center; flex: 1; min-width: 0; text-align: left; }
  .x { flex: none; color: var(--muted); font-size: 16px; line-height: 1; opacity: 0; }
  .item:hover .x, .x:focus-visible { opacity: 1; }
  .what { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t.gone { text-decoration: line-through; color: var(--muted); }
  .h { font-size: 12px; }
</style>
