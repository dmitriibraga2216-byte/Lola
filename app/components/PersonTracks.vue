<script setup lang="ts">
import { formatHms } from '#shared/domain/personTracks'
import type { PersonTracks as PersonTracksDto, TrackGroup, TrackItem } from '#shared/domain/personTracks'

/**
 * «Призначені треки» карточки человека (docs/v2/38-people-extensions.md §5.1, §7.15;
 * docs/v2/33-lifecycle.md §5.3 — группировка по этапам; П-16.2; PR-35).
 *
 * Сервер считает, клиент показывает: группы, их порядок, плоский вид этапа без `progress`,
 * светофор срока и метрики времени приходят готовыми (`GET /people/:id/tracks`). Этап без
 * назначений — строкой «{Етап} — немає призначень» со ссылкой «Управління треками».
 * «Плановий час» и «Час проходження» показываются тому, кому видно время человека.
 * Ответ грузит страница карточки: из него же шапка берёт текущий этап («Онбординг, з 14.03»).
 */
const props = defineProps<{ data: PersonTracksDto | null, loading: boolean, failed: boolean }>()
const emit = defineEmits<{ retry: [] }>()

const { t } = useI18n()
const { hasScope } = useAuth()
const { formatShortDate } = useFormat()

const empty = computed(() => !!props.data && props.data.groups.every(g => g.items.length === 0))
const groupName = (g: TrackGroup) => g.stage?.name ?? t('personTracks.noStage')
const fmt = (iso: string) => formatShortDate(new Date(iso))
/** Окружность индикатора: длина дуги под процент (r = 18, как в разметке ниже). */
const CIRC = 2 * Math.PI * 18
const dash = (it: TrackItem) => `${(CIRC * Math.min(100, it.progressPct ?? 0)) / 100} ${CIRC}`
const lightText = (it: TrackItem) => (it.light === 'overdue' ? t('personTracks.overdue') : it.light === 'soon' ? t('personTracks.soon') : '')
</script>

<template>
  <section class="tracks card" :aria-busy="loading">
    <h2>{{ t('personTracks.title') }}</h2>

    <div v-if="loading && !data" class="skeleton" aria-hidden="true"><span /><span /><span /></div>
    <div v-else-if="failed" class="state" role="alert">
      <p>{{ t('personTracks.loadFailed') }}</p>
      <button type="button" class="btn" @click="emit('retry')">{{ t('personTracks.retry') }}</button>
    </div>
    <template v-else-if="data">
      <p v-if="empty" class="muted">{{ t('personTracks.empty') }}</p>
      <div v-for="g in data.groups" :key="g.stage?.id ?? 'none'" class="group">
        <p v-if="g.items.length === 0" class="stage-empty">
          <span :class="['dot', `c-${g.stage?.color ?? 'ink'}`]" aria-hidden="true" />
          {{ t('personTracks.stageEmpty', { stage: groupName(g) }) }}
          <NuxtLink v-if="hasScope('assignment.create')" to="/admin/assignments" class="link">{{ t('personTracks.manage') }}</NuxtLink>
        </p>
        <template v-else>
          <h3><span :class="['dot', `c-${g.stage?.color ?? 'ink'}`]" aria-hidden="true" />{{ groupName(g) }} <span class="count">{{ g.items.length }}</span></h3>
          <!-- Этап без «прогресу» (база знань): плоский список — назва і дата призначення (`33` §5.3) -->
          <ul v-if="g.flat" class="flat">
            <li v-for="it in g.items" :key="it.enrollmentId"><b>{{ it.title }}</b> <span class="muted">{{ t('personTracks.assigned', { date: fmt(it.assignedAt) }) }}</span></li>
          </ul>
          <ul v-else class="cards">
            <li v-for="it in g.items" :key="it.enrollmentId" class="track">
              <span :class="['cover', `c-${g.stage?.color ?? 'ink'}`]" aria-hidden="true">{{ it.title.slice(0, 1) }}</span>
              <div class="body">
                <b class="name">{{ it.title }}</b>
                <dl>
                  <div><dt>{{ t('personTracks.assignedLabel') }}</dt><dd>{{ fmt(it.assignedAt) }}</dd></div>
                  <div v-if="g.showDeadline">
                    <dt>{{ t('personTracks.dueLabel') }}</dt>
                    <dd v-if="it.dueAt" :class="['due', it.light]">{{ fmt(it.dueAt) }}<span v-if="lightText(it)" class="sr-only"> — {{ lightText(it) }}</span></dd>
                    <dd v-else class="due none">{{ t('personTracks.noDue') }}</dd>
                  </div>
                  <div><dt>{{ t('personTracks.modulesLabel') }}</dt><dd>{{ it.modulesDone }}/{{ it.modulesTotal }}</dd></div>
                  <template v-if="data.timeVisible">
                    <div><dt>{{ t('personTracks.plannedLabel') }}</dt><dd>{{ it.plannedSeconds === null ? '—' : formatHms(it.plannedSeconds) }}</dd></div>
                    <div><dt>{{ t('personTracks.spentLabel') }}</dt><dd>{{ formatHms(it.spentSeconds) }}</dd></div>
                  </template>
                </dl>
                <span v-if="it.deadlineShifted" class="badge">{{ t('person.deadlineShifted') }}</span>
              </div>
              <svg class="ring" viewBox="0 0 44 44" width="44" height="44" role="img" :aria-label="t('personTracks.progress', { n: it.progressPct ?? 0 })">
                <circle class="rail" cx="22" cy="22" r="18" />
                <circle class="bar" cx="22" cy="22" r="18" :stroke-dasharray="dash(it)" transform="rotate(-90 22 22)" />
                <text x="22" y="26" text-anchor="middle">{{ it.progressPct ?? 0 }}%</text>
              </svg>
            </li>
          </ul>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-4); min-width: 0; }
