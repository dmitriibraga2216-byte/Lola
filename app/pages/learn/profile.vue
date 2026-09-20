<script setup lang="ts">
/** Профиль сотрудника по мокапу screens/Profile.html: инициалы, должность · точка, плитки, сертификаты, ссылки. */
definePageMeta({ layout: 'learner' })

const { t } = useI18n()
const { me, initials, logout, hasScope, switchRole, fetchMe } = useAuth()
const { api } = useApi()

// Переключение активной роли (docs/01 §1.9.2, мокап Profile: список ролей, активная помечена)
const roleList = computed(() => me.value?.roles ?? [])
const switching = ref(false)
async function pickRole(id: string) {
  if (switching.value || id === me.value?.activeRole?.id) return
  switching.value = true
  try { await switchRole(id) }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { switching.value = false }
}

interface Cert { id: string, number: string, validUntil: string | null, revokedAt: string | null, courseTitle: string, publicToken: string | null }
const certs = ref<Cert[]>([])
const counts = ref<{ done: number, new: number, overdue: number } | null>(null)
const week = ref<{ days: { date: string, events: number }[], total: number } | null>(null)
const weekMax = computed(() => Math.max(1, ...(week.value?.days.map(d => d.events) ?? [1])))
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString('uk', { weekday: 'short' }).replace('.', '')
const tgLink = ref<{ url: string | null, token: string } | null>(null)
const error = ref('')

