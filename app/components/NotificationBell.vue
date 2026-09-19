<script setup lang="ts">
/** Колокольчик (docs/23 §5.5): последние 50, непрочитанные выделены, клик ведёт к предмету, «Позначити все прочитаним». */
const { t } = useI18n()
const { api } = useApi()
const { me } = useAuth()
interface Item { id: string, code: string, text: string, createdAt: string, readAt: string | null, url: string | null }
const open = ref(false)
const items = ref<Item[]>([])
const unread = ref(0)
async function load() { if (!me.value) return; try { const r = await api<{ items: Item[], unread: number }>('/notifications/inbox'); items.value = r.items; unread.value = r.unread } catch { /* тихо */ } }
onMounted(() => { load(); const t = setInterval(load, 60_000); onUnmounted(() => clearInterval(t)) })
async function readAll() { await api('/notifications/inbox/read', { method: 'POST', body: {} }); await load() }
async function go(i: Item) { if (!i.readAt) await api('/notifications/inbox/read', { method: 'POST', body: { ids: [i.id] } }).catch(() => null); open.value = false; if (i.url) navigateTo(i.url); else load() }
const fmt = (d: string) => new Date(d).toLocaleString('uk', { dateStyle: 'short', timeStyle: 'short' })
</script>
<template>
  <div class="bell-wrap">
    <button class="bell" :aria-label="t('notif.bell')" :aria-expanded="open" @click="open = !open">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6M10.5 20a2 2 0 0 0 3 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      <span v-if="unread" class="cnt">{{ unread > 50 ? '50+' : unread }}</span>
    </button>
    <div v-if="open" class="panel" role="dialog">
      <div class="head"><b>{{ t('notif.title') }}</b><button v-if="unread" class="chip" @click="readAll">{{ t('notif.readAll') }}</button><NuxtLink to="/learn/notifications" class="chip" @click="open = false">{{ t('notif.settings') }}</NuxtLink></div>
      <p v-if="items.length === 0" class="sub">{{ t('notif.empty') }}</p>
      <ul class="list">
        <li v-for="i in items" :key="i.id" :class="['item', { unread: !i.readAt }]">
          <button class="itembtn" @click="go(i)"><span class="text">{{ i.text }}</span><span class="sub">{{ fmt(i.createdAt) }}</span></button>
        </li>
      </ul>
    </div>
    <div v-if="open" class="backdrop" @click="open = false" />
  </div>
</template>
<style scoped>
.bell-wrap { position: relative; }
.bell { font: inherit; border: none; background: transparent; cursor: pointer; position: relative; min-width: 44px; min-height: 44px; color: var(--color-ink); display: grid; place-items: center; }
.bell svg { width: 24px; height: 24px; }
.cnt { position: absolute; top: 2px; right: 0; min-width: 17px; height: 17px; background: var(--color-coral); color: var(--color-ink); font-size: 10px; font-weight: 900; border-radius: var(--radius-pill); padding: 0 4px; line-height: 17px; text-align: center; }
.panel { position: absolute; right: 0; top: 100%; z-index: 30; width: min(360px, 92vw); background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); border-radius: var(--radius-l); box-shadow: 0 12px 32px rgb(0 0 0 / 14%); padding: var(--space-3); display: grid; gap: var(--space-2); max-height: 70dvh; overflow: auto; }
.backdrop { position: fixed; inset: 0; z-index: 29; }
.head { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.head b { flex: 1; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: 2px var(--space-3); cursor: pointer; text-decoration: none; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.item { border-radius: var(--radius-m); }
.item.unread { background: var(--color-bg); border-left: 3px solid var(--color-sun); }
.itembtn { font: inherit; text-align: left; border: none; background: transparent; cursor: pointer; width: 100%; padding: var(--space-2); display: grid; gap: 2px; color: var(--color-ink); }
.text { font-size: var(--font-size-body-s); }
.sub { font-size: 11px; color: var(--color-ink-faint); margin: 0; }
</style>