h2 { margin: 0 0 var(--space-3); font-size: var(--font-size-body); color: var(--color-ink-muted); }
h3 { margin: 0 0 var(--space-2); font-size: var(--font-size-body); display: flex; align-items: center; gap: var(--space-2); }
.count { color: var(--color-ink-faint); font-weight: 700; font-size: var(--font-size-body-s); }
.group + .group { margin-top: var(--space-3); }
.dot { width: 10px; height: 10px; border-radius: 50%; flex: none; display: inline-block; }
.c-ink { background: var(--color-ink); color: var(--color-bg-soft); }
.c-sun { background: var(--color-sun); color: var(--color-sun-ink); }
.c-teal { background: var(--color-teal); color: var(--color-teal-deep); }
.c-coral { background: var(--color-coral); color: var(--color-coral-deep); }
.stage-empty { margin: 0; display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.flat { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.cards { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-2); }
.track { display: flex; gap: var(--space-3); align-items: flex-start; background: var(--color-bg); border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-m); padding: var(--space-3); min-width: 0; }
.cover { width: 40px; height: 40px; border-radius: var(--radius-s); display: grid; place-items: center; font-weight: 900; flex: none; }
.body { min-width: 0; flex: 1; display: grid; gap: var(--space-1); }
.name { overflow-wrap: anywhere; }
dl { margin: 0; display: grid; gap: 2px; }
dl div { display: flex; gap: var(--space-1); flex-wrap: wrap; font-size: var(--font-size-body-s); }
dt { color: var(--color-ink-faint); }
dt::after { content: ':'; }
dd { margin: 0; }
.due.ok { color: var(--color-teal-ink); font-weight: 700; }
.due.soon { color: var(--color-sun-ink); font-weight: 700; background: var(--color-sun-soft); border-radius: var(--radius-pill); padding: 0 var(--space-1); }
.due.overdue { color: var(--color-coral-ink); font-weight: 700; }
.due.none { color: var(--color-ink-faint); }
.ring { flex: none; }
.ring .rail { fill: none; stroke: var(--color-bg-line); stroke-width: 4; }
.ring .bar { fill: none; stroke: var(--color-teal); stroke-width: 4; stroke-linecap: round; }
.ring text { font-size: var(--font-size-body-s); font-weight: 800; fill: var(--color-ink); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); color: var(--color-ink-muted); width: fit-content; }
.link { color: var(--color-teal-ink); font-weight: 700; text-decoration: none; }
.muted { color: var(--color-ink-faint); font-size: var(--font-size-body-s); }
.state { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; color: var(--color-coral-ink); }
.state p { margin: 0; }
.btn { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.skeleton { display: grid; gap: var(--space-2); }
.skeleton span { display: block; height: 56px; border-radius: var(--radius-m); background: var(--color-bg-line-soft); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 400px) { .cards { grid-template-columns: 1fr; } }
</style>
