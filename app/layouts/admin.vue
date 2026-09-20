<script setup lang="ts">
/**
 * Каркас админки по мокапам (docs/31 «Общие элементы», screens/Main.html):
 * слева пять разделов с подпунктами у активного, внизу карточка человека с ролью;
 * страница сама рисует шапку через <PageHeader>.
 */
const { t } = useI18n()
const { me, logout, hasScope, moduleOn, initials, switchRole } = useAuth()
const route = useRoute()

interface Item { to: string, label: string, show: boolean }

/** Страница → модуль (docs/24 §3.2): выключенный модуль исчезает из меню; список — как в server/services/modules MODULE_PAGES. */
const PAGE_MODULES: [string, string][] = [
  ['/admin/workshops', 'workshops'], ['/admin/review-workshops', 'workshops'], ['/admin/programs', 'programs'], ['/admin/trajectories', 'trajectories'], ['/admin/rules', 'trajectories'],
  ['/admin/meetups/complex', 'complexTests'], ['/admin/meetups', 'meetups'], ['/admin/development', 'development'], ['/admin/assessment', 'assessment'], ['/admin/checklists', 'assessment'],
  ['/admin/knowledge', 'knowledge'], ['/admin/news', 'news'], ['/admin/notices', 'notices'], ['/admin/simple-notices', 'notices'], ['/admin/events', 'events'],
]
function moduleOfPage(to: string): string | null {
  return [...PAGE_MODULES].sort((a, b) => b[0].length - a[0].length).find(([p]) => to === p || to.startsWith(`${p}/`))?.[1] ?? null
}
interface Section { key: string, label: string, icon: string, items: Item[] }