onMounted(async () => {
  try {
    const [c, my, w] = await Promise.all([
      api<Cert[]>('/learning/certificates'),
      api<{ items: unknown[], counts: { done: number, new: number, overdue: number } }>('/learning/my', { query: { group: 'done', counts: 1 } }),
      api<{ days: { date: string, events: number }[], total: number }>('/learning/activity'),
    ])
    certs.value = c.filter(x => !x.revokedAt)
    counts.value = my.counts
    week.value = w
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
})

async function linkTelegram() {
  try { tgLink.value = await api('/telegram/link', { method: 'POST' }) }
  catch (err) { error.value = apiErrorOf(err).message }
}
// Дни рождения (docs/21 §7.8, 29 Б.16): согласие показывать — opt-out, тумблер здесь
const birthdayConsent = ref((me.value?.user as { birthdayConsent?: boolean } | undefined)?.birthdayConsent ?? true)
async function setBirthdayConsent(v: boolean) {
  try { birthdayConsent.value = (await api<{ birthdayConsent: boolean }>('/me/birthday-consent', { method: 'PATCH', body: { birthdayConsent: v } })).birthdayConsent }
  catch (err) { error.value = apiErrorOf(err).message }
}
// Пароль (docs/16 §14.5 «Безпека → Зміна пароля»): два поля; форма раскрыта сразу, если политика требует смены после первого входа
const route = useRoute()
const meUser = computed(() => me.value?.user as { hasPassword?: boolean, mustChangePassword?: boolean } | undefined)
const passwordMinLength = computed(() => me.value?.tenant?.passwordMinLength ?? 8)
const pwd = reactive({ open: route.query.password === '1' || !!meUser.value?.mustChangePassword, current: '', next: '', repeat: '', done: false, busy: false })
// Ошибка формы пароля — под полями, не в общем `error` вверху страницы (docs/33 D-005)
const pwdError = ref('')
async function changePassword() {
  pwdError.value = ''
  pwd.busy = true
  try {
    await api('/me/password', { method: 'POST', body: { ...(meUser.value?.hasPassword ? { currentPassword: pwd.current } : {}), password: pwd.next } })
    Object.assign(pwd, { open: false, current: '', next: '', repeat: '', done: true })
    await fetchMe()
  }
  catch (err) { pwdError.value = apiErrorOf(err).message }
  finally { pwd.busy = false }
}
const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('uk') : ''
</script>

<template>
  <div>
    <div class="head">
      <span class="avatar lg">{{ initials }}</span>
      <div class="who">
        <h1 class="name">{{ me?.user.fullName }}</h1>
        <p class="sub">{{ [me?.user.position, me?.user.location].filter(Boolean).join(' · ') || me?.tenant.name }}</p>
        <p v-if="me?.activeRole" class="sub role">{{ me.activeRole.name }}</p>
      </div>
    </div>

    <template v-if="roleList.length > 1">
      <h2 class="section-title">{{ t('admin.menu.roleSwitch') }}</h2>
      <div class="roles" role="radiogroup" :aria-label="t('admin.menu.roleActive')">
        <button v-for="r in roleList" :key="r.id" :class="['chip', { on: r.id === me?.activeRole?.id }]" role="radio" :aria-checked="r.id === me?.activeRole?.id" :disabled="switching" @click="pickRole(r.id)">{{ r.name }}</button>
      </div>
    </template>

    <div class="tiles">
      <div class="tile teal"><b>{{ counts?.done ?? '—' }}</b><span>{{ t('profile.tiles.done') }}</span></div>
      <div class="tile"><b>{{ counts?.new ?? '—' }}</b><span>{{ t('profile.tiles.active') }}</span></div>
      <div :class="['tile', { coral: (counts?.overdue ?? 0) > 0 }]"><b>{{ counts?.overdue ?? '—' }}</b><span>{{ t('profile.tiles.overdue') }}</span></div>
    </div>

    <p v-if="error" class="error-text">{{ error }}</p>

    <h2 class="section-title">{{ t('profile.certificates') }}</h2>
    <p v-if="certs.length === 0" class="muted">{{ t('profile.noCertificates') }}</p>
    <NuxtLink v-for="c in certs" :key="c.id" :to="`/learn/certificates`" class="cert">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17l-6.1 3.4 1.5-6.8L2.2 9l6.9-.7L12 2zm0 4.6L10.2 10.5l-4.1.4 3.1 2.8-.9 4.1 3.7-2.1 3.7 2.1-.9-4.1 3.1-2.8-4.1-.4L12 6.6z" fill="currentColor" /></svg>
      <span>
        <b>{{ c.courseTitle }}</b>
        <small>№ {{ c.number }}<template v-if="c.validUntil"> · {{ t('profile.validUntil', { date: fmt(c.validUntil) }) }}</template></small>
      </span>
    </NuxtLink>

    <h2 class="section-title">{{ t('profile.weekActivity') }}</h2>
    <div class="week card">
      <div v-for="d in (week?.days ?? [])" :key="d.date" class="day">
        <div :class="['bar', { on: d.events > 0 }]" :style="{ height: `${Math.max(12, Math.round(d.events / weekMax * 64))}px` }" :title="String(d.events)" />
        <span>{{ dayLabel(d.date) }}</span>
      </div>
    </div>

    <h2 class="section-title">{{ t('profile.more') }}</h2>
    <div class="links">
      <NuxtLink to="/learn/notifications" class="row-link">{{ t('notif.title') }}</NuxtLink>
      <NuxtLink to="/learn/notices" class="row-link">{{ t('notices.title') }}</NuxtLink>
      <NuxtLink to="/learn/events" class="row-link">{{ t('events.title') }}</NuxtLink>
      <label class="toggle row-link"><input type="checkbox" :checked="birthdayConsent" @change="setBirthdayConsent(($event.target as HTMLInputElement).checked)"><span>{{ t('profile.birthdayConsent') }}<span class="hint">{{ t('profile.birthdayConsentHint') }}</span></span></label>
      <NuxtLink to="/learn/development" class="row-link">{{ t('dev.short') }}</NuxtLink>
      <NuxtLink to="/learn/profile/study-history" class="row-link">{{ t('studyHistory.title') }}</NuxtLink>
      <NuxtLink to="/learn/surveys" class="row-link">{{ t('survey.title') }}</NuxtLink>
      <button class="row-link" :aria-expanded="pwd.open" @click="pwd.open = !pwd.open; pwdError = ''; pwd.done = false">{{ meUser?.hasPassword ? t('profile.changePassword') : t('profile.setPassword') }}</button>
      <form v-if="pwd.open" class="pwd" @submit.prevent="changePassword">
        <p v-if="meUser?.mustChangePassword" class="muted">{{ t('profile.mustChangePassword') }}</p>
        <p class="hint">{{ t('profile.passwordHint', { n: passwordMinLength }) }}</p>
        <label v-if="meUser?.hasPassword"><span>{{ t('profile.currentPassword') }}</span><input v-model="pwd.current" type="password" autocomplete="current-password" required></label>
        <label><span>{{ t('person.newPassword') }}</span><input v-model="pwd.next" type="password" :minlength="passwordMinLength" autocomplete="new-password" required></label>
        <label><span>{{ t('person.repeatPassword') }}</span><input v-model="pwd.repeat" type="password" :minlength="passwordMinLength" autocomplete="new-password" required></label>
        <p v-if="pwd.repeat && pwd.repeat !== pwd.next" class="error">{{ t('person.passwordsDiffer') }}</p>
        <p v-if="pwdError" class="error" role="alert">{{ pwdError }}</p>
        <button type="submit" class="row-link primary" :disabled="pwd.busy || pwd.next.length < passwordMinLength || pwd.next !== pwd.repeat">{{ t('common.save') }}</button>
      </form>
      <p v-if="pwd.done" class="success" role="status">{{ t('profile.passwordSaved') }}</p>
      <button class="row-link" @click="linkTelegram">{{ t('home.linkTelegram') }}</button>
      <p v-if="tgLink" class="muted tg">
        <a v-if="tgLink.url" :href="tgLink.url" target="_blank" rel="noopener" class="link">{{ t('home.openTelegram') }}</a>
        <span v-else>{{ t('home.tgToken', { token: tgLink.token }) }}</span>
      </p>
      <NuxtLink v-if="hasScope('people.view') || hasScope('course.view') || hasScope('assignment.create')" :to="hasScope('assignment.create') ? '/admin/assignments' : hasScope('course.view') ? '/admin/courses' : '/admin/people'" class="row-link">{{ t('home.adminLink') }}</NuxtLink>
      <button class="row-link danger" @click="logout">{{ t('home.logout') }}</button>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--space-4); margin: var(--space-2) 0 var(--space-4); }
