import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BeatInput, BeatResult } from '../../shared/schemas/learningTime'

/**
 * Нагрузочная проверка PR-21 (`docs/v2/45-plan.md` PR-21, условие выхода; `45` §6.1 «Heartbeat
 * как нагрузка»; `docs/v2/42` §7.3 этап 14): **200 одновременных прохождений**. Биение
 * каждые 30 секунд от каждого проходящего — нагрузка, которой в базовом ТЗ не было;
 * смягчение — запись пачками и агрегат фоном. Проверяется, что под этой нагрузкой
 * **ничего не теряется и агрегат сходится**, а не просто «не упало».
 *
 * Два прогона, оба — 200 параллельных потоков биений, у каждого свой человек:
 *
 * 1. **Через сервис, со своими часами** (детерминированно). 200 потоков × 40 биений (20 минут
 *    прохождения каждому), активность 10–30 с на биение, 10 % биений повторяются параллельно
 *    (ответ потерялся — клиент переспросил), десять потоков последние 10 биений копят без
 *    связи и досылают пакетом. Параллельно с потоками крутятся свёртка `time.rollup` и
 *    закрытие зависших сегментов. Ожидаемое время каждого потока известно заранее — сумма
 *    активности по биениям, — и с ним сверяются ответы, сегменты, витрина и прогресс уроков.
 * 2. **Через HTTP собранного приложения, в реальном времени.** 200 человек со своими
 *    сессиями шлют биения одновременно на `POST /api/v1/learning/time/beat`: вход, CSRF,
 *    права, разбор, групповая запись и пул соединений приложения — всё как в бою. Время тут
 *    реальное, поэтому сверяется не с заранее известным числом, а сквозь слои: сколько
 *    ответы сказали «зачтено» — столько лежит в сегментах и столько же в витрине.
 *
 * Все данные — в отдельном тенанте, который удаляется после прогона.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { recordBeat, recordBeats, closeStaleSessions, beatWriterStats } = await import('../../server/services/learningTime')
const { rollupTenant } = await import('../../server/services/learningTimeRollup')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 4, onnotice: () => {} })

/**
 * Число одновременных прохождений. Приёмка — **200**, так тест и живёт в CI. Переменная
 * `LOAD_LEARNERS` — только для слабой машины разработчика (`LOAD_LEARNERS=20 pnpm vitest run …`):
 * меньше потоков — та же логика и те же проверки, но не приёмка. Кратно 20: каждый двадцатый
 * поток досылает хвост биений офлайн-пакетом.
 */
const LEARNERS = Math.max(20, Math.floor(Number(process.env.LOAD_LEARNERS || 200) / 20) * 20)
const SLUG = 'test-load-time-21'
let tenantId: string
let lessonId: string
let userIds: string[] = []
let enrollmentOf = new Map<string, string>()

/** Детерминированная «случайность»: активность 10–30 с, повтор каждого десятого биения. */
function activeMsOf(stream: number, beat: number): number {
  return 10_000 + ((stream * 7919 + beat * 104_729) % 20_001)
}
const retried = (stream: number, beat: number) => (stream * 31 + beat * 17) % 10 === 0

beforeAll(async () => {
  await cleanupTenant()
  const [t] = await admin`insert into tenants (slug, name) values (${SLUG}, 'Навантаження PR-21') returning id`
  tenantId = t!.id as string
  const [role] = await admin`
    insert into roles (tenant_id, code, name, scopes, is_system, default_scope_type)
    values (${tenantId}, 'employee', 'Співробітник', ${['learn.view', 'learn.attempt']}, true, 'tenant') returning id`
  const users = await admin`
    insert into users (tenant_id, full_name, status, kind)
    select ${tenantId}, 'Навантаження ' || g, 'active', 'employee' from generate_series(1, ${LEARNERS}) as g
    returning id`
  userIds = users.map(u => u.id as string)
  await admin`insert into user_roles (tenant_id, user_id, role_id, scope_type) select ${tenantId}, u, ${role!.id}, 'tenant' from unnest(${userIds}::uuid[]) as u`

  // Одна когорта проходит один и тот же урок онбординга — 200 пар «человек × урок»
  const [c] = await admin`insert into courses (tenant_id, title, slug) values (${tenantId}, 'Онбординг', 'onboarding-load') returning id`
  const [v] = await admin`insert into course_versions (tenant_id, course_id, version, status) values (${tenantId}, ${c!.id}, 1, 'published') returning id`
  await admin`update courses set published_version_id = ${v!.id} where id = ${c!.id}`
  const [m] = await admin`insert into modules (tenant_id, course_version_id, title, sort) values (${tenantId}, ${v!.id}, 'Модуль', 0) returning id`
  const [r] = await admin`insert into resources (tenant_id, title, slug) values (${tenantId}, 'Про мережу', 'about-load') returning id`
  const [l] = await admin`insert into lessons (tenant_id, module_id, title, sort, item_type, item_id) values (${tenantId}, ${m!.id}, 'Про мережу', 0, 'resource', ${r!.id}) returning id`
  lessonId = l!.id as string
  const enr = await admin`
    insert into enrollments (tenant_id, user_id, subject_id, version_id, source, status, started_at)
    select ${tenantId}, u, ${c!.id}, ${v!.id}, 'assigned', 'in_progress', now() from unnest(${userIds}::uuid[]) as u
    returning id, user_id`
  enrollmentOf = new Map(enr.map(e => [e.user_id as string, e.id as string]))
  await admin`insert into lesson_progress (tenant_id, enrollment_id, lesson_id) select ${tenantId}, e, ${lessonId} from unnest(${[...enrollmentOf.values()]}::uuid[]) as e`
}, 120_000)