const sections = computed<Section[]>(() => [
  { key: 'learning', label: t('admin.section.learning'), icon: 'book', items: [
    { to: '/admin/assignments', label: t('admin.nav.assignments'), show: hasScope('assignment.create') },
    { to: '/admin/trajectories', label: t('admin.nav.trajectories'), show: hasScope('program.manage') },
    { to: '/admin/review-workshops', label: t('admin.nav.reviewWorkshops'), show: hasScope('review.queue') },
    { to: '/admin/review', label: t('admin.nav.review'), show: hasScope('review.queue') },
    { to: '/admin/attempt-requests', label: t('admin.nav.attemptRequests'), show: hasScope('review.grade') },
    { to: '/admin/rules', label: t('admin.nav.rules'), show: hasScope('settings.tenant') },
    { to: '/admin/profiles', label: t('admin.nav.profiles'), show: hasScope('assignment.create') },
    { to: '/admin/knowledge', label: t('admin.nav.knowledge'), show: hasScope('knowledge.manage') },
    { to: '/admin/news', label: t('admin.nav.news'), show: hasScope('knowledge.manage') },
    // Інформація (docs/21 §14, Spec 21)
    { to: '/admin/notices', label: t('admin.nav.notices'), show: hasScope('knowledge.manage') },
    { to: '/admin/simple-notices', label: t('admin.nav.simpleNotices'), show: hasScope('knowledge.manage') },
    { to: '/admin/events', label: t('admin.nav.events'), show: hasScope('meetup.manage') },
    { to: '/admin/birthdays', label: t('admin.nav.birthdays'), show: hasScope('people.view') },
    { to: '/admin/contacts', label: t('admin.nav.contacts'), show: hasScope('people.view') },
    { to: '/admin/knowledge/access', label: t('admin.nav.kbAccess'), show: hasScope('knowledge.manage') },
    { to: '/admin/assessment/cycles', label: t('admin.nav.assessCycles'), show: hasScope('assessment.run') },
    { to: '/admin/checklists', label: t('admin.nav.checklists'), show: hasScope('checklist.manage') },
  ] },
  { key: 'content', label: t('admin.section.content'), icon: 'doc', items: [
    { to: '/admin/resources', label: t('admin.nav.resources'), show: hasScope('course.view') },
    { to: '/admin/courses', label: t('admin.nav.courses'), show: hasScope('course.view') },
    { to: '/admin/programs', label: t('admin.nav.programs'), show: hasScope('program.manage') },
    { to: '/admin/quizzes', label: t('admin.nav.quizzes'), show: hasScope('course.view') },
    { to: '/admin/workshops', label: t('admin.nav.workshops'), show: hasScope('course.view') },
    { to: '/admin/meetups/complex', label: t('admin.nav.complexTests'), show: hasScope('complextest.manage') },
    { to: '/admin/surveys', label: t('admin.nav.surveys'), show: hasScope('survey.manage') },
    { to: '/admin/meetups', label: t('admin.nav.meetups'), show: hasScope('meetup.manage') || hasScope('meetup.attendance') },
    { to: '/admin/assessment/criteria', label: t('admin.nav.assessCriteria'), show: hasScope('assessment.manage') },
    { to: '/admin/resources/categories', label: t('admin.nav.resourceCategories'), show: hasScope('course.edit') },
  ] },
  { key: 'people', label: t('admin.section.people'), icon: 'people', items: [
    { to: '/admin/people', label: t('admin.nav.people'), show: hasScope('people.view') },
    { to: '/admin/people/groups', label: t('admin.nav.groups'), show: hasScope('people.view') },
    { to: '/admin/org', label: t('admin.nav.org'), show: hasScope('people.view') },
    { to: '/admin/refs', label: t('admin.nav.refs'), show: hasScope('people.view') },
    { to: '/admin/import', label: t('admin.nav.import'), show: hasScope('people.import') },
    { to: '/admin/development/competencies', label: t('admin.nav.competencies'), show: hasScope('competency.manage') },
    { to: '/admin/development/profiles', label: t('admin.nav.positionProfiles'), show: hasScope('position_profile.manage') },
    { to: '/admin/development/team', label: t('admin.nav.teamGoals'), show: hasScope('development.team') },
    { to: '/admin/development/matrix', label: t('admin.nav.matrix'), show: hasScope('development.team') },
    { to: '/admin/development/strategic', label: t('admin.nav.strategic'), show: hasScope('development.team') },
    { to: '/admin/development/requests', label: t('admin.nav.requests'), show: hasScope('request.decide') },
    { to: '/admin/development/statuses', label: t('admin.nav.goalStatuses'), show: hasScope('development.manage') },
    { to: '/admin/development/settings', label: t('admin.nav.devSettings'), show: hasScope('development.manage') },
  ] },
  { key: 'reports', label: t('admin.section.reports'), icon: 'chart', items: [
    { to: '/admin/reports', label: t('admin.nav.reports'), show: hasScope('report.team') },
    { to: '/admin/reports/summary', label: t('admin.nav.summaryReport'), show: hasScope('report.team') },
    { to: '/admin/reports/tasks/test', label: t('admin.nav.taskReports'), show: hasScope('report.team') },
    { to: '/admin/reports/builder', label: t('admin.nav.reportBuilder'), show: hasScope('report.builder') },
    { to: '/admin/reports/people', label: t('admin.nav.peopleReport'), show: hasScope('report.team') },
    { to: '/admin/checklists/report', label: t('admin.nav.checklistReport'), show: hasScope('report.team') },
    { to: '/admin/meetups/report', label: t('admin.nav.attendanceReport'), show: hasScope('report.team') },
    { to: '/admin/development/reports', label: t('admin.nav.devReports'), show: hasScope('report.team') },
    { to: '/admin/knowledge/report', label: t('admin.nav.kbReport'), show: hasScope('knowledge.manage') },
    { to: '/admin/journals', label: t('admin.nav.journals'), show: hasScope('audit.view') },
  ] },
  { key: 'settings', label: t('admin.section.settings'), icon: 'gear', items: [
    { to: '/admin/settings/notifications', label: t('admin.nav.notifications'), show: hasScope('settings.notifications') },
    { to: '/admin/settings/integrations', label: t('admin.nav.integrations'), show: hasScope('settings.integrations') },
    { to: '/admin/settings/guest-page', label: t('admin.nav.guestPage'), show: hasScope('settings.tenant') },
    { to: '/admin/settings/policies', label: t('admin.nav.policies'), show: hasScope('settings.tenant') },
    { to: '/admin/settings/roles', label: t('admin.nav.roles'), show: hasScope('settings.tenant') },
    { to: '/admin/settings/scales', label: t('admin.nav.scales'), show: hasScope('settings.tenant') },
    { to: '/admin/settings/translations', label: t('admin.nav.translations'), show: hasScope('settings.tenant') },
    { to: '/admin/settings/usage', label: t('admin.nav.usage'), show: hasScope('settings.tenant') },
    { to: '/admin/certificates', label: t('admin.nav.certificates'), show: hasScope('report.team') },
  ] },
].map(s => ({ ...s, items: s.items.filter((i) => {
  const m = moduleOfPage(i.to)
  return i.show && (!m || moduleOn(m))
}) })).filter(s => s.items.length > 0))

