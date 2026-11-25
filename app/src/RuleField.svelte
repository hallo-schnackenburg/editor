<script lang="ts">
  import { untrack } from 'svelte'
  import { occurrences, ruleProblem } from '@editor/core'
  import { issueText } from './logic.js'
  import { ruleText } from './ruletext.js'

  type Rule = { rrule: string; start: string }
  let { value, onchange }: { value?: Rule; onchange: (rule: Rule) => void } = $props()

  const today = () => new Date().toISOString().slice(0, 10)
  const split = (when?: string): [string, string] => [when?.slice(0, 10) ?? '', when?.slice(11, 16) ?? '']
  const join = (date: string, time: string) => (date ? (time ? `${date}T${time}` : date) : '')

  // The rule as text, and the start: kept here, so that what is typed stays while the rule is not complete.
  // svelte-ignore state_referenced_locally
  let rrule = $state(value?.rrule ?? '')
  // svelte-ignore state_referenced_locally
  let [startDate, startTime] = $state(split(value?.start))
  const emit = () => {
    if (rrule.trim() && !startDate) startDate = today()
    onchange({ rrule, start: join(startDate, startTime) })
  }

  // Changed from outside (the assistant filled it in): what the entry has is shown.
  $effect(() => {
    const rule = value
    untrack(() => {
      if (rule && (rule.rrule !== rrule.trim() || rule.start !== join(startDate, startTime))) {
        rrule = rule.rrule
        ;[startDate, startTime] = split(rule.start)
      }
    })
  })

  // --- the kit: puts a rule together (the text below it is the rule; what is changed there is not read back) ---
  const DAYS = [['MO', 'Mo'], ['TU', 'Di'], ['WE', 'Mi'], ['TH', 'Do'], ['FR', 'Fr'], ['SA', 'Sa'], ['SU', 'So']] as const
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
  let basis = $state<'calendar' | 'easter' | 'advent'>('calendar')
  let freq = $state('YEARLY')
  let interval = $state(1)
  let weekdays = $state<string[]>([])
  let nth = $state('')
  let month = $state('')
  let monthday = $state('')
  let direction = $state<'before' | 'after'>('before')
  let offset = $state(1)
  let ending = $state<'never' | 'count' | 'until'>('never')
  let count = $state(10)
  let until = $state('')

  function compose(): string {
    const parts: string[] = ['FREQ=' + (basis === 'calendar' ? freq : 'YEARLY')]
    if (interval > 1) parts.push(`INTERVAL=${interval}`)
    if (basis === 'calendar') {
      if (month) parts.push(`BYMONTH=${month}`)
      if (monthday) parts.push(`BYMONTHDAY=${monthday}`)
      if (weekdays.length > 0) parts.push(`BYDAY=${DAYS.filter(([d]) => weekdays.includes(d)).map(([d]) => `${nth}${d}`).join(',')}`)
    } else {
      parts.push(`${basis === 'easter' ? 'BYEASTER' : 'BYADVENT'}=${direction === 'before' ? -offset : offset}`)
    }
    if (ending === 'count' && count > 0) parts.push(`COUNT=${count}`)
    if (ending === 'until' && until) parts.push(`UNTIL=${until.replaceAll('-', '')}`)
    return parts.join(';')
  }
  const kit = () => {
    rrule = compose()
    emit()
  }
  const toggle = (day: string) => {
    weekdays = weekdays.includes(day) ? weekdays.filter((d) => d !== day) : [...weekdays, day]
    kit()
  }

  // --- what comes out ---
  const rule = $derived({ rrule, start: join(startDate, startTime) })
  const problem = $derived(rrule.trim() && rule.start ? ruleProblem({ rrule: rrule.trim(), start: rule.start }) : undefined)
  const sentence = $derived(rrule.trim() && !problem ? ruleText(rrule) : undefined)
  const next = $derived.by(() => {
    if (!rrule.trim() || !rule.start || problem) return []
    const from = today()
    const to = `${Number(from.slice(0, 4)) + 15}-12-31`
    return occurrences({ rule: { rrule: rrule.trim(), start: rule.start } }, from, to).slice(0, 5)
  })
  const show = (start: string) => new Date(start.slice(0, 10) + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) + (start.length > 10 ? `, ${start.slice(11)} Uhr` : '')