afterAll(async () => {
  await cleanupTenant()
  await admin.end()
})

async function cleanupTenant() {
  const [t] = await admin`select id from tenants where slug = ${SLUG}`
  if (!t) return
  const id = t.id as string
  await admin`delete from learning_time_sessions where tenant_id = ${id}`
  await admin`delete from learning_time_totals where tenant_id = ${id}`
  await admin`delete from enrollments where tenant_id = ${id}`
  await admin`delete from sessions where tenant_id = ${id}`
  await admin`delete from user_roles where tenant_id = ${id}`
  await admin`delete from courses where tenant_id = ${id}`
  await admin`delete from resources where tenant_id = ${id}`
  await admin`delete from users where tenant_id = ${id}`
  await admin`delete from roles where tenant_id = ${id}`
  await admin`delete from tenants where id = ${id}`
}

async function resetMeasurements() {
  await admin`delete from learning_time_sessions where tenant_id = ${tenantId}`
  await admin`delete from learning_time_totals where tenant_id = ${tenantId}`
  await admin`update lesson_progress set content_seconds = 0, discarded_seconds = 0, sessions_count = 0 where tenant_id = ${tenantId}`
}

function beatOf(userIdx: number, sessionKey: string, seq: number, activeMs: number, clientTs: Date): BeatInput {
  return {
    sessionKey, seq, kind: 'content', subjectType: 'lesson', subjectId: lessonId,
    enrollmentId: enrollmentOf.get(userIds[userIdx]!)!, activeMs, visible: true, clientTs: clientTs.toISOString(), device: 'mobile',
  }
}

// ── 1. Через сервис: 200 потоков, заранее известное время ─────────────────────────────────

