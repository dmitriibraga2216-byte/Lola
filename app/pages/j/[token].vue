<script setup lang="ts">
/**
 * Публичная страница вакансии и форма отклика — без входа
 * (docs/v2/29-vacancies.md §5.4, §6.3; решение docs/v2/44 В-9; план docs/v2/45 PR-16).
 *
 * Экран рассчитан на 320 px (сквозная проверка 24 `docs/v2/42` §5): человек приходит
 * с телефона и второго устройства у него чаще всего нет. Одна колонка, ни одной таблицы,
 * ни одного горизонтального скролла, кнопки не ниже 44 px.
 *
 * Язык — **вакансии или пространства** (§7.20), а не язык того, кто открыл браузер: набор
 * ведёт компания, и её объявление на украинском не должно превращаться в английское
 * от настроек посетителя.
 */
definePageMeta({ layout: false })

const { t, setLocale } = useI18n()
const { api } = useApi()
const route = useRoute()

interface Lang { langCode: string, level: string, isRequired: boolean }
interface Vacancy {
  title: string
  language: string
  city: string | null
  countryCode: string | null
  employmentType: string | null
  workFormat: string | null
  experienceLevel: string | null
  educationLevel: string | null
  salary: { from: string | null, to: string | null, currency: string } | null
  descriptionHtml: string | null
  requirementsHtml: string | null
  dutiesHtml: string | null
  extraHtml: string | null
  languages: Lang[]
  otpRequired: boolean
  consentVersion: string
  formNonce: string
}

const vacancy = ref<Vacancy | null>(null)
const error = ref('')
const busy = ref(false)
/** `sent` — отклик принят и ждёт кода; `done` — путь пройден до конца. */
const stage = ref<'form' | 'sent' | 'done'>('form')
const applicationId = ref('')
const channel = ref<'sms' | 'email' | null>(null)
const code = ref('')
const codeError = ref('')

const form = reactive({
  fullName: '',
  phone: '',
  email: '',
  comment: '',
  consent: false,
  /** Honeypot (§7.6): в DOM есть, человеку не виден и в таб-порядок не входит. */
  website: '',
})

const LOCALES = ['uk', 'en', 'ru'] as const