/** Активный раздел — тот, чей пункт лучше всего совпадает с текущим путём (самый длинный префикс). */
const activeKey = computed(() => {
  let best: { key: string, len: number } | null = null
  for (const s of sections.value) {
    for (const i of s.items) {
      if ((route.path === i.to || route.path.startsWith(`${i.to}/`)) && (!best || i.to.length > best.len)) best = { key: s.key, len: i.to.length }
    }
  }
  return best?.key ?? sections.value[0]?.key
})
// На десктопе раскрыт активный раздел; на узком экране подпункты — выпадающий список только по клику
const opened = ref<string | null>(null)
const narrow = ref(false)
onMounted(() => {
  const mq = window.matchMedia('(max-width: 860px)')
  narrow.value = mq.matches
  mq.addEventListener('change', e => { narrow.value = e.matches })
})
const isOpen = (key: string) => (opened.value ?? (narrow.value ? null : activeKey.value)) === key
watch(() => route.path, () => { opened.value = null })

const menuOpen = ref(false)
// Карточка человека по мокапу Main: под именем — активная роль (docs/01 §1.9.2), в меню — все роли для переключения
const roleName = computed(() => me.value?.activeRole?.name ?? '')
const roleList = computed(() => me.value?.roles ?? [])
const switching = ref(false)
const switchError = ref('')
async function pickRole(id: string) {
  if (switching.value || id === me.value?.activeRole?.id) { menuOpen.value = false; return }
  switching.value = true
  switchError.value = ''
  try {
    await switchRole(id)
    menuOpen.value = false
  }
  catch (err) {
    switchError.value = apiErrorOf(err).message
  }
  finally {
    switching.value = false
  }
}
</script>