</script>

<div class="rule">
  <div class="line">
    <input type="date" aria-label="Erster Termin" bind:value={startDate} oninput={emit} />
    <input type="time" aria-label="Uhrzeit" bind:value={startTime} oninput={emit} />
  </div>
  <input type="text" class="mono" aria-label="Regel" placeholder="FREQ=YEARLY;BYEASTER=-1" bind:value={rrule} oninput={emit} />

  <details>
    <summary>Zusammenstellen</summary>
    <div class="kit">
      <div class="line">
        <select aria-label="Bezug" bind:value={basis} onchange={kit}>
          <option value="calendar">Nach dem Kalender</option>
          <option value="easter">Relativ zu Ostersonntag</option>
          <option value="advent">Relativ zum 1. Advent</option>
        </select>
        {#if basis === 'calendar'}
          <select aria-label="Häufigkeit" bind:value={freq} onchange={kit}>
            <option value="DAILY">täglich</option>
            <option value="WEEKLY">wöchentlich</option>
            <option value="MONTHLY">monatlich</option>
            <option value="YEARLY">jährlich</option>
          </select>
        {:else}
          <input type="number" min="0" max="400" aria-label="Tage" bind:value={offset} oninput={kit} />
          <span>Tage</span>
          <select aria-label="Richtung" bind:value={direction} onchange={kit}>
            <option value="before">davor</option>
            <option value="after">danach</option>
          </select>
        {/if}
        <label class="inline">alle <input type="number" min="1" max="99" aria-label="Intervall" bind:value={interval} oninput={kit} /></label>
      </div>
      {#if basis === 'calendar'}
        <div class="line">
          <select aria-label="Monat" bind:value={month} onchange={kit}>
            <option value="">jeder Monat</option>
            {#each MONTHS as name, i}<option value={i + 1}>{name}</option>{/each}
          </select>
          <input type="number" min="1" max="31" placeholder="Tag" aria-label="Tag im Monat" bind:value={monthday} oninput={kit} />
          <select aria-label="Welcher" bind:value={nth} onchange={kit}>
            <option value="">jeder</option>
            <option value="1">erster</option>
            <option value="2">zweiter</option>
            <option value="3">dritter</option>
            <option value="4">vierter</option>
            <option value="-1">letzter</option>
          </select>
          {#each DAYS as [day, label]}
            <label class="inline"><input type="checkbox" checked={weekdays.includes(day)} onchange={() => toggle(day)} /> {label}</label>
          {/each}
        </div>
      {/if}
      <div class="line">
        <select aria-label="Ende" bind:value={ending} onchange={kit}>
          <option value="never">ohne Ende</option>
          <option value="count">nach Anzahl</option>
          <option value="until">bis Datum</option>
        </select>
        {#if ending === 'count'}<input type="number" min="1" aria-label="Anzahl" bind:value={count} oninput={kit} />{/if}
        {#if ending === 'until'}<input type="date" aria-label="Bis" bind:value={until} oninput={kit} />{/if}
      </div>
    </div>
  </details>

  {#if problem}<div class="issue">{issueText(problem)}</div>{/if}
  {#if sentence}<div class="sentence">{sentence}</div>{/if}
  {#if next.length > 0}
    <ul class="next">
      {#each next as o}<li>{show(o.start)}</li>{/each}
    </ul>
  {/if}
</div>

<style>
  .rule { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
  .rule > input[type='text'] { width: 100%; }
  .line { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .kit { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
  .inline { display: flex; gap: 4px; align-items: center; font-weight: normal; margin: 0; }
  .inline input[type='number'] { width: 4.5rem; }
  .kit input[type='number'] { width: 5rem; }
  .issue { color: var(--bad); font-size: 13px; }
  .sentence { font-size: 14px; }
  .next { margin: 0; padding-left: 18px; color: var(--muted); font-size: 13px; }
  summary { cursor: pointer; color: var(--accent); }
</style>