onMounted(async () => {
  try {
    const data = await api<Vacancy>(`/public/j/${route.params.token}`)
    vacancy.value = data
    if ((LOCALES as readonly string[]).includes(data.language)) setLocale(data.language as typeof LOCALES[number])
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
})

const chips = computed(() => {
  const v = vacancy.value
  if (!v) return [] as string[]
  const out: string[] = []
  if (v.city) out.push(v.city)
  if (v.employmentType) out.push(t(`vacancy.employment.${v.employmentType}`))
  if (v.workFormat) out.push(t(`vacancy.format.${v.workFormat}`))
  if (v.experienceLevel) out.push(t(`vacancy.experience.${v.experienceLevel}`))
  if (v.educationLevel) out.push(t(`vacancy.education.${v.educationLevel}`))
  return out
})

const salaryLine = computed(() => {
  const s = vacancy.value?.salary
  if (!s || (!s.from && !s.to)) return ''
  const num = (x: string | null) => (x == null ? '' : String(Math.round(Number(x))))
  if (s.from && s.to) return `${num(s.from)} – ${num(s.to)} ${s.currency}`
  return `${s.from ? t('apply.salaryFrom') : t('apply.salaryTo')} ${num(s.from ?? s.to)} ${s.currency}`
})

const contactHint = computed(() => (channel.value === 'email' ? form.email : form.phone))

async function submit() {
  if (!vacancy.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ applicationId: string, otpRequired: boolean, channel: 'sms' | 'email' | null }>(
      `/public/j/${route.params.token}/apply`,
      {
        method: 'POST',
        body: {
          fullName: form.fullName,
          ...(form.phone ? { phone: form.phone } : {}),
          ...(form.email ? { email: form.email } : {}),
          ...(form.comment ? { comment: form.comment } : {}),
          consent: form.consent,
          formNonce: vacancy.value.formNonce,
          website: form.website,
        },
      },
    )
    applicationId.value = r.applicationId
    channel.value = r.channel
    stage.value = r.otpRequired ? 'sent' : 'done'
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

async function confirm() {
  if (busy.value) return
  busy.value = true
  codeError.value = ''
  try {
    await api(`/public/j/${route.params.token}/apply/${applicationId.value}/confirm`, {
      method: 'POST',
      body: { code: code.value },
    })
    stage.value = 'done'
  }
  catch (err) {
    codeError.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

const canSubmit = computed(() =>
  form.fullName.trim().split(/\s+/).filter(Boolean).length >= 2
  && (form.phone.trim() !== '' || form.email.trim() !== '')
  && form.consent)
</script>

<template>
  <main class="wrap">
    <header class="head">
      <span class="logo">Lola</span>
      <span class="sub">{{ t('apply.header') }}</span>
    </header>

    <p v-if="error && !vacancy" class="error" role="alert">{{ error }}</p>

    <template v-else-if="vacancy">
      <h1>{{ vacancy.title }}</h1>
      <p v-if="chips.length" class="chips">
        <span v-for="c in chips" :key="c" class="chip">{{ c }}</span>
      </p>
      <p v-if="salaryLine" class="salary">{{ salaryLine }}</p>

      <section v-if="vacancy.descriptionHtml" class="card">
        <h2>{{ t('vacancy.blocks.description') }}</h2>
        <!-- eslint-disable-next-line vue/no-v-html -- санитайз §7.22 делает сервер при сохранении -->
        <div class="rich" v-html="vacancy.descriptionHtml" />
      </section>
      <section v-if="vacancy.requirementsHtml" class="card">
        <h2>{{ t('vacancy.blocks.requirements') }}</h2>
        <!-- eslint-disable-next-line vue/no-v-html -- санитайз §7.22 делает сервер при сохранении -->
        <div class="rich" v-html="vacancy.requirementsHtml" />
      </section>
      <section v-if="vacancy.dutiesHtml" class="card">
        <h2>{{ t('vacancy.blocks.duties') }}</h2>
        <!-- eslint-disable-next-line vue/no-v-html -- санитайз §7.22 делает сервер при сохранении -->
        <div class="rich" v-html="vacancy.dutiesHtml" />
      </section>
      <section v-if="vacancy.extraHtml" class="card">
        <h2>{{ t('vacancy.blocks.extra') }}</h2>
        <!-- eslint-disable-next-line vue/no-v-html -- санитайз §7.22 делает сервер при сохранении -->
        <div class="rich" v-html="vacancy.extraHtml" />
      </section>
      <section v-if="vacancy.languages.length" class="card">
        <h2>{{ t('apply.languages') }}</h2>
        <p v-for="l in vacancy.languages" :key="l.langCode" class="lang">
          {{ l.langCode.toUpperCase() }} · {{ t(`vacancy.level.${l.level}`) }}
          <span v-if="!l.isRequired" class="sub">{{ t('apply.optional') }}</span>
        </p>
      </section>

      <section v-if="stage === 'done'" class="card center">
        <h2>{{ t('apply.acceptedTitle') }}</h2>
        <p class="sub">{{ t('apply.acceptedHint') }}</p>
      </section>

      <section v-else-if="stage === 'sent'" class="card">
        <h2>{{ t('apply.codeTitle') }}</h2>
        <p class="sub">{{ t('apply.codeHint', { contact: contactHint }) }}</p>
        <label class="field-row">
          <span class="label">{{ t('apply.code') }}</span>
          <input
            v-model="code"
            class="field code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            :aria-label="t('apply.code')"
          >
        </label>
        <p v-if="codeError" class="error" role="alert">{{ codeError }}</p>
        <button class="primary" type="button" :disabled="busy || code.length !== 6" @click="confirm">
          {{ t('apply.confirm') }}
        </button>
      </section>

      <form v-else class="card" novalidate @submit.prevent="submit">
        <h2>{{ t('apply.formTitle') }}</h2>

        <label class="field-row">
          <span class="label">{{ t('apply.fullName') }}</span>
          <input v-model="form.fullName" class="field" maxlength="120" autocomplete="name" required>
        </label>

        <label class="field-row">
          <span class="label">{{ t('apply.phone') }}</span>
          <input v-model="form.phone" class="field" type="tel" maxlength="20" autocomplete="tel" :placeholder="t('apply.phonePlaceholder')">
          <span class="sub">{{ t('apply.phoneHint') }}</span>
        </label>

        <label class="field-row">
          <span class="label">{{ t('apply.email') }}</span>
          <input v-model="form.email" class="field" type="email" maxlength="200" autocomplete="email">
        </label>

        <label class="field-row">
          <span class="label">{{ t('apply.comment') }}</span>
          <textarea v-model="form.comment" class="field area" maxlength="1000" :placeholder="t('apply.commentHint')" />
        </label>

        <label class="consent">
          <input v-model="form.consent" type="checkbox">
          <span>{{ t('apply.consent') }}</span>
        </label>

        <!--
          Honeypot (§7.6): скрыт стилем, вне таб-порядка, без автозаполнения и без доступного
          имени — поле не должно существовать ни для человека, ни для экранного диктора,
          только для скрипта, который заполняет всё подряд.
        -->
        <input
          v-model="form.website"
          class="hp"
          name="website"
          tabindex="-1"
          autocomplete="off"
          aria-hidden="true"
        >

        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button class="primary" type="submit" :disabled="busy || !canSubmit">{{ t('apply.send') }}</button>
        <p class="sub">{{ t('apply.consentHint') }}</p>
      </form>
    </template>

    <p v-else class="sub">{{ t('common.loading') }}</p>
  </main>
</template>

<style scoped>
.wrap { max-width: 640px; margin: 0 auto; padding: var(--space-4) var(--space-4) var(--space-7); }
.head { display: flex; align-items: baseline; gap: var(--space-2); margin-bottom: var(--space-3); flex-wrap: wrap; }
.logo { font-weight: 900; font-size: var(--font-size-title-l); }
h1 { margin: 0 0 var(--space-2); font-weight: 900; font-size: var(--font-size-title-l); overflow-wrap: anywhere; }
h2 { margin: 0 0 var(--space-2); font-size: var(--font-size-body); color: var(--color-ink-muted); }
.chips { display: flex; flex-wrap: wrap; gap: var(--space-1); margin: 0 0 var(--space-2); }
.chip { background: var(--color-bg-soft); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); font-size: var(--font-size-body-s); }
.salary { font-weight: 800; color: var(--color-teal-ink); margin: 0 0 var(--space-3); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); margin-bottom: var(--space-3); }
.center { text-align: center; padding: var(--space-7) var(--space-4); }
.rich { overflow-wrap: anywhere; }
.rich :deep(ul), .rich :deep(ol) { padding-left: var(--space-4); margin: 0; }
.lang { margin: 0 0 var(--space-1); }
.field-row { display: grid; gap: var(--space-1); margin-bottom: var(--space-3); }
.label { font-weight: 700; font-size: var(--font-size-body-s); }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2); background: var(--color-bg); color: var(--color-ink); width: 100%; box-sizing: border-box; min-height: 44px; }
.area { min-height: 96px; resize: vertical; }
.code { letter-spacing: 0.3em; font-weight: 800; }
.consent { display: flex; gap: var(--space-2); align-items: flex-start; margin-bottom: var(--space-3); }
.consent input { min-width: 20px; min-height: 20px; margin-top: var(--space-1); }
.hp { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-5); cursor: pointer; min-height: 44px; width: 100%; }
.primary:disabled { opacity: 0.5; cursor: default; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0 0 var(--space-1); }
.error { color: var(--color-coral-ink); }
</style>