<template>
  <div class="admin">
    <aside class="side">
      <NuxtLink to="/" class="brand" :aria-label="t('app.name')">
        <span class="dot sun" /><span class="dot teal" /><span class="dot coral" /><span class="dot ink" />
      </NuxtLink>
      <nav class="nav">
        <div v-for="s in sections" :key="s.key" class="section">
          <button :class="['section-btn', { on: activeKey === s.key }]" :aria-expanded="isOpen(s.key)" @click="opened = isOpen(s.key) ? '' : s.key">
            <svg class="icon" viewBox="0 0 20 20" aria-hidden="true">
              <path v-if="s.icon === 'book'" d="M4 3h9a3 3 0 0 1 3 3v11H6a2 2 0 0 0-2 2V3zm2 2v11.2A4 4 0 0 1 7 16h7V6a1 1 0 0 0-1-1H6z" fill="currentColor" />
              <path v-else-if="s.icon === 'doc'" d="M5 2h7l4 4v12H5V2zm2 2v12h7V7h-3V4H7z" fill="currentColor" />
              <path v-else-if="s.icon === 'people'" d="M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2 17c0-2.8 2.2-5 5-5s5 2.2 5 5H2zm10 0c0-1.5-.5-2.8-1.3-3.9.4-.1.9-.1 1.3-.1 2.2 0 4 1.8 4 4h-4z" fill="currentColor" />
              <path v-else-if="s.icon === 'chart'" d="M3 3h2v13h12v2H3V3zm4 8h2v4H7v-4zm4-4h2v8h-2V7zm4 2h2v6h-2V9z" fill="currentColor" />
              <path v-else d="M10 6.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zm0 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM9 2h2l.4 2.1 1.7.7 1.8-1.2 1.4 1.4-1.2 1.8.7 1.7L18 9v2l-2.1.4-.7 1.7 1.2 1.8-1.4 1.4-1.8-1.2-1.7.7L11 18H9l-.4-2.1-1.7-.7-1.8 1.2-1.4-1.4 1.2-1.8-.7-1.7L2 11V9l2.1-.4.7-1.7-1.2-1.8 1.4-1.4 1.8 1.2 1.7-.7L9 2z" fill="currentColor" />
            </svg>
            <span>{{ s.label }}</span>
          </button>
          <div v-show="isOpen(s.key)" class="items">
            <NuxtLink v-for="i in s.items" :key="i.to" :to="i.to" class="item" @click="opened = narrow ? '' : opened">{{ i.label }}</NuxtLink>
          </div>
        </div>
      </nav>
      <div class="side-footer">
        <NotificationBell />
        <button class="who" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">
          <span class="avatar">{{ initials }}</span>
          <span class="who-text">
            <b>{{ me?.user.fullName }}</b>
            <small>{{ roleName || me?.tenant.name }}</small>
          </span>
          <span class="chevron" aria-hidden="true">⌄</span>
        </button>
        <div v-if="menuOpen" class="menu" role="menu">
          <template v-if="roleList.length > 1">
            <small class="menu-label">{{ t('admin.menu.roleSwitch') }}</small>
            <button v-for="r in roleList" :key="r.id" class="menu-item role-item" role="menuitemradio" :aria-checked="r.id === me?.activeRole?.id" :disabled="switching" @click="pickRole(r.id)">
              <span class="check" aria-hidden="true">{{ r.id === me?.activeRole?.id ? '●' : '○' }}</span>{{ r.name }}
            </button>
            <p v-if="switchError" class="menu-error" role="alert">{{ switchError }}</p>
            <hr class="menu-sep">
          </template>
          <NuxtLink to="/learn" class="menu-item" @click="menuOpen = false">{{ t('admin.menu.learner') }}</NuxtLink>
          <NuxtLink to="/learn/profile" class="menu-item" @click="menuOpen = false">{{ t('admin.menu.profile') }}</NuxtLink>
          <button class="menu-item" @click="logout">{{ t('home.logout') }}</button>
        </div>
      </div>
    </aside>
    <main class="content">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.admin { min-height: 100dvh; display: grid; grid-template-columns: 236px minmax(0, 1fr); max-width: 100vw; overflow-x: clip; background: var(--color-bg); font-family: var(--font-family); color: var(--color-ink); }
