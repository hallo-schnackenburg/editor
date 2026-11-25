<script lang="ts">
  import { MODEL, TEXT_ROLES, type TextRole } from '@editor/core'

  let { value, onchange }: { value: Partial<Record<TextRole, string>>; onchange: (role: TextRole, text: string) => void } = $props()

  const length = (s: string) => s.trim().length
  const stored = (role: TextRole) => value[role] ?? ''

  // What is typed is kept here: the text in the entry is a block that always ends in a line break, a typed one would be lost.
  let local = $state<Record<string, string>>(Object.fromEntries(TEXT_ROLES.map((r) => [r, stored(r).trimEnd()])))
  $effect(() => {
    // The entry was changed from outside (reverted, edited in the YAML): take that over.
    for (const role of TEXT_ROLES) if (stored(role).trimEnd() !== (local[role] ?? '').trimEnd()) local[role] = stored(role).trimEnd()
  })
</script>

{#each TEXT_ROLES as role}
  {@const max = (MODEL.textRoles[role] as { max?: number }).max}
  <div class="role">
    <div class="head">
      <strong>{MODEL.textRoles[role].label}</strong>
      <span class="muted count" class:over={max !== undefined && length(local[role] ?? '') > max}>
        {#if max !== undefined}{length(local[role] ?? '')} / {max}{:else}{length(local[role] ?? '')} Zeichen{/if}
      </span>
    </div>
    <textarea
      rows={role === 'body' || role === 'print' ? 10 : 3}
      value={local[role]}
      oninput={(event) => {
        local[role] = event.currentTarget.value
        onchange(role, event.currentTarget.value)
      }}
    ></textarea>
  </div>
{/each}

<style>
  .role { margin-bottom: 14px; }
  .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px; }
  .count { font-size: 12px; }
  .count.over { color: var(--bad); font-weight: 600; }
</style>