describe(`нагрузка: ${LEARNERS} одновременных прохождений через сервис`, () => {
  it('ничего не теряется: ответы = сегменты = витрина = прогресс = ожидание, повторы не удваивают', async () => {
    await resetMeasurements()
    const BEATS = 40
    const OFFLINE_TAIL = 10
    const T0 = Date.now()
    const statsBefore = { ...beatWriterStats }

    const expected = new Array<number>(LEARNERS).fill(0)
    const answered = new Array<number>(LEARNERS).fill(0)
    const mismatchedRetries: string[] = []
    const failures: string[] = []
    const keys: string[] = []

    const stream = async (i: number) => {
      const key = randomUUID()
      keys[i] = key
      const ctx = { tenantId, actorId: userIds[i]! }
      const offline = i % 20 === 0
      const buffered: BeatInput[] = []
      for (let j = 1; j <= BEATS; j++) {
        const active = activeMsOf(i, j)
        expected[i] = (expected[i] ?? 0) + Math.floor(active / 1000)
        const at = new Date(T0 + j * 30_000 + i * 7)
        const b = beatOf(i, key, j, active, at)
        if (offline && j > BEATS - OFFLINE_TAIL) {
          buffered.push(b)
          continue
        }
        const calls = retried(i, j) ? [recordBeat(ctx, b, { now: at }), recordBeat(ctx, b, { now: new Date(at.getTime() + 50) })] : [recordBeat(ctx, b, { now: at })]
        const res = await Promise.all(calls)
        if (res.some(r => !r.ok)) { failures.push(`${i}/${j}: ${JSON.stringify(res)}`); continue }
        const ok = res.map(r => (r as { ok: true, result: BeatResult }).result)
        const original = ok.find(r => !r.duplicate)
        if (!original) { failures.push(`${i}/${j}: нет исходного ответа`); continue }
        answered[i] = (answered[i] ?? 0) + original.credited
        for (const d of ok.filter(r => r.duplicate)) {
          if (d.credited !== original.credited) mismatchedRetries.push(`${i}/${j}: ${d.credited} ≠ ${original.credited}`)
        }
      }
      if (buffered.length) {
        const sentAt = new Date(T0 + (BEATS + 1) * 30_000 + i * 7)
        const r = await recordBeats(ctx, { beats: buffered, sentAt: sentAt.toISOString() }, { now: sentAt })
        if (!r.ok) failures.push(`${i}: пакет отвергнут ${r.code}`)
        else answered[i] = (answered[i] ?? 0) + r.result.credited
      }
    }

    // Фон: свёртка крутится, пока идут биения; один проход закрытия зависших — посередине
    let running = true
    const background = (async () => {
      let staleDone = false
      while (running) {
        await rollupTenant(tenantId)
        if (!staleDone) {
          staleDone = true
          await closeStaleSessions(tenantId, { now: new Date(T0 + 5 * 60_000) })
        }
        await new Promise(r => setTimeout(r, 100))
      }
    })()

    await Promise.all(Array.from({ length: LEARNERS }, (_, i) => stream(i)))
    running = false
    await background

    expect(failures, failures.slice(0, 5).join('\n')).toEqual([])
    expect(mismatchedRetries, 'повтор вернул не тот credited').toEqual([])
    // Ответы клиентам — ровно то, что должно было зачесться
    expect(answered).toEqual(expected)

    // Сегменты в базе — те же секунды, ни одно биение не потеряно и не посчитано дважды
    const perUser = await admin`
      select user_id, sum(credited_seconds)::int as credited, sum(beats_count)::int as beats,
        count(*) filter (where closed_reason is null)::int as open
      from learning_time_sessions where tenant_id = ${tenantId} group by user_id`
    expect(perUser).toHaveLength(LEARNERS)
    const byUser = new Map(perUser.map(r => [r.user_id as string, r]))
    for (let i = 0; i < LEARNERS; i++) {
      const row = byUser.get(userIds[i]!)!
      expect(row.credited, `поток ${i}: сегменты`).toBe(expected[i])
      expect(row.beats, `поток ${i}: биения`).toBe(BEATS)
      expect(row.open, `поток ${i}: открытых сегментов`).toBeLessThanOrEqual(1)
    }
    const replayed = await admin`select count(distinct user_id)::int as n from learning_time_sessions where tenant_id = ${tenantId} and is_offline_replay`
    expect(replayed[0]!.n).toBe(LEARNERS / 20)

    // Агрегат фоном сходится: финальная свёртка — и витрина, и прогресс уроков равны ожиданию
    await rollupTenant(tenantId)
    const totals = await admin`select user_id, content_seconds, sessions_count from learning_time_totals where tenant_id = ${tenantId}`
    expect(totals).toHaveLength(LEARNERS)
    const progress = await admin`
      select e.user_id, lp.content_seconds from lesson_progress lp join enrollments e on e.id = lp.enrollment_id
      where lp.tenant_id = ${tenantId}`
    const totalOf = new Map(totals.map(r => [r.user_id as string, r.content_seconds as number]))
    const progressOf = new Map(progress.map(r => [r.user_id as string, r.content_seconds as number]))
    for (let i = 0; i < LEARNERS; i++) {
      expect(totalOf.get(userIds[i]!), `поток ${i}: витрина`).toBe(expected[i])
      expect(progressOf.get(userIds[i]!), `поток ${i}: lesson_progress`).toBe(expected[i])
    }
    // Сошлась — значит, следующий прогон ничего не меняет
    expect(await rollupTenant(tenantId)).toMatchObject({ totals: 0, lessonProgress: 0 })

    // Запись действительно шла пачками: транзакций меньше, чем биений
    const batches = beatWriterStats.batches - statsBefore.batches
    const beats = beatWriterStats.beats - statsBefore.beats
    console.info(`[load] биений ${beats}, транзакций ${batches}, крупнейшая пачка ${beatWriterStats.maxBatch}, поштучных разборов ${beatWriterStats.fallbacks - statsBefore.fallbacks}`)
    expect(beats).toBeGreaterThanOrEqual(LEARNERS * (BEATS - 1))
    expect(batches).toBeLessThan(beats)
    expect(beatWriterStats.maxBatch).toBeGreaterThan(1)
    // Ни одна пачка не упала (взаимоблокировка, нарушение «один открытый сегмент на пару»):
    // поштучный разбор — страховка, а не штатный путь
    expect(beatWriterStats.fallbacks - statsBefore.fallbacks).toBe(0)
  }, 600_000)
})

