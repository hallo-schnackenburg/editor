<script lang="ts">
  import { onDestroy } from 'svelte'
  import { MODEL } from '@contents-editor/core'
  import type { Api } from './api.js'
  import { prepareFile, type FileEntry } from './prepare.js'
  import Lightbox from './Lightbox.svelte'
  import { withFile } from './logic.js'
  import { bucketPreview, type Viewable } from './viewer.js'

  type Rule = { roles?: readonly string[]; numbered?: boolean; max?: number }
  let { value, kind, external, base, upload, onchange }: { value: FileEntry[]; kind: string; external: boolean; base?: string; upload: Api['upload']; onchange: (files: FileEntry[]) => void } = $props()

  const rule = $derived(((MODEL.types.object as unknown as { kinds: Record<string, { files: Rule }> }).kinds[kind]?.files ?? {}) as Rule)
  // What is kept elsewhere has only a picture of it (a thumbnail); otherwise the kind says which role a file has.
  const full = $derived(!external && rule.max !== undefined && rule.max > 1 && value.length >= rule.max)
  const replaces = $derived(!external && rule.max === 1)

  interface Pending {
    id: number
    name: string
    fraction: number
    error?: string
  }
  let pending = $state<Pending[]>([])
  let counter = 0
  let over = $state(false)
  /** The small pictures of what was added here, until the page is left (the bucket has them afterwards). */
  const local = new Map<string, { url: string; preview: Blob; web?: Blob }>()
  // The pictures are kept as addresses of the browser, and given back with the page.
  onDestroy(() => local.forEach(({ url }) => URL.revokeObjectURL(url)))
  let looking = $state<number>()

  // A file that is being added must not be lost when another one is done meanwhile: the list is always the newest one.
  let current: FileEntry[] = []
  $effect.pre(() => {
    current = value
  })
  function put(next: FileEntry[]) {
    current = next
    onchange(next)
  }

  async function add(file: File) {
    const item: Pending = { id: ++counter, name: file.name, fraction: 0 }
    pending.push(item)
    const mine = () => pending.find((p) => p.id === item.id)!
    try {
      // Hashing is the first half of the bar, sending the second.
      const prepared = await prepareFile(file, (f) => (mine().fraction = f / 2))
      const sha = prepared.entry.sha256 as string
      const planned = withFile(current, prepared.entry, kind, external)
      if ('problem' in planned) throw new Error(planned.problem)
      const result = await upload(file, prepared.entry, (f) => (mine().fraction = 0.5 + f / 2), { preview: prepared.preview, web: prepared.web })
      if (result.status === 'conflict') throw new Error(result.message ?? 'Der Speicher hat schon eine andere Datei unter diesem Pfad.')
      if (prepared.preview) local.set(sha, { url: URL.createObjectURL(prepared.preview), preview: prepared.preview, web: prepared.web })
      // The list may have changed while the file was sent: the place in it is worked out again.
      const placed = withFile(current, prepared.entry, kind, external)
      if ('problem' in placed) throw new Error(placed.problem)
      put(placed.files)
      pending = pending.filter((p) => p.id !== item.id)
    } catch (error) {
      mine().error = error instanceof Error ? error.message : String(error)
    }
  }

  function take(files: FileList | File[] | null) {
    if (!files) return
    for (const file of files) void add(file)
  }

  const remove = (sha: string) => put(current.filter((f) => f.sha256 !== sha))
  const pictureOf = (file: FileEntry) => local.get(file.sha256 as string)?.url ?? (base ? bucketPreview(file, base) : undefined)
  // What the big view shows: the files that have a picture; a picture made here is shown until the bucket has its own.
  const tiles = $derived(
    value.flatMap((file): (Viewable & { sha256: string })[] => {
      const mine = local.get(file.sha256 as string)
      const preview = mine?.preview ?? (base ? bucketPreview(file, base) : undefined)
      return preview ? [{ sha256: file.sha256 as string, name: String(file.original_name ?? file.path), entry: file, preview, web: mine?.web }] : []
    }),
  )
  const look = (file: FileEntry) => {
    const at = tiles.findIndex((t) => t.sha256 === file.sha256)
    if (at >= 0) looking = at
  }
  const sizeOf = (bytes: unknown) => (typeof bytes === 'number' ? (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`) : '')
</script>

<ul class="files">
  {#each value as file (file.sha256)}
    <li>
      {#if pictureOf(file)}<button type="button" class="zoom" onclick={() => look(file)} aria-label="Vergrößern"><img src={pictureOf(file)} alt="" /></button>{:else}<span class="blank mono">{String(file.mime ?? '').split('/')[1] ?? ''}</span>{/if}
      <span class="what">
        <span>{file.role}{#if file.num} {file.num}{/if}</span>
        <span class="muted">{file.original_name ?? ''} · {sizeOf(file.bytes)}</span>
      </span>
      {#if base && typeof file.path === 'string'}<a href={`${base.replace(/\/$/, '')}/${file.path}`} target="_blank" rel="noreferrer">Öffnen</a>{/if}
      <button type="button" onclick={() => remove(file.sha256 as string)}>Entfernen</button>
    </li>
  {/each}
  {#each pending as item (item.id)}
    <li>
      <span class="blank"></span>
      <span class="what">
        <span>{item.name}</span>
        {#if item.error}<span class="issue">{item.error}</span>{:else}<progress value={item.fraction}></progress>{/if}
      </span>
      {#if item.error}<button type="button" onclick={() => (pending = pending.filter((p) => p.id !== item.id))}>Schließen</button>{/if}
    </li>
  {/each}
</ul>

{#if looking !== undefined && tiles.length > 0}
  <Lightbox files={tiles} start={Math.min(looking, tiles.length - 1)} {base} onclose={() => (looking = undefined)} />
{/if}

{#if !full}
  <label
    class="drop"
    class:over
    ondragover={(event) => { event.preventDefault(); over = true }}
    ondragleave={() => (over = false)}
    ondrop={(event) => { event.preventDefault(); over = false; take(event.dataTransfer?.files ?? null) }}
  >
    {replaces && value.length > 0 ? 'Datei ersetzen' : 'Dateien hierher ziehen oder auswählen'}
    <input type="file" multiple={!replaces} onchange={(event) => { take(event.currentTarget.files); event.currentTarget.value = '' }} hidden />
  </label>
{/if}

<style>
  .files { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  li { display: flex; align-items: center; gap: 10px; padding: 6px; border: 1px solid var(--line); border-radius: 8px; }
  img, .blank { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; background: var(--accent-wash); flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; }
  .what { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .what span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .zoom { padding: 0; border: 0; background: none; cursor: zoom-in; display: flex; flex-shrink: 0; }
  progress { width: 100%; }
  .issue { color: var(--bad); font-size: 13px; white-space: normal; }
  .drop { display: block; padding: 14px; text-align: center; border: 2px dashed var(--line); border-radius: 8px; cursor: pointer; }
  .drop.over { border-color: var(--accent); background: var(--accent-wash); }
</style>
