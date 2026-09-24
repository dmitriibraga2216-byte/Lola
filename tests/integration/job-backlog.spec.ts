import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Накопленное за сбой фоновых задач (с 19.09.2026; docs/25 §17, docs/12 §7 п. 8, docs/v2/46).
 *
 * 1. Разовая уборка из миграции `…_jobs_tenant_sources`: уведомления и доставки вебхуков, чей срок
 *    прошёл больше суток назад, — `failed` с причиной; свежее и будущее не трогается. Запросы
 *    берутся из самого файла миграции и выполняются так же, как их выполнит сервис `migrate`, —
 *    ролью `lola` (DATABASE_ADMIN_URL), но в транзакции, которая откатывается: уборка глобальная,
 *    и чужие строки общей тестовой базы она менять не должна.
 * 2. Отчёт о пропущенных приглашениях — запрос из docs/25 §17.1, выполняется там же, после уборки:
 *    документ обязан содержать работающий запрос.
 * 3. Постоянное правило `attempt.expire`: закрытие, опоздавшее больше чем на сутки, пишет результат,
 *    но не ставит уведомлений и вебхуков; свежее просроченное — как раньше. Заодно — завершённые
 *    попытки не трогаются (прежний `or` без скобок захватывал их) и «сутки без активности»
 *    считаются от последнего ответа, а не от старта.
 */

const { expireStaleAttempts } = await import('../../server/services/attempts')

const root = resolve(__dirname, '../..')
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
const stamp = Date.now().toString(36)
const REASON = 'Не надіслано: збій фонової доставки'

/** UPDATE-запросы разовой уборки — прямо из файла миграции. */
function cleanupStatements(): string[] {
  const dir = join(root, 'server/db/migrations')
  const file = readdirSync(dir).find(f => f.endsWith('_jobs_tenant_sources.sql'))
  if (!file) throw new Error('миграция *_jobs_tenant_sources.sql не найдена')
  return readFileSync(join(dir, file), 'utf8').split('--> statement-breakpoint')
    .map(s => s.replace(/^(\s*--[^\n]*\n)*/, '').trim())
    .filter(s => /^UPDATE\b/i.test(s))
}

/** Запрос «пропущенные приглашения» — прямо из docs/25 §17.1. */
function reportQuery(): string {
  const doc = readFileSync(join(root, 'docs/25-multitenancy.md'), 'utf8')
  const block = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map(m => m[1]!).find(b => b.includes('Пропущенные приглашения'))
  if (!block) throw new Error('в docs/25 нет запроса «Пропущенные приглашения»')
  return block
}

class Rollback extends Error {}

let tenantId: string
let tenantName: string
let endpointId: string
let quizId: string
const users: Record<string, string> = {}

async function person(key: string, status: 'invited' | 'active') {
  const phone = `+38093${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, full_name, phone, status) values (${tenantId}, ${`Людина ${key}`}, ${phone}, ${status}) returning id`
  users[key] = u!.id as string
  return users[key]!
}

beforeAll(async () => {
  tenantName = `Після збою ${stamp}`
  const [t] = await admin`insert into tenants (slug, name, status) values (${`backlog-${stamp}`}, ${tenantName}, 'active') returning id`
  tenantId = t!.id as string
  const [e] = await admin`
    insert into webhook_endpoints (tenant_id, url, secret_encrypted, nonce, events)
    values (${tenantId}, 'http://127.0.0.1:9/hook', decode('00', 'hex'), decode('00', 'hex'), array['attempt.passed', 'attempt.failed'])
    returning id`
  endpointId = e!.id as string
  const [q] = await admin`insert into quizzes (tenant_id, title, status) values (${tenantId}, 'Тест після збою', 'published') returning id`
  quizId = q!.id as string
})

