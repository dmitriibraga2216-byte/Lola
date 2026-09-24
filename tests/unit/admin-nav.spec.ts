import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Владелец продукта: раздел «Навчання» в `app/layouts/admin.vue::sections» разросся до
 * 22 пунктов подряд (нечитаемо, не помещается на экран). Правка регруппировала меню в
 * восемь разделов (было пять) с подзаголовками там, где в разделе больше 8–10 пунктов —
 * но НЕ должна терять ни одного пункта и НЕ должна менять его `show` (право доступа).
 *
 * Число пунктов в снимке `ORIGINAL_SHOW` — не цель теста, а фактический учёт: после ребейза
 * на main (#104 «Власник», #106 «Вакансія») меню приросло пунктом `/admin/vacancies`, снимок
 * обновлён. Смысл теста — что множество пунктов и их `show`-условия не теряются и не меняются
 * молча при последующих правках, а не конкретное число 74/75/…
 *
 * Тест разбирает исходник статически, без монтирования компонента и без Nuxt-контекста
 * (`useI18n`/`useAuth`/`useRoute` — автоимпорты Nuxt, для юнит-теста их поднимать избыточно) —
 * тот же приём, что в `tests/unit/i18n-keys.spec.ts`.
 */
const root = resolve(__dirname, '../..')
const src = readFileSync(resolve(root, 'app/layouts/admin.vue'), 'utf8')

interface Entry { section: string, to: string, show: string, group: string | null }

const ITEM_RE = /\{ to: '([^']+)', label: t\('[^']+'\), show: ([^,{}]+?)(?:, group: t\('([^']+)'\))? \},/g
const SECTION_RE = /\{ key: '([^']+)', label: t\('[^']+'\), icon: '[^']+', items: \[/g

function parseSections(text: string): Entry[] {
  const start = text.indexOf('const sections = computed<Section[]>(() => [')
  const end = text.indexOf('].map(s => ({ ...s, items: s.items.filter')
  if (start < 0 || end < 0) throw new Error('не нашёл блок sections в admin.vue — тест устарел')
  const block = text.slice(start, end)

  const sectionStarts = [...block.matchAll(SECTION_RE)].map(m => ({ key: m[1]!, index: m.index! }))
  const out: Entry[] = []
  for (let s = 0; s < sectionStarts.length; s++) {
    const from = sectionStarts[s]!.index
    const to = s + 1 < sectionStarts.length ? sectionStarts[s + 1]!.index : block.length
    const slice = block.slice(from, to)
    for (const m of slice.matchAll(ITEM_RE)) {
      out.push({ section: sectionStarts[s]!.key, to: m[1]!, show: m[2]!.trim(), group: m[3] ?? null })
    }
  }
  return out
}

/**
 * Снимок ожидаемого состава меню — путь → точное show-выражение. Изначально (правка
 * «раздели меню») — 74 пункта до разбивки; после ребейза на main добавлен `/admin/vacancies`
 * (#106 «Вакансія», рекрутинг) — 75.
 */
const ORIGINAL_SHOW: Record<string, string> = {
  '/admin/assignments': "hasScope('assignment.create')",
  '/admin/tasks/parameters': "hasScope('assignment.create')",
  '/admin/trajectories': "hasScope('program.manage')",
  '/admin/review-workshops': "hasScope('review.queue')",
  '/admin/review': "hasScope('review.queue')",
  '/admin/attempt-requests': "hasScope('review.grade')",
  '/admin/catalog/requests': "hasScope('assignment.create')",
  '/admin/catalog/access': "hasScope('assignment.create')",
  '/admin/comments': "hasScope('course.view')",
  '/admin/rules': "hasScope('settings.tenant')",
  '/admin/profiles': "hasScope('assignment.create')",
  '/admin/knowledge': "hasScope('knowledge.manage')",
  '/admin/news': "hasScope('knowledge.manage')",
  '/admin/notices': "hasScope('knowledge.manage')",
  '/admin/simple-notices': "hasScope('knowledge.manage')",
  '/admin/events': "hasScope('meetup.manage')",
  '/admin/birthdays': "hasScope('people.view')",
  '/admin/contacts': "hasScope('people.view')",
  '/admin/knowledge/access': "hasScope('knowledge.manage')",
  '/admin/assessment/forms': "hasScope('assessment.manage')",
  '/admin/assessment/cycles': "hasScope('assessment.run')",
  '/admin/checklists': "hasScope('checklist.manage')",
  '/admin/resources': "hasScope('course.view')",
  '/admin/courses': "hasScope('course.view')",
  '/admin/programs': "hasScope('program.manage')",
  '/admin/quizzes': "hasScope('course.view')",
  '/admin/workshops': "hasScope('course.view')",
  '/admin/meetups/complex': "hasScope('complextest.manage')",
  '/admin/surveys': "hasScope('survey.manage')",
  '/admin/meetups': "hasScope('meetup.manage') || hasScope('meetup.attendance')",
  '/admin/assessment/criteria': "hasScope('assessment.manage')",
  '/admin/resources/categories': "hasScope('course.edit')",
  '/admin/people': "hasScope('people.view')",
  '/admin/candidates': "recruitingOn() && hasScope('candidate.view')",
  '/admin/vacancies': "recruitingOn() && hasScope('vacancy.view')",
  '/admin/people/groups': "hasScope('people.view')",
  '/admin/org': "hasScope('people.view')",
  '/admin/refs': "hasScope('people.view')",
  '/admin/tags': "hasScope('people.view')",
  '/admin/import': "hasScope('people.import')",
  '/admin/org-conflicts': "hasScope('people.edit')",
  '/admin/offboarding': "hasScope('offboarding.start')",
  '/admin/development/competencies': "hasScope('competency.manage')",
  '/admin/development/profiles': "hasScope('position_profile.manage')",
  '/admin/development/plans': "hasScope('development.team')",
  '/admin/development/team': "hasScope('development.team')",
  '/admin/development/matrix': "hasScope('development.team')",
  '/admin/development/strategic': "hasScope('development.team')",
  '/admin/development/strategic-plans': "hasScope('development.team')",
  '/admin/development/requests': "hasScope('request.decide')",
  '/admin/development/statuses': "hasScope('development.manage')",
  '/admin/development/settings': "hasScope('development.manage')",
  '/admin/reports': "hasScope('report.team')",
  '/admin/reports/summary': "hasScope('report.team')",
  '/admin/reports/tasks/test': "hasScope('report.team')",
  '/admin/reports/builder': "hasScope('report.builder')",
  '/admin/reports/people': "hasScope('report.team')",
  '/admin/reports/recruiting-funnel': "recruitingOn() && hasScope('candidate.view')",
  '/admin/checklists/report': "hasScope('report.team')",
  '/admin/meetups/report': "hasScope('report.team')",
  '/admin/development/reports': "hasScope('report.team')",
  '/admin/knowledge/report': "hasScope('knowledge.manage')",
  '/admin/journals': "hasScope('audit.view')",
  '/admin/settings/notifications': "hasScope('settings.notifications')",
  '/admin/settings/integrations': "hasScope('settings.integrations')",
  '/admin/settings/guest-page': "hasScope('settings.tenant')",
  '/admin/settings/policies': "hasScope('settings.tenant')",
  '/admin/settings/roles': "hasScope('settings.tenant')",
  '/admin/settings/position-role-map': "hasScope('settings.tenant')",
  '/admin/settings/scales': "hasScope('settings.tenant')",
  '/admin/settings/lifecycle': "hasScope('lifecycle.view')",
  '/admin/settings/recruiting': "hasScope('settings.tenant')",
  '/admin/settings/translations': "hasScope('settings.tenant')",
  '/admin/certificates': "hasScope('report.team')",
  // PR-10 (docs/v2/35): тариф і ліміти бачать `admin` і `owner` — окремий скоуп, не «налаштування простору».
  '/admin/settings/billing': "hasScope('billing.view')",
  '/admin/settings/billing/history': "hasScope('billing.payments.view')",
  '/admin/settings/usage': "hasScope('billing.usage.view')",
}

/** Пункты одного раздела → визуальные «пачки» (как `groupsOf` в admin.vue): подряд идущие
 * пункты с одинаковым подзаголовком — одна пачка; смена подзаголовка (или его отсутствие) —
 * новая пачка. Именно на размер такой пачки, а не раздела целиком, распространяется лимит. */
function bucketsOf(items: Entry[]): Entry[][] {
  const out: Entry[][] = []
  for (const item of items) {
    const last = out[out.length - 1]
    if (last && last[0]!.group === item.group) last.push(item)
    else out.push([item])
  }
  return out
}

describe('admin.vue: разбивка бокового меню сохранила все пункты и права', () => {
  const entries = parseSections(src)

  it('нашла все пункты меню в исходнике (столько же, сколько в снимке ожидаемого состава)', () => {
    expect(entries.length).toBe(Object.keys(ORIGINAL_SHOW).length)
  })

  it('каждый пункт исходного меню присутствует ровно один раз', () => {
    const counts = new Map<string, number>()
    for (const e of entries) counts.set(e.to, (counts.get(e.to) ?? 0) + 1)
    const missing = Object.keys(ORIGINAL_SHOW).filter(to => !counts.has(to))
    const duplicated = [...counts].filter(([, n]) => n > 1).map(([to]) => to)
    const unexpected = [...counts.keys()].filter(to => !(to in ORIGINAL_SHOW))
    expect(missing, `пропали пункты: ${missing.join(', ')}`).toEqual([])
    expect(duplicated, `пункты встречаются больше раза: ${duplicated.join(', ')}`).toEqual([])
    expect(unexpected, `новые пункты, которых не было: ${unexpected.join(', ')}`).toEqual([])
  })

  it('show-условие («право») каждого пункта не изменилось', () => {
    const changed = entries
      .filter(e => e.show !== ORIGINAL_SHOW[e.to])
      .map(e => ({ to: e.to, was: ORIGINAL_SHOW[e.to], now: e.show }))
    expect(changed, JSON.stringify(changed, null, 2)).toEqual([])
  })

  it('ни в одном разделе и ни в одной подгруппе пунктов не больше 10', () => {
    const bySection = new Map<string, Entry[]>()
    for (const e of entries) bySection.set(e.section, [...(bySection.get(e.section) ?? []), e])

    const tooBig: string[] = []
    for (const [section, items] of bySection) {
      for (const bucket of bucketsOf(items)) {
        if (bucket.length > 10) tooBig.push(`${section}${bucket[0]!.group ? ` / ${bucket[0]!.group}` : ''}: ${bucket.length}`)
      }
    }
    expect(tooBig, `превышен лимит пунктов: ${tooBig.join('; ')}`).toEqual([])
  })

  it('меню разбито больше чем на пять разделов (была задача разделить «Навчання»)', () => {
    const sectionKeys = new Set(entries.map(e => e.section))
    expect(sectionKeys.size).toBeGreaterThan(5)
  })

  it('у каждого пункта и подзаголовка — ключ i18n, не хардкод текста', () => {
    const start = src.indexOf('const sections = computed<Section[]>(() => [')
    const end = src.indexOf('].map(s => ({ ...s, items: s.items.filter')
    const block = src.slice(start, end)
    // Все `label:` и `group:` в этом блоке обязаны быть вызовом t('admin....'), не строкой.
    const labelRe = /label: ([^,]+)/g
    const bad: string[] = []
    for (const m of block.matchAll(labelRe)) if (!/^t\('admin\.(nav|section)\.[^']+'\)$/.test(m[1]!)) bad.push(m[1]!)
    expect(bad, `label не через i18n: ${bad.join(', ')}`).toEqual([])
    const groupRe = /group: (t\('admin\.group\.[^']+'\)|[^\s},]+)/g
    const badGroups: string[] = []
    for (const m of block.matchAll(groupRe)) if (!/^t\('admin\.group\.[^']+'\)$/.test(m[1]!)) badGroups.push(m[1]!)
    expect(badGroups, `group не через i18n: ${badGroups.join(', ')}`).toEqual([])
  })
})