// ── 2. Через HTTP собранного приложения, в реальном времени ──────────────────────────────

const BUILT = existsSync('.output/server/index.mjs')
const PORT = 3821
const BASE = `http://127.0.0.1:${PORT}`
let server: ChildProcess | undefined

describe.skipIf(!BUILT)(`нагрузка: ${LEARNERS} человек шлют биения по HTTP одновременно`, () => {
  const cookies: string[] = []

  beforeAll(async () => {
    const { createSession } = await import('../../server/services/session')
    for (const userId of userIds) {
      const { token } = await createSession({ tenantId, userId })
      // Двойная отправка cookie (docs/04 §4.1): значение любое, лишь бы совпало с заголовком
      cookies.push(`lola_sid=${token}; lola_csrf=load-${userId}`)
    }
    server = spawn('node', ['.output/server/index.mjs'], {
      env: { ...process.env, PORT: String(PORT), NITRO_PORT: String(PORT), NUXT_DATABASE_URL: process.env.DATABASE_URL, WORKER_ENABLED: '0' },
      stdio: 'ignore',
    })
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`${BASE}/health`)).ok) return }
      catch { /* ещё поднимается */ }
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Собранное приложение не поднялось за 60 секунд')
  }, 180_000)

  afterAll(() => {
    server?.kill()
  })

  it('каждое биение принято, «зачтено» в ответах = сегменты = витрина', async () => {
    await resetMeasurements()
    const BEATS = 4
    const answered = new Array<number>(LEARNERS).fill(0)
    const statuses = new Map<number, number>()
    const post = async (i: number, b: BeatInput) => {
      const csrf = `load-${userIds[i]}`
      const res = await fetch(`${BASE}/api/v1/learning/time/beat`, {
        method: 'POST',
        headers: { 'cookie': cookies[i]!, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: JSON.stringify(b),
      })
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1)
      return res.ok ? ((await res.json()) as { data: BeatResult }).data : null
    }

    await Promise.all(userIds.map(async (_, i) => {
      const key = randomUUID()
      for (let j = 1; j <= BEATS; j++) {
        if (j > 1) await new Promise(r => setTimeout(r, 1_200))
        const b = beatOf(i, key, j, 30_000, new Date())
        // Каждый пятый поток переспрашивает второе биение — ответ не должен удвоиться
        const sent = i % 5 === 0 && j === 2 ? await Promise.all([post(i, b), post(i, b)]) : [await post(i, b)]
        const original = sent.find(r => r && !r.duplicate)
        if (original) answered[i] = (answered[i] ?? 0) + original.credited
      }
    }))

    expect(Object.fromEntries(statuses), 'все биения приняты: ни 4xx, ни 5xx').toEqual({ 200: LEARNERS * BEATS + LEARNERS / 5 })
    const rows = await admin`
      select user_id, sum(credited_seconds)::int as credited, sum(beats_count)::int as beats
      from learning_time_sessions where tenant_id = ${tenantId} group by user_id`
    expect(rows).toHaveLength(LEARNERS)
    const byUser = new Map(rows.map(r => [r.user_id as string, r]))
    for (let i = 0; i < LEARNERS; i++) {
      const row = byUser.get(userIds[i]!)!
      expect(row.beats, `человек ${i}: биения`).toBe(BEATS)
      expect(row.credited, `человек ${i}: зачтено`).toBe(answered[i])
      // Первое биение сеанса — не больше заявки, остальные — не больше прошедшего по часам сервера
      expect(row.credited).toBeLessThanOrEqual(30 + (BEATS - 1) * 30)
    }

    await rollupTenant(tenantId)
    const totals = await admin`select user_id, content_seconds from learning_time_totals where tenant_id = ${tenantId}`
    expect(totals).toHaveLength(LEARNERS)
    for (const t of totals) expect(t.content_seconds).toBe(byUser.get(t.user_id as string)!.credited)
  }, 300_000)
})