afterAll(async () => {
  await admin`delete from attempts where tenant_id = ${tenantId}`
  await admin`delete from quizzes where tenant_id = ${tenantId}`
  await admin`delete from webhook_endpoints where tenant_id = ${tenantId}`
  await admin`delete from notifications where tenant_id = ${tenantId}`
  await admin`delete from task_status_log where tenant_id = ${tenantId}`
  await admin`delete from invitations where tenant_id = ${tenantId}`
  await admin`delete from users where tenant_id = ${tenantId}`
  await admin`delete from tenants where id = ${tenantId}`
  await admin.end()
})

describe('разовая уборка накопленного (миграция) и отчёт о пропущенных приглашениях', () => {
  const ids: Record<string, string> = {}

  beforeAll(async () => {
    const lost = await person('пропущене запрошення', 'invited')
    const joined = await person('прийшов за посиланням', 'active')
    const fresh = await person('свіже запрошення', 'invited')
    const resent = await person('вже переслали', 'invited')
    const notification = async (key: string, userId: string, code: string, status: string, due: string, created = due) => {
      const [n] = await admin.unsafe(`
        insert into notifications (tenant_id, user_id, code, channel, payload, status, scheduled_for, created_at)
        values ($1, $2, $3, 'telegram', '{}', $4, now() + $5::interval, now() + $6::interval) returning id`, [tenantId, userId, code, status, due, created])
      ids[key] = n!.id as string
    }
    await notification('old', lost, 'user_invited', 'queued', '-3 days')
    await notification('oldJoined', joined, 'user_invited', 'queued', '-3 days')
    await notification('fresh', fresh, 'user_invited', 'queued', '-23 hours')
    await notification('future', fresh, 'manual', 'queued', '+1 day', '-1 hour')
    await notification('sentOld', fresh, 'manual', 'sent', '-3 days')
    await notification('resentOld', resent, 'user_invited', 'queued', '-3 days')
    await notification('resentNew', resent, 'user_invited', 'sent', '-1 hour')
    await admin`insert into invitations (tenant_id, user_id, token_hash, expires_at, accepted_at)
      values (${tenantId}, ${joined}, ${`backlog-${stamp}`}, now() - interval '1 day', now() - interval '2 days')`
    const delivery = async (key: string, status: string, next: string) => {
      const [d] = await admin.unsafe(`
        insert into webhook_deliveries (tenant_id, endpoint_id, event, payload, status, next_attempt_at)
        values ($1, $2, 'attempt.passed', '{}', $3, now() + $4::interval) returning id`, [tenantId, endpointId, status, next])
      ids[key] = d!.id as string
    }
    await delivery('dOld', 'pending', '-3 days')
    await delivery('dFresh', 'pending', '-23 hours')
    await delivery('dFuture', 'pending', '+1 hour')
    await delivery('dDelivered', 'delivered', '-3 days')
  })

  it('в миграции ровно два запроса уборки: уведомления и доставки вебхуков', () => {
    const stmts = cleanupStatements()
    expect(stmts).toHaveLength(2)
    expect(stmts[0]).toMatch(/^UPDATE notifications\b/)
    expect(stmts[1]).toMatch(/^UPDATE webhook_deliveries\b/)
  })

  it('старше суток — failed с причиной; свежее, будущее и уже отправленное не тронуто; отчёт — только те, кому слать заново', async () => {
    type Note = { id: string, status: string, error: string | null }
    type Delivery = { id: string, status: string, response_body: string | null }
    let notes: Note[] = []
    let deliveries: Delivery[] = []
    let report: Record<string, unknown>[] = []
    await admin.begin(async (tx) => {
      for (const stmt of cleanupStatements()) await tx.unsafe(stmt)
      notes = await tx<Note[]>`select id, status, error from notifications where tenant_id = ${tenantId}`
      deliveries = await tx<Delivery[]>`select id, status, response_body from webhook_deliveries where tenant_id = ${tenantId}`
      report = await tx.unsafe<Record<string, unknown>[]>(reportQuery())
      throw new Rollback()
    }).catch((err) => { if (!(err instanceof Rollback)) throw err })

    const note = (key: string) => notes.find(n => n.id === ids[key])!
    for (const key of ['old', 'oldJoined', 'resentOld']) {
      expect(note(key).status, key).toBe('failed')
      expect(note(key).error, key).toMatch(new RegExp(`^${REASON}`))
    }
    expect(note('fresh')).toMatchObject({ status: 'queued', error: null }) // 23 часа — уходит как обычно
    expect(note('future')).toMatchObject({ status: 'queued', error: null })
    expect(note('sentOld')).toMatchObject({ status: 'sent', error: null })
    expect(note('resentNew')).toMatchObject({ status: 'sent' })

    const delivery = (key: string) => deliveries.find(d => d.id === ids[key])!
    expect(delivery('dOld').status).toBe('failed')
    expect(delivery('dOld').response_body).toMatch(new RegExp(`^${REASON}`))
    expect(delivery('dFresh')).toMatchObject({ status: 'pending', response_body: null })
    expect(delivery('dFuture')).toMatchObject({ status: 'pending', response_body: null })
    expect(delivery('dDelivered')).toMatchObject({ status: 'delivered' })

    // Отчёт: только приглашённый, который не пришёл и которому ещё не переслали
    const mine = report.filter(r => r.space === tenantName)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ full_name: 'Людина пропущене запрошення' })
    expect(mine[0]!.phone).toMatch(/^\+38093/)
    expect(new Date(mine[0]!.invited_at as Date).getTime()).toBeLessThan(Date.now() - 2 * 86_400_000)

    // Откат сработал: глобальная уборка не осталась в общей тестовой базе
    const [{ n }] = await admin<[{ n: number }]>`select count(*)::int as n from notifications where tenant_id = ${tenantId} and status = 'failed'`
    expect(n).toBe(0)
  })
})