.side { position: sticky; top: 0; height: 100dvh; display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-5) var(--space-3) var(--space-3); background: var(--color-bg-soft); border-right: 1px solid var(--color-bg-line-soft); box-sizing: border-box; }
.brand { display: inline-flex; gap: 4px; padding: 0 var(--space-2); }
.dot { width: 20px; height: 20px; border-radius: 5px; }
.dot.sun { background: var(--color-sun); }
.dot.teal { background: var(--color-teal); }
.dot.coral { background: var(--color-coral); }
.dot.ink { background: var(--color-ink); }
.nav { display: grid; gap: var(--space-1); overflow-y: auto; }
.section-btn { font: inherit; font-weight: 700; display: flex; align-items: center; gap: var(--space-3); width: 100%; text-align: left; border: none; background: transparent; color: var(--color-ink); border-radius: var(--radius-s); padding: var(--space-3) var(--space-3); cursor: pointer; }
.section-btn.on { background: var(--color-bg); font-weight: 800; }
.icon { width: 18px; height: 18px; color: var(--color-ink-muted); flex: none; }
.items { display: grid; gap: 2px; padding: var(--space-1) 0 var(--space-2) 40px; }
.item { font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); text-decoration: none; padding: var(--space-1) var(--space-2); border-radius: var(--radius-s); }
.item.router-link-active { color: var(--color-ink); background: var(--color-bg); }
.side-footer { margin-top: auto; position: relative; border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-3); display: grid; gap: var(--space-2); }
.who { font: inherit; display: flex; align-items: center; gap: var(--space-2); width: 100%; border: none; background: transparent; padding: var(--space-1); border-radius: var(--radius-s); cursor: pointer; text-align: left; color: var(--color-ink); }
.who-text { display: grid; min-width: 0; }
.who-text b { font-size: var(--font-size-body-s); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.who-text small { font-size: 12px; color: var(--color-ink-muted); font-weight: 700; }
.chevron { margin-left: auto; color: var(--color-ink-muted); }
.menu { position: absolute; bottom: 100%; left: 0; right: 0; background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1); display: grid; gap: 2px; margin-bottom: var(--space-2); }
.menu-item { font: inherit; font-weight: 700; font-size: var(--font-size-body-s); text-align: left; border: none; background: transparent; color: var(--color-ink); text-decoration: none; padding: var(--space-2) var(--space-3); border-radius: var(--radius-s); cursor: pointer; }
.menu-item:hover { background: var(--color-bg); }
.menu-label { font-size: 12px; font-weight: 700; color: var(--color-ink-muted); padding: var(--space-1) var(--space-3) 0; }
.role-item { display: flex; align-items: center; gap: var(--space-2); }
.role-item[aria-checked="true"] { color: var(--color-teal-ink); }
.role-item:disabled { opacity: .6; cursor: progress; }
.check { width: 1em; color: var(--color-teal); }
.menu-sep { border: none; border-top: 1px solid var(--color-bg-line-soft); margin: var(--space-1) 0; }
.menu-error { margin: 0; padding: 0 var(--space-3); font-size: 12px; color: var(--color-coral-ink); }
.content { min-width: 0; padding: var(--space-5) var(--space-6) var(--space-6); overflow-x: clip; }
@media (max-width: 860px) {
  .admin { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr; align-content: start; }
  .side { position: relative; z-index: 25; height: auto; min-width: 0; max-width: 100vw; flex-direction: row; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-right: none; border-bottom: 1px solid var(--color-bg-line-soft); }
  .brand { padding: 0; }
  .dot { width: 14px; height: 14px; border-radius: 4px; }
  .nav { display: flex; flex: 1 1 0; min-width: 0; gap: 2px; overflow-x: auto; overflow-y: visible; }
  .section { position: static; }
  .section-btn { padding: var(--space-2); white-space: nowrap; font-size: var(--font-size-body-s); }
  .section-btn .icon { display: none; }
  .items { position: absolute; top: 100%; left: 0; right: 0; z-index: 30; background: var(--color-bg-soft); border-bottom: 1px solid var(--color-bg-line); padding: var(--space-2) var(--space-3); display: flex; flex-wrap: wrap; gap: var(--space-1); }
  .side-footer { margin-top: 0; border-top: none; padding-top: 0; display: flex; align-items: center; gap: 0; }
  .who { width: auto; padding: 0; }
  .who-text, .chevron { display: none; }
  .menu { bottom: auto; top: 100%; left: auto; right: 0; min-width: 200px; margin: var(--space-2) 0 0; }
  .content { padding: var(--space-4) var(--space-4) var(--space-6); }
}
</style>
