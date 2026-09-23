import 'dotenv/config'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from './schema'
import { SYSTEM_ROLES } from '../../shared/domain/roles'
import { ensureTenantDefaults } from './tenantDefaults'

/**
 * Сид этапа 0 (docs/07-stages.md): тенант «Каппі», две точки, позиции,
 * системные роли, тестовые люди. Идемпотентен: повторный запуск ничего не дублирует.
 * Идёт от владельца БД — сид создаёт данные до того, как появился контекст тенанта.
 *
 * `SEED_MODE` (docs/26 «Розгортання R1»): `demo` (по умолчанию) — сценарий ниже, тенант
 * «Каппі» с демо-даними. `prod` — минимальный тенант без демо-контенту: тільки системні
 * ролі, довідники за замовчуванням (`ensureTenantDefaults`) і перший адміністратор із
 * `FIRST_ADMIN_PHONE`. Оператора платформи (`PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD`)
 * створює `ensureFirstAdmin` при старті застосунку (`server/plugins/worker.ts`) — сюди не входить.
 */

const url = process.env.DATABASE_ADMIN_URL
if (!url) {
  console.error('DATABASE_ADMIN_URL не задан')
  process.exit(1)
}

const client = postgres(url, { max: 1, onnotice: () => {} })
const db = drizzle(client, { schema })

const SEED_MODE = process.env.SEED_MODE === 'prod' ? 'prod' : 'demo'

if (SEED_MODE === 'prod') {
  const slug = process.env.FIRST_TENANT_SLUG
  const name = process.env.FIRST_TENANT_NAME
  const adminPhone = process.env.FIRST_ADMIN_PHONE
  if (!slug || !name || !adminPhone) {
    console.error('SEED_MODE=prod вимагає FIRST_TENANT_SLUG, FIRST_TENANT_NAME, FIRST_ADMIN_PHONE')
    process.exit(1)
  }

  const existingProd = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, slug) })
  if (existingProd) {
    console.log(`Сід уже застосовано (тенант ${slug} існує) — пропускаю`)
    await client.end()
    process.exit(0)
  }

  await db.transaction(async (tx) => {
    const [tenant] = await tx.insert(schema.tenants).values({
      slug, name, locale: 'uk', timezone: 'Europe/Kyiv',
    }).returning()
    const tenantId = tenant!.id

    await tx.insert(schema.orgUnits).values({
      tenantId, name, path: slug.replace(/[^a-zA-Z0-9_]/g, '_'),
    })

    const roles = await tx.insert(schema.roles).values(
      Object.entries(SYSTEM_ROLES).map(([code, r]) => ({
        tenantId, code, name: r.name, scopes: [...r.scopes], isSystem: true,
      })),
    ).returning()
    const adminRole = roles.find(r => r.code === 'admin')!
    await ensureTenantDefaults(tx, tenantId)

    const [admin] = await tx.insert(schema.users).values({
      tenantId, phone: adminPhone, fullName: 'Адміністратор', status: 'active',
    }).returning()

    await tx.insert(schema.userRoles).values({
      tenantId, userId: admin!.id, roleId: adminRole.id, scopeType: 'tenant',
    })
  })

  console.log(`Сід застосовано (prod): тенант «${name}» (${slug}), системні ролі, адмін ${adminPhone}`)
  await client.end()
  process.exit(0)
}

const existing = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'kappi') })
if (existing) {
  console.log('Сид уже применён (тенант kappi существует) — пропускаю')
  await client.end()
  process.exit(0)
}