describe('attempt.expire: тихое закрытие опоздавших больше чем на сутки (docs/12 §7 п. 8)', () => {
  const questionId = '0b6c5e2e-1f4a-4d0e-9d36-5c6a2f1e7a01'
  const snapshot = JSON.stringify([{ id: questionId, version: 1, kind: 'single', stem: 'Питання', options: [{ id: 'a' }, { id: 'b' }], answer: { correctId: 'a' }, explanation: null, points: 1, isCritical: false, negativeMarking: false }])
  const params = JSON.stringify({ passScore: 50, attemptsAllowed: 0, showScore: true })
  const att: Record<string, string> = {}

  /** Попытка с одним ответом; время — смещения от now() (интервалы Postgres). */
  async function attempt(key: string, o: { status?: string, started: string, deadline?: string, answered?: string }) {
    const userId = await person(`спроба ${key}`, 'active')
    const [a] = await admin.unsafe(`
      insert into attempts (tenant_id, quiz_id, user_id, attempt_no, snapshot, params, status, started_at, updated_at, deadline_at)
      values ($1, $2, $3, 1, $4::jsonb, $5::jsonb, $6, now() + $7::interval, now() + $7::interval, now() + $8::interval) returning id`,
    [tenantId, quizId, userId, snapshot, params, o.status ?? 'in_progress', o.started, o.deadline ?? null])
    att[key] = a!.id as string
    if (o.answered) {
      await admin.unsafe(`
        insert into attempt_answers (tenant_id, attempt_id, question_id, question_version, answer, answered_at)
        values ($1, $2, $3, 1, '{"optionId":"a"}', now() + $4::interval)`, [tenantId, att[key], questionId, o.answered])
    }
  }

  const stateOf = async (key: string) => (await admin`select status, updated_at from attempts where id = ${att[key]!}`)[0]!
  const resultsOf = async (key: string) => (await admin<[{ n: number }]>`select count(*)::int as n from attempt_results where attempt_id = ${att[key]!}`)[0]!.n
  const notificationsOf = async (key: string) => admin`
    select n.code, n.dedup_key from notifications n join attempts a on a.user_id = n.user_id where a.id = ${att[key]!}`
  const webhooksOf = async (key: string) => (await admin<[{ n: number }]>`
    select count(*)::int as n from webhook_deliveries where tenant_id = ${tenantId} and payload->'data'->>'attemptId' = ${att[key]!}`)[0]!.n
  const logOf = async (key: string) => (await admin<[{ n: number }]>`select count(*)::int as n from task_status_log where source_id = ${att[key]!}`)[0]!.n

  let result: { closed: number, quiet: number }
  const before: Record<string, { status: string, updated_at: Date }> = {}

  beforeAll(async () => {
    // Мёртвая больше суток по дедлайну: воркер стоял три дня
    await attempt('deadByDeadline', { started: '-3 days', deadline: '-3 days +30 minutes', answered: '-3 days +10 minutes' })
    // Свежая просроченная: дедлайн час назад
    await attempt('freshByDeadline', { started: '-2 hours', deadline: '-1 hour', answered: '-90 minutes' })
    // Без лимита, последний ответ три дня назад: срок закрытия (сутки после ответа) прошёл двое суток назад
    await attempt('deadIdle', { started: '-3 days', answered: '-3 days +5 minutes' })
    // Без лимита, начата двое суток назад, но ответ час назад — активна, закрывать нельзя
    await attempt('activeLong', { started: '-2 days', answered: '-1 hour' })
    // Без лимита, сутки и час без активности: обычное закрытие по бездействию — с уведомлением, как раньше
    await attempt('freshIdle', { started: '-26 hours', answered: '-25 hours' })
    // Завершённые давно: прежний `or` без скобок захватывал их и оценивал заново
    await attempt('donePassed', { status: 'passed', started: '-3 days' })
    await attempt('doneAnnulled', { status: 'annulled', started: '-3 days' })
    await attempt('doneFailed', { status: 'failed', started: '-3 days', deadline: '-3 days +30 minutes' })
    for (const key of ['donePassed', 'doneAnnulled', 'doneFailed']) before[key] = await stateOf(key) as { status: string, updated_at: Date }
    result = await expireStaleAttempts(tenantId)
  })

  it('закрыто четыре, из них тихо два — мёртвые больше суток', () => {
    expect(result).toEqual({ closed: 4, quiet: 2 })
  })

  it('мёртвая больше суток: закрыта с результатом и журналом, без уведомлений и вебхуков', async () => {
    for (const key of ['deadByDeadline', 'deadIdle']) {
      expect((await stateOf(key)).status, key).toBe('passed')
      expect(await resultsOf(key), key).toBe(1)
      expect(await logOf(key), key).toBe(1) // цепочка последствий отработала — глушатся только новости
      expect(await notificationsOf(key), key).toEqual([])
      expect(await webhooksOf(key), key).toBe(0)
    }
  })

  it('свежая просроченная (по дедлайну и по суткам бездействия): закрыта с уведомлением и вебхуком, как раньше', async () => {
    for (const key of ['freshByDeadline', 'freshIdle']) {
      expect((await stateOf(key)).status, key).toBe('passed')
      expect(await resultsOf(key), key).toBe(1)
      expect(await notificationsOf(key), key).toEqual([{ code: 'attempt_passed', dedup_key: `attempt_result:${att[key]}` }])
      expect(await webhooksOf(key), key).toBe(1)
    }
  })

  it('активная попытка без лимита не закрыта: сутки считаются от последнего ответа, а не от старта', async () => {
    expect((await stateOf('activeLong')).status).toBe('in_progress')
    expect(await resultsOf('activeLong')).toBe(0)
  })

  it('завершённые попытки не тронуты: ни статуса, ни результата, ни updated_at', async () => {
    for (const key of ['donePassed', 'doneAnnulled', 'doneFailed']) {
      expect(await stateOf(key), key).toEqual(before[key])
      expect(await resultsOf(key), key).toBe(0)
      expect(await webhooksOf(key), key).toBe(0)
    }
  })
})
