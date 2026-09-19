<script setup lang="ts">
/** Подпись пальцем на экране (docs/20 `require_signature`, решение Б.1): canvas → PNG dataUrl. */
const emit = defineEmits<{ change: [dataUrl: string | null] }>()
const { t } = useI18n()
const canvas = ref<HTMLCanvasElement | null>(null)
const drawing = ref(false)
const hasInk = ref(false)
let ctx: CanvasRenderingContext2D | null = null
onMounted(() => {
  const c = canvas.value!
  const ratio = window.devicePixelRatio || 1
  c.width = c.clientWidth * ratio
  c.height = 160 * ratio
  ctx = c.getContext('2d')
  if (ctx) { ctx.scale(ratio, ratio); ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = getComputedStyle(c).color }
})
function pos(e: PointerEvent) { const r = canvas.value!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
function start(e: PointerEvent) { if (!ctx) return; drawing.value = true; canvas.value!.setPointerCapture(e.pointerId); const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y) }
function move(e: PointerEvent) { if (!drawing.value || !ctx) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); hasInk.value = true }
function end() { if (!drawing.value) return; drawing.value = false; if (hasInk.value) emit('change', canvas.value!.toDataURL('image/png')) }
function clear() { if (!ctx) return; ctx.clearRect(0, 0, canvas.value!.width, canvas.value!.height); hasInk.value = false; emit('change', null) }
</script>
<template>
  <div class="pad">
    <canvas ref="canvas" class="canvas" :aria-label="t('cl.signature')" @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="end" @pointerleave="end" />
    <div class="row"><span class="sub">{{ t('cl.signatureHint') }}</span><button type="button" class="chip" :disabled="!hasInk" @click="clear">{{ t('cl.signatureClear') }}</button></div>
  </div>
</template>
<style scoped>
.pad { display: grid; gap: var(--space-2); }
.canvas { width: 100%; height: 160px; background: var(--color-bg); border: 1px dashed var(--color-bg-line); border-radius: var(--radius-m); color: var(--color-ink); touch-action: none; }
.row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.chip:disabled { opacity: 0.5; }
</style>