.name { margin: 0; font-size: 22px; font-weight: 900; letter-spacing: -0.01em; }
.sub { margin: 2px 0 0; color: var(--color-ink-muted); font-weight: 700; font-size: var(--font-size-body-s); }
.tiles { grid-template-columns: repeat(3, 1fr); margin-bottom: var(--space-5); }
.tile b { font-size: 24px; }
.section-title { margin: var(--space-4) 0 var(--space-2); font-size: 12px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-ink-muted); }
.cert { display: flex; align-items: center; gap: var(--space-3); background: #fff4c7; border: 1px solid var(--color-sun); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); text-decoration: none; color: inherit; margin-bottom: var(--space-2); }
.cert svg { width: 22px; height: 22px; color: var(--color-sun-ink); flex: none; }
.cert b { display: block; font-weight: 900; }
.cert small { color: var(--color-sun-ink); font-weight: 700; }
.week { display: flex; justify-content: space-between; align-items: flex-end; gap: var(--space-2); padding: var(--space-4) var(--space-3) var(--space-3); }
.day { display: grid; justify-items: center; gap: var(--space-1); flex: 1; }
.day .bar { width: 100%; border-radius: 8px 8px 4px 4px; background: var(--color-bg-line-soft); }
.day .bar.on { background: var(--color-teal); }
.day span { font-size: 11px; font-weight: 700; color: var(--color-ink-muted); }
.links { display: grid; gap: var(--space-1); }
.role { color: var(--color-teal-ink); font-weight: 800; }
.roles { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.chip[disabled] { opacity: .6; cursor: progress; }
.row-link { font: inherit; font-weight: 700; text-align: left; background: var(--color-bg-soft); border: 1px solid var(--color-bg-line-soft); color: var(--color-ink); text-decoration: none; border-radius: var(--radius-s); padding: var(--space-3) var(--space-4); cursor: pointer; }
.row-link.danger { color: var(--color-coral-ink); }
.row-link.primary { background: var(--color-sun); border-color: var(--color-sun); text-align: center; }
.pwd { display: grid; gap: var(--space-2); padding: var(--space-3) var(--space-4); background: var(--color-bg-soft); border-radius: var(--radius-s); }
.pwd label { display: grid; gap: 2px; font-size: var(--font-size-body-s); color: var(--color-ink-muted); font-weight: 700; }
.pwd input { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.pwd .error { margin: 0; color: var(--color-coral-ink); font-size: var(--font-size-body-s); }
.pwd .hint { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.success { margin: var(--space-2) var(--space-4) 0; color: var(--color-teal-ink); font-size: var(--font-size-body-s); font-weight: 700; }
.tg { margin: 0 var(--space-2); }
</style>
