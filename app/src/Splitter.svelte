<script lang="ts">
  // A border between two panes that can be dragged (or moved with the arrow keys) to change the size of one of them. It shows nothing
  // of its own: the cursor tells where it is.
  // `value` is that size in pixels; `invert` is for a pane that grows when the border moves toward the start (the right one, the lower one).
  let {
    direction,
    value,
    min,
    max,
    invert = false,
    label,
    onchange,
  }: { direction: 'vertical' | 'horizontal'; value: number; min: number; max: number; invert?: boolean; label: string; onchange: (value: number) => void } = $props()

  const clamp = (v: number) => Math.round(Math.max(min, Math.min(v, Math.max(min, max))))

  function down(event: PointerEvent) {
    const bar = event.currentTarget as HTMLElement
    // Dragging must not select text in the panes next to it (that flashes blue): nothing is selectable until the bar is let go.
    event.preventDefault()
    bar.focus()
    const body = document.body
    const before = { select: body.style.userSelect, cursor: body.style.cursor }
    body.style.userSelect = 'none'
    body.style.cursor = direction === 'vertical' ? 'col-resize' : 'row-resize'
    getSelection()?.removeAllRanges()
    const vertical = direction === 'vertical'
    const start = vertical ? event.clientX : event.clientY
    const from = value
    bar.setPointerCapture(event.pointerId)
    const move = (e: PointerEvent) => onchange(clamp(from + (invert ? -1 : 1) * ((vertical ? e.clientX : e.clientY) - start)))
    const stop = () => {
      body.style.userSelect = before.select
      body.style.cursor = before.cursor
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', stop)
      bar.removeEventListener('pointercancel', stop)
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', stop)
    bar.addEventListener('pointercancel', stop)
  }

  function key(event: KeyboardEvent) {
    const grow = direction === 'vertical' ? 'ArrowRight' : 'ArrowDown'
    const shrink = direction === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
    if (event.key !== grow && event.key !== shrink) return
    event.preventDefault()
    onchange(clamp(value + ((event.key === grow ? 1 : -1) * (invert ? -1 : 1) * 24)))
  }
</script>

<!-- A separator that can be moved is a widget (ARIA: window splitter), so it takes the focus and the keys. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="splitter {direction}"
  role="separator"
  aria-orientation={direction === 'vertical' ? 'vertical' : 'horizontal'}
  aria-label={label}
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  tabindex="0"
  onpointerdown={down}
  onkeydown={key}
></div>

<style>
  .splitter { touch-action: none; flex: none; }
  .splitter.vertical { width: 12px; cursor: col-resize; }
  .splitter.horizontal { height: 12px; cursor: row-resize; }
  .splitter:focus { outline: none; }
</style>
