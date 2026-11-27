<script lang="ts">
  import { untrack } from 'svelte'
  import { decodePlusCode, findPlusCode } from '@editor/core'

  let { value, onchange }: { value?: { lat: number; lon: number }; onchange: (value: { lat: number | null; lon: number | null }) => void } = $props()

  // Kept here: with only one of the two filled in the entry has no location yet, and the other must not vanish.
  // svelte-ignore state_referenced_locally
  let lat = $state(value?.lat ?? null)
  // svelte-ignore state_referenced_locally
  let lon = $state(value?.lon ?? null)
  // What is typed is taken from the input itself (not from the state, which may not be up to date yet).
  const parse = (input: HTMLInputElement): number | null => (input.value.trim() === '' || Number.isNaN(input.valueAsNumber) ? null : input.valueAsNumber)
  const typedLat = (event: Event) => onchange({ lat: parse(event.currentTarget as HTMLInputElement), lon })
  const typedLon = (event: Event) => onchange({ lat, lon: parse(event.currentTarget as HTMLInputElement) })

  // A plus code (Google Maps) pasted into either field fills in both; a short one is completed near the place, or near Schnackenburg.
  const SCHNACKENBURG = { lat: 53.037, lon: 11.568 }
  function pasted(event: ClipboardEvent) {
    const code = findPlusCode(event.clipboardData?.getData('text') ?? '')
    const position = code && decodePlusCode(code, lat !== null && lon !== null ? { lat, lon } : SCHNACKENBURG)
    if (!position) return
    event.preventDefault()
    lat = Number(position.lat.toFixed(6))
    lon = Number(position.lon.toFixed(6))
    onchange({ lat, lon })
  }

  // Changed from outside (the assistant filled it in): what the entry has is shown. Only a change of the entry counts, not what is typed here;
  // an entry without a location (only one of the two typed, or none) leaves the fields as they are.
  $effect(() => {
    const entry = value
    untrack(() => {
      if (entry && (entry.lat !== lat || entry.lon !== lon)) {
        lat = entry.lat
        lon = entry.lon
      }
    })
  })
</script>

<div class="pair">
  <label>Breite <input type="number" step="any" min="-90" max="90" bind:value={lat} oninput={typedLat} onpaste={pasted} /></label>
  <label>Länge <input type="number" step="any" min="-180" max="180" bind:value={lon} oninput={typedLon} onpaste={pasted} /></label>
</div>

<style>
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; max-width: 24rem; }
  label { display: flex; flex-direction: column; gap: 3px; font-size: 13px; color: var(--muted); }
</style>