await db.transaction(async (tx) => {
  const [tenant] = await tx.insert(schema.tenants).values({
    slug: 'kappi',
    name: 'Каппі',
    locale: 'uk',
    timezone: 'Europe/Kyiv',
  }).returning()
  const tenantId = tenant!.id

  const [root] = await tx.insert(schema.orgUnits).values({
    tenantId,
    name: 'Каппі',
    path: 'kappi',
  }).returning()

  const [lazareva, segedska] = await tx.insert(schema.locations).values([
    { tenantId, orgUnitId: root!.id, name: 'Лазарева', address: 'Одеса, вул. Адміральська' },
    { tenantId, orgUnitId: root!.id, name: 'Сегедська', address: 'Одеса, вул. Сегедська' },
  ]).returning()

  const positions = await tx.insert(schema.positions).values([
    { tenantId, name: 'Кухар гарячого цеху', code: 'cook-hot' },
    { tenantId, name: 'Кухар холодного цеху', code: 'cook-cold' },
    { tenantId, name: 'Касир', code: 'cashier' },
    { tenantId, name: 'Курʼєр', code: 'courier' },
    { tenantId, name: 'Керуючий', code: 'manager' },
  ]).returning()
  const pos = Object.fromEntries(positions.map(p => [p.code, p]))

  const roles = await tx.insert(schema.roles).values(
    Object.entries(SYSTEM_ROLES).map(([code, r]) => ({
      tenantId, code, name: r.name, scopes: [...r.scopes], isSystem: true,
    })),
  ).returning()
  const role = Object.fromEntries(roles.map(r => [r.code, r]))
  await ensureTenantDefaults(tx, tenantId)

  const people = await tx.insert(schema.users).values([
    { tenantId, phone: '+380661864742', fullName: 'Адмін Каппі', status: 'active' },
    { tenantId, phone: '+380670000001', fullName: 'Монастирна Катерина', status: 'active' },
    { tenantId, phone: '+380670000002', fullName: 'Шеф Лазарева', status: 'active' },
    { tenantId, phone: '+380670000003', fullName: 'Кухар Тестовий', status: 'active' },
    { tenantId, phone: '+380670000004', fullName: 'Касир Тестова', status: 'invited' },
  ]).returning()
  const [adminU, hr, chef, cook, cashier] = people

  // Слой 3 патча П-16.1 (docs/v2/44-decisions.md В-8, вариант E): канареечные кандидаты.
  // Пока в базе нет ни одного кандидата, все тесты зелёные независимо от качества фильтров
  // (docs/v2/42-stages-delta.md §7.1 п. 3) — поэтому три кандидата сеются вместе с колонкой
  // `kind`, в том же PR. Каждый подобран так, чтобы всплыть в своём классе забытых выборок:
  // активный с тегом — в списках людей и в раскрытии аудитории по метке; с заблокированным
  // ботом — в отчёте по Telegram; давно не заходивший — в «неактивні понад 30 днів».
  // Размещения им не выдаются: кандидат не занимает должности (docs/v2/28 §2).
  const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)
  await tx.insert(schema.users).values([
    { tenantId, kind: 'candidate', phone: '+380671000001', email: 'kanarka1@kappi.test', fullName: 'Канарка Перша', status: 'active', tags: ['кандидат'] },
    { tenantId, kind: 'candidate', phone: '+380671000002', fullName: 'Канарка Друга', status: 'active', tags: ['кандидат'], telegramBlocked: true },
    { tenantId, kind: 'candidate', phone: '+380671000003', fullName: 'Канарка Третя', status: 'active', tags: ['кандидат'], createdAt: longAgo, lastSeenAt: longAgo },
  ])

  await tx.insert(schema.userPlacements).values([
    { tenantId, userId: chef!.id, locationId: lazareva!.id, positionId: pos['cook-hot']!.id },
    { tenantId, userId: cook!.id, locationId: lazareva!.id, positionId: pos['cook-hot']!.id },
    { tenantId, userId: cashier!.id, locationId: segedska!.id, positionId: pos['cashier']!.id },
    { tenantId, userId: hr!.id, locationId: lazareva!.id, positionId: pos['manager']!.id },
    { tenantId, userId: adminU!.id, locationId: lazareva!.id, positionId: pos['manager']!.id },
  ])

  await tx.insert(schema.userRoles).values([
    { tenantId, userId: adminU!.id, roleId: role['admin']!.id, scopeType: 'tenant' },
    { tenantId, userId: hr!.id, roleId: role['author']!.id, scopeType: 'tenant' },
    { tenantId, userId: chef!.id, roleId: role['mentor']!.id, scopeType: 'location', scopeId: lazareva!.id },
    { tenantId, userId: chef!.id, roleId: role['employee']!.id, scopeType: 'location', scopeId: lazareva!.id },
    { tenantId, userId: cook!.id, roleId: role['employee']!.id, scopeType: 'location', scopeId: lazareva!.id },
    { tenantId, userId: cashier!.id, roleId: role['employee']!.id, scopeType: 'location', scopeId: segedska!.id },
  ])

  // ── Учебный контент демо-тенанта ────────────────────────────────────────────────
  // Пишем напрямую, как и всё выше: контекста тенанта ещё нет, RLS обходит владелец БД.
  // Инварианты сервисов соблюдаем один в один:
  //   курс = courses + course_versions(published) + modules + lessons, урок-материал закреплён
  //   за снимком resource_versions (Г-11.3, server/services/courses.ts pinResourceVersions);
  //   тест хранит пересчитанные total_points/question_count (server/services/questions.ts);
  //   правила прохождения (попытки, порог, срок) в контенте не живут — CLAUDE.md п. 11:
  //   порог теста внутри плана курса это lessons.pass_score_pct, остальное — в назначении.
  // Назначений, попыток и прогресса здесь нет: демо-данные это только контент.
  const author = hr!.id // Монастирна Катерина — роль «Автор»
  const now = new Date()

  const cats = await tx.insert(schema.courseCategories).values([
    { tenantId, name: 'Кухня', sort: 0 },
    { tenantId, name: 'Зал і каса', sort: 1 },
    { tenantId, name: 'Безпека та гігієна', sort: 2 },
    { tenantId, name: 'Адаптація', sort: 3 },
  ]).returning()
  const [catKitchen, catHall, catSafety, catOnboarding] = cats

  // Блоки материала (docs/11 §3.3, shared/schemas/content.ts): id уникален внутри тела.
  type Block = { id: string, type: string, [k: string]: unknown }
  let blockSeq = 0
  const bid = () => `b${++blockSeq}`
  const h = (text: string): Block => ({ id: bid(), type: 'heading', level: 2, text })
  const p = (html: string): Block => ({ id: bid(), type: 'text', html })
  const note = (tone: 'info' | 'warn' | 'danger' | 'success', title: string, text: string): Block =>
    ({ id: bid(), type: 'callout', tone, title, text })
  const steps = (items: string[]): Block => ({ id: bid(), type: 'checklist', items, requireAll: false })

  /** Тот же текст для FTS, что считает blocksToText (server/services/knowledge.ts). */
  const plain = (body: Block[]) => body.map((b) => {
    if (b.type === 'heading') return String(b.text)
    if (b.type === 'text') return String(b.html).replace(/<[^>]+>/g, ' ')
    if (b.type === 'callout') return `${b.title ?? ''} ${b.text ?? ''}`
    if (b.type === 'checklist') return (b.items as string[]).join(' ')
    return ''
  }).join(' ').replace(/\s+/g, ' ').trim()

  /** Материал + его опубликованный снимок: курс ссылается на версию, а не на рабочую редакцию. */
  async function seedResource(title: string, slug: string, body: Block[], estimatedMinutes: number) {
    const plainText = plain(body)
    const [res] = await tx.insert(schema.resources).values({
      tenantId, title, slug, kind: 'article', body, plainText,
      authorIds: [author], language: 'uk', estimatedMinutes, status: 'published', version: 1,
    }).returning()
    const [snap] = await tx.insert(schema.resourceVersions).values({
      tenantId, resourceId: res!.id, version: 1, title, kind: 'article', body, plainText,
      changelog: 'Публікація курсу, версія 1', publishedBy: author,
    }).returning()
    await tx.update(schema.resources).set({ publishedVersionId: snap!.id })
      .where(eq(schema.resources.id, res!.id))
    return { resourceId: res!.id, versionId: snap!.id }
  }

  interface LessonSpec {
    title: string
    slug?: string
    body?: Block[]
    minutes?: number
    quizId?: string
    passScorePct?: string
    minSeconds?: number
  }

  /** Курс целиком в опубликованном виде: версия 1 published, курс указывает на неё. */
  async function seedCourse(c: {
    title: string, slug: string, summary: string, code: string, categoryId: string
    estimatedMinutes: number, durationDays: number, workload: string, tags: string[]
    isCatalogVisible?: boolean, assignMode?: string
    modules: { title: string, lessons: LessonSpec[] }[]
  }) {
    const [course] = await tx.insert(schema.courses).values({
      tenantId, title: c.title, slug: c.slug, summary: c.summary, code: c.code,
      categoryId: c.categoryId, language: 'uk', status: 'published',
      estimatedMinutes: c.estimatedMinutes, durationDays: c.durationDays, workload: c.workload,
      strictOrder: true, isCatalogVisible: c.isCatalogVisible ?? false,
      assignMode: c.assignMode ?? 'catalog_free', resultMode: 'pct',
      tags: c.tags, createdBy: author,
    }).returning()
    const [version] = await tx.insert(schema.courseVersions).values({
      tenantId, courseId: course!.id, version: 1, status: 'published',
      changelog: 'Перша публікація', publishedAt: now, publishedBy: author,
    }).returning()
    await tx.update(schema.courses).set({ publishedVersionId: version!.id })
      .where(eq(schema.courses.id, course!.id))

    for (const [mi, m] of c.modules.entries()) {
      const [mod] = await tx.insert(schema.modules).values({
        tenantId, courseVersionId: version!.id, title: m.title, sort: mi,
      }).returning()
      for (const [li, l] of m.lessons.entries()) {
        const res = l.body ? await seedResource(l.title, l.slug!, l.body, l.minutes ?? 10) : null
        await tx.insert(schema.lessons).values({
          tenantId, moduleId: mod!.id, title: l.title, sort: li,
          itemType: l.quizId ? 'quiz' : 'resource',
          itemId: l.quizId ?? res!.resourceId,
          isRequired: true, minSeconds: l.minSeconds ?? null, videoThresholdPct: 90,
          passScorePct: l.passScorePct ?? null,
          resourceVersionId: res?.versionId ?? null,
        })
      }
    }
    return course!
  }

  interface QuestionSpec {
    group: number
    kind: 'single' | 'multi' | 'ordering' | 'number' | 'text_short' | 'free'
    stem: string
    options?: { id: string, text: string }[]
    answer?: unknown
    points?: number
    isCritical?: boolean
    explanation?: string
    graderHint?: string
    scoringMethod?: 'formula' | 'all_or_nothing'
  }

  /** Банк вопросов + тест + группы вопросов + состав; итоги теста считаем, как сервис. */
  async function seedQuiz(spec: {
    title: string, description: string, tags: string[]
    bankName: string, bankDescription: string, categoryId: string
    groups: string[], questions: QuestionSpec[]
  }) {
    const [bank] = await tx.insert(schema.questionBanks).values({
      tenantId, name: spec.bankName, description: spec.bankDescription,
      categoryId: spec.categoryId, isShared: true,
    }).returning()
    const [quiz] = await tx.insert(schema.quizzes).values({
      tenantId, title: spec.title, description: [p(spec.description)], kind: 'quiz',
      selectionMode: 'fixed', authorIds: [author], tags: spec.tags, status: 'published',
    }).returning()
    const groups = await tx.insert(schema.questionGroups).values(
      spec.groups.map((title, i) => ({ tenantId, quizId: quiz!.id, title, sortOrder: i })),
    ).returning()

    let total = 0
    for (const [i, q] of spec.questions.entries()) {
      const points = q.points ?? 1
      const [row] = await tx.insert(schema.questions).values({
        tenantId, bankId: bank!.id, questionGroupId: groups[q.group]!.id, kind: q.kind,
        stem: [p(q.stem)], options: q.options ?? null, answer: q.answer ?? null,
        explanation: q.explanation ? [p(q.explanation)] : null,
        graderHint: q.graderHint ?? null, attachFiles: q.kind === 'free',
        isCritical: q.isCritical ?? false, difficulty: 3, points: String(points),
        scoringMethod: q.scoringMethod ?? 'formula', status: 'active', version: 1,
      }).returning()
      await tx.insert(schema.quizQuestions).values({
        tenantId, quizId: quiz!.id, questionId: row!.id, sort: i,
      })
      total += points
    }
    await tx.update(schema.quizzes)
      .set({ totalPoints: String(Math.round(total * 100) / 100), questionCount: spec.questions.length })
      .where(eq(schema.quizzes.id, quiz!.id))
    return quiz!
  }

  // Тесты создаём раньше курсов: урок-тест ссылается на готовый quiz.
  const quizHot = await seedQuiz({
    title: 'Тест: гарячий цех',
    description: 'Перевірка стандартів роботи на гарячій станції.',
    tags: ['кухня', 'стандарти'],
    bankName: 'Кухня', bankDescription: 'Питання про гарячий і холодний цехи',
    categoryId: catKitchen!.id,
    groups: ['Температура і зберігання', 'Процеси на станції'],
    questions: [
      {
        group: 0, kind: 'single', points: 2, isCritical: true,
        stem: '<p>За якої температури зберігається охолоджене мʼясо?</p>',
        options: [
          { id: 'o1', text: 'Від 0 до +4 °C' },
          { id: 'o2', text: 'Від +5 до +8 °C' },
          { id: 'o3', text: 'Від +9 до +12 °C' },
          { id: 'o4', text: 'За кімнатної температури' },
        ],
        answer: { correctId: 'o1' },
        explanation: '<p>Холодильна вітрина гарячого цеху тримає 0…+4 °C, це перевіряється двічі за зміну.</p>',
      },
      {
        group: 0, kind: 'number',
        stem: '<p>Скільки секунд триває миття рук за стандартом «Каппі»?</p>',
        answer: { value: 30, tolerance: 5, toleranceType: 'abs', unit: 'сек' },
      },
      {
        group: 1, kind: 'multi', points: 2, scoringMethod: 'formula',
        stem: '<p>Що кухар робить до початку зміни?</p>',
        options: [
          { id: 'o1', text: 'Перевіряє температуру холодильника' },
          { id: 'o2', text: 'Миє руки та вдягає чисту форму' },
          { id: 'o3', text: 'Вмикає витяжку' },
          { id: 'o4', text: 'Замовляє продукти у постачальника' },
        ],
        answer: { correctIds: ['o1', 'o2', 'o3'] },
      },
      {
        group: 1, kind: 'ordering',
        stem: '<p>Розставте кроки збирання бургера в правильному порядку.</p>',
        options: [
          { id: 'o1', text: 'Підігріти булку' },
          { id: 'o2', text: 'Обсмажити котлету до готовності' },
          { id: 'o3', text: 'Зібрати бургер за схемою' },
          { id: 'o4', text: 'Передати на видачу' },
        ],
        answer: { order: ['o1', 'o2', 'o3', 'o4'] },
      },
    ],
  })

  const quizCashier = await seedQuiz({
    title: 'Тест: каса і сервіс',
    description: 'Стандарт спілкування з гостем на касі.',
    tags: ['каса', 'сервіс'],
    bankName: 'Каса і сервіс', bankDescription: 'Питання про роботу в залі та на касі',
    categoryId: catHall!.id,
    groups: ['Стандарт сервісу', 'Складні ситуації'],
    questions: [
      {
        group: 0, kind: 'single', points: 2,
        stem: '<p>З чого починається робота з гостем біля каси?</p>',
        options: [
          { id: 'o1', text: 'З привітання і зорового контакту' },
          { id: 'o2', text: 'З питання про спосіб оплати' },
          { id: 'o3', text: 'З пропозиції десерту' },
          { id: 'o4', text: 'З уточнення номера картки лояльності' },
        ],
        answer: { correctId: 'o1' },
      },
      {
        group: 0, kind: 'text_short',
        stem: '<p>Яким словом касир підтверджує зібране замовлення перед оплатою?</p>',
        answer: { accepted: ['повторюю', 'повторюю замовлення'], caseSensitive: false, allowTypos: 1 },
      },
      {
        group: 0, kind: 'multi',
        stem: '<p>Що входить до стандарту прощання з гостем?</p>',
        options: [
          { id: 'o1', text: 'Подякувати за замовлення' },
          { id: 'o2', text: 'Назвати час очікування' },
          { id: 'o3', text: 'Запросити прийти ще' },
          { id: 'o4', text: 'Попросити залишити відгук у соцмережах' },
        ],
        answer: { correctIds: ['o1', 'o2', 'o3'] },
      },
      {
        group: 1, kind: 'free', points: 3,
        stem: '<p>Гість повернувся зі скаргою на холодну каву. Опишіть свої дії крок за кроком.</p>',
        answer: { criteria: ['Вибачення', 'Заміна напою', 'Повідомлення керуючому'], minLength: 80 },
        graderHint: 'Очікуємо: вибачення без виправдань, заміна напою без додаткової оплати, запис ситуації і повідомлення керуючому зміни.',
      },
    ],
  })

  const quizSafety = await seedQuiz({
    title: 'Тест: охорона праці',
    description: 'Пожежна безпека, санітарія та дії у позаштатних ситуаціях.',
    tags: ['безпека', 'санітарія'],
    bankName: 'Охорона праці', bankDescription: 'Питання з охорони праці та санітарії',
    categoryId: catSafety!.id,
    groups: ['Пожежна безпека', 'Гігієна'],
    questions: [
      {
        group: 0, kind: 'single', points: 2, isCritical: true,
        stem: '<p>Що робити першим, якщо загорілася олія у фритюрниці?</p>',
        options: [
          { id: 'o1', text: 'Накрити кришкою і вимкнути живлення' },
          { id: 'o2', text: 'Залити водою' },
          { id: 'o3', text: 'Винести фритюрницю на вулицю' },
          { id: 'o4', text: 'Відкрити вікно, щоб вийшов дим' },
        ],
        answer: { correctId: 'o1' },
        explanation: '<p>Вода в гарячій олії дає спалах. Доступ повітря перекривають кришкою, живлення вимикають.</p>',
      },
      {
        group: 0, kind: 'ordering',
        stem: '<p>Розставте дії при порізі на кухні в правильному порядку.</p>',
        options: [
          { id: 'o1', text: 'Зупинити роботу і промити рану' },
          { id: 'o2', text: 'Обробити антисептиком' },
          { id: 'o3', text: 'Накласти водонепроникну повʼязку і рукавичку' },
          { id: 'o4', text: 'Повідомити керуючого зміни' },
        ],
        answer: { order: ['o1', 'o2', 'o3', 'o4'] },
      },
      {
        group: 1, kind: 'multi', points: 2,
        stem: '<p>Які засоби захисту обовʼязкові на гарячій станції?</p>',
        options: [
          { id: 'o1', text: 'Головний убір' },
          { id: 'o2', text: 'Кухарські рукавиці для гарячого' },
          { id: 'o3', text: 'Фартух' },
          { id: 'o4', text: 'Навушники' },
        ],
        answer: { correctIds: ['o1', 'o2', 'o3'] },
      },
      {
        group: 1, kind: 'number',
        stem: '<p>Через скільки годин безперервної роботи міняють одноразові рукавички?</p>',
        answer: { value: 2, tolerance: 0, toleranceType: 'abs', unit: 'год' },
      },
    ],
  })

  const courseOnboarding = await seedCourse({
    title: 'Введення на посаду', slug: 'vvedennya-na-posadu',
    summary: 'Перший тиждень у «Каппі»: правила, графік, хто за що відповідає.',
    code: 'AD-01', categoryId: catOnboarding!.id,
    estimatedMinutes: 40, durationDays: 7, workload: 'Близько години',
    tags: ['адаптація'], isCatalogVisible: true, assignMode: 'catalog_free',
    modules: [{
      title: 'Перший тиждень',
      lessons: [
        {
          title: 'Про мережу «Каппі»', slug: 'pro-merezhu-kappi', minutes: 10,
          body: [
            h('Хто ми'),
            p('<p>«Каппі» — мережа швидкого харчування в Одесі. Дві точки: Лазарева і Сегедська. Гість має отримати однакову страву й однаковий сервіс на будь-якій з них.</p>'),
            note('info', 'Головне правило', 'Стандарт однаковий на всіх точках. Якщо стандарт заважає гостю — повідом керуючого, а не змінюй його самостійно.'),
          ],
        },
        {
          title: 'Графік, форма та перший день', slug: 'hrafik-forma-pershyy-den', minutes: 10, minSeconds: 60,
          body: [
            h('Що взяти на першу зміну'),
            steps(['Змінне взуття із закритим носком', 'Особиста медична книжка', 'Чиста форма', 'Гарний настрій']),
            p('<p>Зміна починається за 15 хвилин до відкриття: переодягання, миття рук, перевірка станції.</p>'),
            note('warn', 'Запізнення', 'Якщо не встигаєш — телефонуй керуючому зміни одразу, а не по факту запізнення.'),
          ],
        },
      ],
    }],
  })

  const courseHot = await seedCourse({
    title: 'Стандарти гарячого цеху', slug: 'standarty-haryachoho-tsehu',
    summary: 'Підготовка станції, температурний режим і збирання страв.',
    code: 'KH-01', categoryId: catKitchen!.id,
    estimatedMinutes: 60, durationDays: 14, workload: 'Близько двох годин',
    tags: ['кухня', 'стандарти'],
    modules: [
      {
        title: 'Робоче місце кухаря',
        lessons: [
          {
            title: 'Підготовка станції перед зміною', slug: 'pidhotovka-stantsiyi', minutes: 15, minSeconds: 120,
            body: [
              h('Порядок підготовки'),
              steps([
                'Перевірити температуру холодильної вітрини',
                'Вимити руки та вдягнути чисту форму',
                'Увімкнути витяжку і прогріти обладнання',
                'Перевірити наявність заготовок на дві години роботи',
              ]),
              p('<p>Станція вважається готовою, коли всі заготовки підписані датою і часом, а термометр показує 0…+4 °C.</p>'),
            ],
          },
          {
            title: 'Температурний режим і зберігання', slug: 'temperaturnyy-rezhym', minutes: 15,
            body: [
              h('Температури, які треба знати'),
              p('<p>Охолоджене мʼясо — 0…+4 °C. Заморожені напівфабрикати — не вище −18 °C. Готова страва на роздачі — не нижче +65 °C.</p>'),
              note('danger', 'Прострочення', 'Продукт із простроченим терміном не «дотягує до кінця зміни». Він списується і прибирається зі станції одразу.'),
            ],
          },
        ],
      },
      {
        title: 'Перевірка знань',
        lessons: [{ title: 'Тест: гарячий цех', quizId: quizHot.id, passScorePct: '80' }],
      },
    ],
  })

  await seedCourse({
    title: 'Робота з клієнтом на касі', slug: 'robota-z-kliyentom-na-kasi',
    summary: 'Стандарт сервісу біля каси і робота зі складними ситуаціями.',
    code: 'KS-01', categoryId: catHall!.id,
    estimatedMinutes: 45, durationDays: 10, workload: 'Близько години',
    tags: ['каса', 'сервіс'], isCatalogVisible: true, assignMode: 'catalog_request',
    modules: [
      {
        title: 'Сервіс біля каси',
        lessons: [
          {
            title: 'Привітання та стандарт замовлення', slug: 'pryvitannya-ta-standart', minutes: 15,
            body: [
              h('Чотири кроки касира'),
              steps(['Привітатися і встановити зоровий контакт', 'Прийняти замовлення', 'Повторити замовлення вголос', 'Назвати суму і час очікування']),
              p('<p>Повторення замовлення вголос економить більше часу, ніж забирає: помилку видно до того, як страву почали готувати.</p>'),
            ],
          },
          {
            title: 'Складні ситуації та скарги', slug: 'skladni-sytuatsiyi', minutes: 15, minSeconds: 90,
            body: [
              h('Якщо гість незадоволений'),
              p('<p>Спочатку вибачення, потім рішення. Сперечатися з гостем на касі не можна навіть тоді, коли гість помиляється.</p>'),
              note('success', 'Що можна вирішити самому', 'Замінити напій чи страву, якщо вона холодна або зібрана не за стандартом. Усе інше — через керуючого зміни.'),
            ],
          },
        ],
      },
      {
        title: 'Перевірка знань',
        lessons: [{ title: 'Тест: каса і сервіс', quizId: quizCashier.id, passScorePct: '75' }],
      },
    ],
  })

  const courseSafety = await seedCourse({
    title: 'Охорона праці та санітарія', slug: 'ohorona-pratsi-ta-sanitariya',
    summary: 'Санітарні правила, пожежна безпека і дії у позаштатних ситуаціях.',
    code: 'OP-01', categoryId: catSafety!.id,
    estimatedMinutes: 50, durationDays: 14, workload: 'Близько півтори години',
    tags: ['безпека', 'санітарія'],
    modules: [
      {
        title: 'Санітарія',
        lessons: [
          {
            title: 'Особиста гігієна працівника', slug: 'osobysta-hihiyena', minutes: 10,
            body: [
              h('Мінімум, який перевіряють щозміни'),
              steps(['Миття рук 30 секунд', 'Чиста форма і головний убір', 'Зібране волосся', 'Без прикрас на руках']),
              note('info', 'Рукавички', 'Одноразові рукавички міняють кожні дві години і після кожної зміни виду продукту.'),
            ],
          },
          {
            title: 'Прибирання і дезінфекція', slug: 'prybyrannya-ta-dezinfektsiya', minutes: 10,
            body: [
              h('Графік прибирання'),
              p('<p>Поверхні контакту з продуктом — після кожної партії. Підлога і зона роздачі — щогодини. Генеральне прибирання — за графіком точки.</p>'),
            ],
          },
        ],
      },
      {
        title: 'Безпека',
        lessons: [
          {
            title: 'Пожежна безпека на кухні', slug: 'pozhezhna-bezpeka', minutes: 15, minSeconds: 120,
            body: [
              h('Загоряння олії'),
              p('<p>Накрити кришкою, вимкнути живлення, викликати керуючого. Водою гасити не можна.</p>'),
              note('danger', 'Евакуація', 'Якщо вогонь вийшов за межі обладнання — евакуація гостей і виклик 101. Гасити самостійно другий раз не пробуємо.'),
            ],
          },
          { title: 'Тест: охорона праці', quizId: quizSafety.id, passScorePct: '90' },
        ],
      },
    ],
  })

  // Программа (docs/17 Г-17.3): упорядоченный набор, выдаётся целиком, условий нет.
  // Для mode=linear рёбра выводятся из порядка узлов (effectiveEdges), поэтому строки
  // program_edges повторяют ту же цепочку один в один — полотно программы читается целиком.
  const [programOnboarding] = await tx.insert(schema.programs).values({
    tenantId,
    title: 'Програма адаптації нового співробітника',
    description: 'Три кроки першого місяця: знайомство з мережею, охорона праці та перевірка знань.',
    mode: 'linear', status: 'published', publishedAt: now,
    assignmentMode: ['manual'], tags: ['адаптація'], dueDays: 30,
    authorIds: [author], updatedBy: author,
  }).returning()

  const programNodeRows = await tx.insert(schema.programNodes).values([
    { tenantId, programId: programOnboarding!.id, nodeType: 'start', sort: 0, position: { x: 40, y: 200 }, isRequired: false },
    { tenantId, programId: programOnboarding!.id, nodeType: 'item', itemType: 'course', itemId: courseOnboarding.id, sort: 1, position: { x: 240, y: 200 }, dueDays: 7 },
    { tenantId, programId: programOnboarding!.id, nodeType: 'item', itemType: 'course', itemId: courseSafety.id, sort: 2, position: { x: 440, y: 200 }, dueDays: 14 },
    { tenantId, programId: programOnboarding!.id, nodeType: 'item', itemType: 'quiz', itemId: quizSafety.id, sort: 3, position: { x: 640, y: 200 } },
    { tenantId, programId: programOnboarding!.id, nodeType: 'finish', sort: 9999, position: { x: 840, y: 200 }, isRequired: false },
  ]).returning()

  await tx.insert(schema.programEdges).values(
    programNodeRows.slice(0, -1).map((n, i) => ({
      tenantId, programId: programOnboarding!.id,
      fromNodeId: n.id, toNodeId: programNodeRows[i + 1]!.id,
      condition: { type: 'always' }, sort: 0,
    })),
  )

  // Траектория (docs/17 §14.3): условий на стрелках нет — логика в узлах. Ветвление по
  // результату теста и «закриття доступу» — наши блоки Г-17.1/Г-17.2, они же в языке полотна.
  const [trajectoryCook] = await tx.insert(schema.trajectories).values({
    tenantId,
    title: 'Траєкторія стажування кухаря',
    description: 'Шлях стажера гарячого цеху: наставник, два курси, тиждень практики і тест із розгалуженням за результатом.',
    status: 'published', publishedAt: now, assignMode: 'manual',
    tags: ['кухня', 'стажування'], stopAssignAfterFinish: true,
    createdBy: author, updatedBy: author,
  }).returning()

  const tNodes = await tx.insert(schema.trajectoryNodes).values([
    { tenantId, trajectoryId: trajectoryCook!.id, kind: 'start', x: 40, y: 240 },
    { tenantId, trajectoryId: trajectoryCook!.id, kind: 'mentor', title: 'Призначити наставника', mentorId: chef!.id, x: 200, y: 240 },
    { tenantId, trajectoryId: trajectoryCook!.id, kind: 'task', title: 'Введення на посаду', contentType: 'course', contentId: courseOnboarding.id, params: { dueDays: 7 }, x: 360, y: 240 },
    { tenantId, trajectoryId: trajectoryCook!.id, kind: 'task', title: 'Стандарти гарячого цеху', contentType: 'course', contentId: courseHot.id, params: { dueDays: 14 }, x: 520, y: 240 },
    { tenantId, trajectoryId: trajectoryCook!.id, kind: 'delay', title: 'Тиждень практики на станції', days: 7, x: 680, y: 240 },
    { tenantId, trajectoryId: trajectoryCook!.id, kind: 'task', title: 'Тест: гарячий цех', contentType: 'test', contentId: quizHot.id, params: { passScore: 80, attemptsAllowed: 2 }, x: 840, y: 240 },
    { tenantId, trajectoryId: trajectoryCook!.id, kind: 'branch', title: 'Розгалуження за результатом тесту', x: 1000, y: 240 },
    { tenantId, trajectoryId: trajectoryCook!.id, kind: 'stop_delay', title: 'Закрити доступ до дотренування через 14 днів', days: 14, x: 1000, y: 400 },
    { tenantId, trajectoryId: trajectoryCook!.id, kind: 'task', title: 'Охорона праці та санітарія', contentType: 'course', contentId: courseSafety.id, params: { dueDays: 10 }, x: 1160, y: 400 },
    { tenantId, trajectoryId: trajectoryCook!.id, kind: 'or', title: 'Будь-яка гілка веде до фінішу', x: 1320, y: 240 },
    { tenantId, trajectoryId: trajectoryCook!.id, kind: 'finish', x: 1480, y: 240 },
  ]).returning()
  const [nStart, nMentor, nIntro, nHot, nDelay, nQuiz, nBranch, nStop, nRetry, nOr, nFinish] = tNodes

  await tx.insert(schema.trajectoryEdges).values([
    { tenantId, trajectoryId: trajectoryCook!.id, fromNodeId: nStart!.id, toNodeId: nMentor!.id, condition: null, sort: 0 },
    { tenantId, trajectoryId: trajectoryCook!.id, fromNodeId: nMentor!.id, toNodeId: nIntro!.id, condition: null, sort: 0 },
    { tenantId, trajectoryId: trajectoryCook!.id, fromNodeId: nIntro!.id, toNodeId: nHot!.id, condition: null, sort: 0 },
    { tenantId, trajectoryId: trajectoryCook!.id, fromNodeId: nHot!.id, toNodeId: nDelay!.id, condition: null, sort: 0 },
    { tenantId, trajectoryId: trajectoryCook!.id, fromNodeId: nDelay!.id, toNodeId: nQuiz!.id, condition: null, sort: 0 },
    { tenantId, trajectoryId: trajectoryCook!.id, fromNodeId: nQuiz!.id, toNodeId: nBranch!.id, condition: null, sort: 0 },
    // Здав на 80+ — далі, інакше тиждень дотренування з обмеженим доступом.
    { tenantId, trajectoryId: trajectoryCook!.id, fromNodeId: nBranch!.id, toNodeId: nOr!.id, condition: { op: 'score_gte', value: 80 }, sort: 0 },
    { tenantId, trajectoryId: trajectoryCook!.id, fromNodeId: nBranch!.id, toNodeId: nStop!.id, condition: { op: 'else' }, sort: 1 },
    { tenantId, trajectoryId: trajectoryCook!.id, fromNodeId: nStop!.id, toNodeId: nRetry!.id, condition: null, sort: 0 },
    { tenantId, trajectoryId: trajectoryCook!.id, fromNodeId: nRetry!.id, toNodeId: nOr!.id, condition: null, sort: 0 },
    { tenantId, trajectoryId: trajectoryCook!.id, fromNodeId: nOr!.id, toNodeId: nFinish!.id, condition: null, sort: 0 },
  ])
})

console.log('Сид применён: тенант «Каппі», 2 точки, 5 позиций, 5 системных ролей, 5 людей'
  + ' и 3 канареечных кандидата (П-16.1, слой 3);'
  + ' учебный контент — 4 курса (12 уроков, 9 материалов), 3 теста (12 вопросов),'
  + ' 1 программа, 1 траектория')
await client.end()
