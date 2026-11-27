<script lang="ts">
  import { tick } from 'svelte'
  import { titleOf } from './logic.js'
  import type { Workspace } from './workspace.svelte.js'

  // `height` and `open` belong to the layout of the page (Browse), which has the borders that change them.
  let { ws, height, open = $bindable() }: { ws: Workspace; height: number; open: boolean } = $props()

  let text = $state('')
  let input: HTMLTextAreaElement | undefined = $state()
  let log: HTMLDivElement | undefined = $state()

  // The input grows with its text, up to a limit.
  $effect(() => {
    text
    if (!input) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`
  })

  // The latest message stays in view.
  $effect(() => {
    ws.chat.length
    ws.thinking
    void tick().then(() => log && (log.scrollTop = log.scrollHeight))
  })

  const ready = $derived(ws.staged.filter((s) => s.entry))
  const busy = $derived(ws.staged.some((s) => !s.entry && !s.error))
  let over = $state(false)
  let showLog = $state(false)

  function submit() {
    if (ws.thinking || busy || (!text.trim() && ready.length === 0)) return
    const message = text.trim() ? text : 'Ich habe Dateien hochgeladen.'
    text = ''
    void ws.send(message)
  }

  const take = (files: FileList | File[] | null) => files && ws.stage([...files])

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const subject = $derived(ws.selected ? `Eintrag: ${titleOf(ws.selected)}` : '')
</script>

<section
  class="chat"
  class:closed={!open}
  class:over
  style:height={open ? `${height}px` : undefined}
  aria-label="Chat"
  ondragover={(event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); over = true } }}
  ondragleave={() => (over = false)}
  ondrop={(event) => { event.preventDefault(); over = false; take(event.dataTransfer?.files ?? null) }}
>
  <header>
    <button class="title" onclick={() => (open = !open)} aria-expanded={open}>
      <span class="arrow" aria-hidden="true">{open ? '▾' : '▸'}</span> Chat
    </button>
    {#if subject}<span class="subject" title={subject}>{subject}</span>{/if}
    {#if ws.thinking}<span class="spinner" role="status" aria-label="Der Assistent arbeitet"></span>{/if}
    <span class="spacer"></span>
    {#if open}<button class="link" onclick={() => (showLog = !showLog)} aria-pressed={showLog}>Protokoll</button>{/if}
    {#if open && ws.chat.length > 0}<button class="link" onclick={() => ws.clearChat()} disabled={ws.thinking}>Neu beginnen</button>{/if}
  </header>

  {#if open}
    <div class="log" bind:this={log}>
      {#if showLog}
        {#each ws.log as line}
          <p class="status"><span class="muted">{line.time}</span> {line.text}</p>
        {:else}
          <div class="empty"><span>Noch nichts.</span></div>
        {/each}
      {:else}
      {#each ws.chat as message}
        {#if message.role === 'confirm' && message.pending}
          <div class="confirm" class:over={message.pending.state !== 'open'}>
            <p>{message.text}</p>
            {#if message.pending.state === 'open'}
              <div class="buttons">
                <button class="primary" onclick={() => void ws.confirm(message)}>Ja, {message.pending.label.charAt(0).toLowerCase() + message.pending.label.slice(1)}</button>
                <button onclick={() => ws.dismiss(message)}>Nein</button>
              </div>
            {:else if message.pending.state === 'running'}
              <small class="muted">Einen Moment ...</small>
            {:else}
              <small class="muted">{message.pending.state === 'done' ? 'Erledigt.' : 'Nicht gemacht.'}</small>
            {/if}
          </div>
        {:else if message.undo}
          <div class="statusline">
            <p class="status">{message.text}</p>
            {#if message.undo.state === 'open'}<button class="link" onclick={() => void ws.undo(message)}>Rückgängig</button>{/if}
          </div>
        {:else if message.choices}
          <div class="confirm">
            <p class="assistant">{message.text}</p>
            <div class="buttons">
              {#each message.choices.options as option}
                <button disabled={message.choices.chosen !== undefined || ws.thinking} class:primary={message.choices.chosen === option} onclick={() => { message.choices!.chosen = option; void ws.send(option) }}>{option}</button>
              {/each}
            </div>
          </div>
        {:else}
          <p class={message.role}>{message.text}</p>
        {/if}
      {:else}
        <div class="empty">
          <span>Wobei kann ich helfen?</span>
        </div>
      {/each}
      {#if ws.thinking}<p class="assistant wait" role="status" aria-label="Der Assistent arbeitet"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></p>{/if}
      {/if}
    </div>

    {#if ws.staged.length > 0}
      <ul class="staged">
        {#each ws.staged as file (file.id)}
          <li class:bad={file.error}>
            <span class="name" title={file.error ?? file.name}>{file.name}</span>
            {#if file.error}<span class="muted">{file.error}</span>{:else if !file.entry}<progress value={file.fraction}></progress>{/if}
            <button class="link" onclick={() => ws.unstage([file.id])} aria-label="Entfernen">×</button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="composer">
      <label class="attach" aria-label="Dateien anhängen" title="Dateien anhängen">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.5l-8.5 8.5a5 5 0 01-7-7L14 5.5a3.2 3.2 0 014.5 4.5L10 18.5a1.4 1.4 0 01-2-2L15 9.5" /></svg>
        <input type="file" multiple hidden onchange={(event) => { take(event.currentTarget.files); event.currentTarget.value = '' }} />
      </label>
      <textarea bind:this={input} bind:value={text} {onkeydown} rows="1" placeholder="Schreib in den Chat ..."></textarea>
      <button class="send" onclick={submit} disabled={ws.thinking || busy || (!text.trim() && ready.length === 0)} aria-label="Senden" class:working={ws.thinking}>
        {#if ws.thinking}<span class="spinner light" aria-hidden="true"></span>{:else}<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>{/if}
      </button>
    </div>
  {/if}
</section>

<style>
  .confirm { align-self: flex-start; max-width: 90%; display: flex; flex-direction: column; gap: 16px; white-space: pre-wrap; }
  .confirm p { margin: 0; padding: 2px 0; max-width: none; align-self: flex-start; }
  .confirm.over p { color: var(--muted); }
  .confirm .buttons { display: flex; gap: 6px; }
  .statusline { display: flex; align-items: flex-start; gap: 10px; }
  .statusline .link { font-size: 12px; padding: 0; white-space: nowrap; }
  .chat { display: flex; flex-direction: column; min-height: 0; max-height: calc(100% - 120px); flex: none; background: var(--paper); border: 1px solid var(--line); border-radius: 8px; }
  .chat.over { border-color: var(--accent); background: var(--accent-wash); }
  .staged { list-style: none; margin: 0 12px 6px; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
  .staged li { display: flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px; font-size: 12px; max-width: 100%; }
  .staged li.bad { border-color: var(--bad); }
  .staged .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 16rem; }
  .staged progress { width: 60px; height: 6px; }
  .attach { display: grid; place-items: center; width: 26px; flex: none; cursor: pointer; color: var(--muted); }
  .chat.closed { height: auto; flex: none; }
  header { display: flex; align-items: center; gap: 10px; padding: 6px 12px; min-width: 0; }
  .title { flex: none; white-space: nowrap; border: 0; background: none; padding: 2px 0; font-weight: 600; cursor: pointer; }
  .arrow { display: inline-block; width: 1em; color: var(--muted); }
  .subject { font-size: 12px; color: var(--accent); background: var(--accent-wash); padding: 1px 8px; border-radius: 999px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .spacer { flex: 1; }
  header .link { flex: none; white-space: nowrap; }
  .log { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 4px 12px 8px; }
  p { margin: 0; padding: 6px 10px; border-radius: 8px; max-width: 88%; white-space: pre-line; font-size: 14px; }
  .user { align-self: flex-end; background: var(--accent-wash); }
  .assistant { align-self: flex-start; background: var(--wash); }
  .status { align-self: flex-start; max-width: none; padding: 0 0 0 8px; border-left: 3px solid var(--line); border-radius: 0; color: var(--muted); font-size: 12px; }
  .wait { color: var(--muted); display: flex; align-items: center; gap: 8px; }
  .spinner { width: 10px; height: 10px; border: 1.5px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  .spinner.light { width: 12px; height: 12px; border-color: rgba(255, 255, 255, 0.4); border-top-color: #fff; }
  .send.working:disabled { background: var(--accent); }
  .dots { display: inline-flex; gap: 4px; align-items: center; height: 1.4em; }
  .dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); opacity: 0.35; animation: pulse 1.2s ease-in-out infinite; }
  .dots i:nth-child(2) { animation-delay: 0.2s; }
  .dots i:nth-child(3) { animation-delay: 0.4s; }
  @keyframes pulse { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { margin: auto; text-align: center; display: flex; flex-direction: column; gap: 4px; color: var(--muted); max-width: 30rem; }
  .composer { position: relative; display: flex; margin: 0 12px 10px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 10px; background: #fff; }
  .composer:focus-within { border-color: var(--accent); }
  textarea { flex: 1; resize: none; font: inherit; line-height: 1.4; min-height: 1.4em; padding: 2px 36px 2px 4px; border: 0; outline: none; background: transparent; }
  .composer textarea, .composer textarea:focus { border: 0; outline: none; box-shadow: none; background: transparent; }
  .send { position: absolute; right: 6px; bottom: 6px; width: 26px; height: 26px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: var(--accent); color: #fff; cursor: pointer; }
  .send:disabled { background: var(--line); cursor: default; }
</style>
