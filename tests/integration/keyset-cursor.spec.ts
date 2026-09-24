import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KEYSETS, decodeKeyset } from '../../shared/domain/keyset'

/**
 * Ключевой курсор не теряет и не повторяет строки одной миллисекунды — детерминированно,
 * без нагрузки (`shared/domain/keyset.ts`, docs/04-api.md §4.1).
 *
 * **Что было сломано.** Курсоры кодировали момент через JS `Date` (`toISOString()`,
 * `getTime()`), то есть в миллисекундах, а `timestamptz` хранит микросекунды. Курсор
 * `…00.123Z` вместо `…00.123456Z` на убывающей сортировке выбрасывал все строки между
 * `.123000` и `.123456` (доска кандидатов, история платежей, лента комментариев), на
 * возрастающей — возвращал ту же страницу по кругу (очередь проверки). У журналов не было
 * второго ключа, и строки одного момента терялись на границе страниц; список людей со второй
 * страницы падал вовсе (`Date` в сыром `sql```). Под нагрузкой несколько строк попадают в одну
 * миллисекунду — отсюда «периодический» `expected 251 to be 253` у `v2-candidates-funnel`.
 *
 * **Как проверяется.** В каждом списке заводятся семь строк внутри **одной** миллисекунды:
 * микросекунды разные, у двух — одинаковые (ничью решает id). Список обходится курсором со
 * страницами по 1, 2 и 3 строки — так граница страницы проходит между любыми двумя соседями,
 * в том числе внутри ничьей. Обход обязан вернуть каждую строку ровно один раз и в том же
 * порядке, что `order by` в базе.
 *
 * **Грабля для тех, кто будет писать такие тесты.** Момент вставляется как
 * `${строка}::text::timestamptz`, а не `${строка}::timestamptz`: во втором случае Postgres
 * объявляет параметр `timestamptz`, и postgres.js сериализует его через
 * `new Date(x).toISOString()` — микросекунды обрезаются ещё до базы, и тест проверяет не то.
 * Поэтому прежние тесты с явными датами бага не видели: он проявлялся только на `now()`.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { viewerOf } = await import('../../server/services/candidates')
const { board, boardColumn } = await import('../../server/services/candidateFunnel')
const { listPeople } = await import('../../server/services/people')
const { listReviewQueue } = await import('../../server/services/reviewQueue')
const { listTenantPayments } = await import('../../server/services/billing')
const { listComments } = await import('../../server/services/comments')
const { readLogPage } = await import('../../server/services/logs')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

/** Семь моментов одной миллисекунды `.123`: разные микросекунды и пара одинаковых. */
const MICROS = ['123100', '123200', '123300', '123456', '123456', '123457', '123999'] as const
const at = (second: string, i: number) => `${second}.${MICROS[i]}Z`
/** Размеры страниц: при единице граница проходит между любыми двумя соседями. */
const LIMITS = [1, 2, 3] as const
const MARK = 'KEYSET-'

let tenantId: string
let adminId: string
let learnerId: string
let logUserId: string

type Page = { ids: string[], cursor: string | null }

/**
 * Обход списка курсором до `null`. Если курсор не кончается (страница повторяется по кругу,
 * как было у очереди проверки), обход обрывается на `maxPages` с понятным текстом.
 */
async function walk(limit: number, fetchPage: (limit: number, cursor?: string) => Promise<Page>, maxPages = 80): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | undefined
  for (let n = 0; n < maxPages; n++) {
    const page = await fetchPage(limit, cursor)
    expect(page.ids.length, 'страница больше лимита').toBeLessThanOrEqual(limit)
    ids.push(...page.ids)
    if (!page.cursor) return ids
    cursor = page.cursor
  }
  throw new Error(`limit=${limit}: курсор не закончился за ${maxPages} страниц — страница повторяется по кругу`)
}

/** Каждая заведённая строка — ровно один раз и в порядке базы; чужих дублей тоже нет. */
function expectExactlyOnce(walked: string[], expected: string[], limit: number) {
  expect(new Set(walked).size, `limit=${limit}: строки повторились`).toBe(walked.length)
  const mine = new Set(expected)
  expect(walked.filter(id => mine.has(id)), `limit=${limit}: пропуски или чужой порядок`).toEqual(expected)
}

async function cleanup() {
  await admin`delete from review_queue_items where tenant_id = ${tenantId} and task_title like ${`${MARK}%`}`
  await admin`delete from tenant_payments where tenant_id = ${tenantId} and comment like ${`${MARK}%`}`
  await admin`delete from comments where tenant_id = ${tenantId} and body like ${`${MARK}%`}`
  await admin`delete from security_log where tenant_id = ${tenantId} and event like 'keyset.%'`
  // Записи на курс, события и уведомления человека уходят каскадом вместе с ним.
  await admin`delete from users where tenant_id = ${tenantId} and full_name like ${`${MARK}%`}`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  learnerId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000003'`)[0]!.id as string
  await cleanup()
  const [u] = await admin`
    insert into users (tenant_id, kind, full_name, status)
    values (${tenantId}, 'employee', ${`${MARK}L журнали`}, 'active') returning id`
  logUserId = u!.id as string
})

afterAll(async () => {
  await cleanup()
  await admin.end()
})

describe('канбан воронки: «Показати ще» (docs/v2/28 §5.2)', () => {
  const second = '2026-09-24T09:00:00'
  let statusId: string
  let expected: string[]
  const hr = () => viewerOf({ userId: adminId, tenantId, grants: [{ scopes: ['candidate.view'], scopeType: 'tenant', scopeId: null }] })

  beforeAll(async () => {
    statusId = (await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'new'`)[0]!.id as string
    for (let i = 0; i < MICROS.length; i++) {
      await admin`
        insert into users (tenant_id, kind, candidate_state, candidate_state_at, candidate_status_id, full_name, status, source, created_at)
        values (${tenantId}, 'candidate', 'active', now(), ${statusId}, ${`${MARK}C кандидат ${i}`}, 'invited', 'manual', ${at(second, i)}::text::timestamptz)`
    }
    expected = (await admin`
      select id from users where tenant_id = ${tenantId} and full_name like ${`${MARK}C %`}
       order by created_at desc, id desc`).map(r => r.id as string)
  })

  it('первая страница доски несёт курсор с микросекундами последней карточки, а не миллисекундами', async () => {
    const column = (await board(hr(), { limit: 2, q: `${MARK}C` })).find(c => c.statusId === statusId)!
    expect(column.cards.map(c => c.id)).toEqual(expected.slice(0, 2))
    const [cursorAt, cursorId] = decodeKeyset(KEYSETS.candidateBoard, column.nextCursor)!
    expect(cursorAt).toBe(at(second, 5))
    expect(cursorId).toBe(expected[1])
  })

  it.each(LIMITS)('обход колонки страницами по %i: каждая карточка ровно один раз', async (limit) => {
    const walked = await walk(limit, async (lim, cursor) => {
      if (!cursor) {
        const column = (await board(hr(), { limit: lim, q: `${MARK}C` })).find(c => c.statusId === statusId)!
        return { ids: column.cards.map(c => c.id), cursor: column.nextCursor }
      }
      const page = await boardColumn(hr(), statusId, { limit: lim, q: `${MARK}C`, cursor })
      return { ids: page!.cards.map(c => c.id), cursor: page!.nextCursor }
    })
    expectExactlyOnce(walked, expected, limit)
  })
})

describe('люди: «Показати ще» (docs/16 §5.1; выгрузка листает тем же курсором)', () => {
  const second = '2026-09-24T09:00:01'
  let expected: string[]

  beforeAll(async () => {
    for (let i = 0; i < MICROS.length; i++) {
      await admin`
        insert into users (tenant_id, kind, full_name, status, created_at)
        values (${tenantId}, 'employee', ${`${MARK}P людина ${i}`}, 'active', ${at(second, i)}::text::timestamptz)`
    }
    expected = (await admin`
      select id from users where tenant_id = ${tenantId} and full_name like ${`${MARK}P %`}
       order by created_at desc, id desc`).map(r => r.id as string)
  })

  it.each(LIMITS)('обход страницами по %i: каждый человек ровно один раз', async (limit) => {
    const walked = await walk(limit, async (lim, cursor) => {
      const page = await listPeople({ tenantId, actorId: adminId }, { tab: 'all', q: `${MARK}P`, limit: lim, ...(cursor ? { cursor } : {}) })
      return { ids: page.items.map(r => r.id), cursor: page.cursor }
    })
    expectExactlyOnce(walked, expected, limit)
  })

  it('служебный момент курсора наружу не отдаётся', async () => {
    const page = await listPeople({ tenantId, actorId: adminId }, { tab: 'all', q: `${MARK}P`, limit: 2 })
    expect(Object.keys(page.items[0]!)).not.toContain('cursorAt')
  })
})

describe('очередь проверки: «Показати ще» (docs/v2/37 §10)', () => {
  const second = '2026-09-24T09:00:02'
  let trackId: string
  let expected: string[]

  beforeAll(async () => {
    trackId = (await admin`select gen_random_uuid() as id`)[0]!.id as string
    // Две строки с повышенным приоритетом — чтобы в ключе работала и первая часть, `-priority`.
    for (let i = 0; i < MICROS.length; i++) {
      await admin`
        insert into review_queue_items (tenant_id, task_type, source_id, user_id, task_title, track_id, priority, submitted_at)
        values (${tenantId}, 'offline_confirm', gen_random_uuid(), ${learnerId}, ${`${MARK}Q ${i}`}, ${trackId},
                ${i === 2 || i === 5 ? 1 : 0}, ${at(second, i)}::text::timestamptz)`
    }
    expected = (await admin`
      select id from review_queue_items where track_id = ${trackId}
       order by -priority, submitted_at, id`).map(r => r.id as string)
  })

  it.each(LIMITS)('обход страницами по %i: каждая работа ровно один раз, страница не повторяется', async (limit) => {
    const walked = await walk(limit, async (lim, cursor) => {
      const page = await listReviewQueue({ tenantId, actorId: adminId }, { tab: 'mine', trackId, overdue: false, limit: lim, ...(cursor ? { cursor } : {}) })
      return { ids: page.items.map(r => r.id), cursor: page.cursor }
    })
    expectExactlyOnce(walked, expected, limit)
  })

  it('служебный момент курсора наружу не отдаётся', async () => {
    const page = await listReviewQueue({ tenantId, actorId: adminId }, { tab: 'mine', trackId, overdue: false, limit: 2 })
    expect(Object.keys(page.items[0]!)).not.toContain('cursorAt')
  })
})

describe('история платежей: «Показати ще» (docs/v2/35 §5.3)', () => {
  const second = '2001-02-03T04:05:06'
  let expected: string[]

  beforeAll(async () => {
    for (let i = 0; i < MICROS.length; i++) {
      await admin`
        insert into tenant_payments (tenant_id, kind, amount_minor, status, comment, created_at)
        values (${tenantId}, 'adjustment', ${100 + i}, 'paid', ${`${MARK}платіж ${i}`}, ${at(second, i)}::text::timestamptz)`
    }
    expected = (await admin`
      select id from tenant_payments where tenant_id = ${tenantId} and comment like ${`${MARK}%`}
       order by created_at desc, id desc`).map(r => r.id as string)
  })

  it.each(LIMITS)('обход страницами по %i: каждый платёж ровно один раз', async (limit) => {
    const walked = await walk(limit, async (lim, cursor) => {
      const page = await listTenantPayments(tenantId, { limit: lim, from: '2001-02-03', to: '2001-02-03', ...(cursor ? { cursor } : {}) })
      return { ids: page.items.map(r => r.id), cursor: page.nextCursor }
    })
    expectExactlyOnce(walked, expected, limit)
  })
})

describe('лента комментариев: курсор выдаёт сервер (docs/10 §14.2)', () => {
  // Будущая дата: заведённые строки идут первыми, а обход до конца захватывает и чужие —
  // для них проверяется только отсутствие повторов.
  const second = '2100-01-01T00:00:00'
  let expected: string[]

  beforeAll(async () => {
    const sourceId = (await admin`select gen_random_uuid() as id`)[0]!.id as string
    for (let i = 0; i < MICROS.length; i++) {
      await admin`
        insert into comments (tenant_id, author_id, body, source_type, source_id, created_at)
        values (${tenantId}, ${adminId}, ${`${MARK}коментар ${i}`}, 'course', ${sourceId}, ${at(second, i)}::text::timestamptz)`
    }
    expected = (await admin`
      select id from comments where tenant_id = ${tenantId} and body like ${`${MARK}%`}
       order by created_at desc, id desc`).map(r => r.id as string)
  })

  it.each(LIMITS)('обход страницами по %i: каждый комментарий ровно один раз', async (limit) => {
    const walked = await walk(limit, async (lim, cursor) => {
      const page = await listComments({ tenantId, actorId: adminId }, { limit: lim, ...(cursor ? { cursor } : {}) })
      return { ids: page.items.map(r => r.id), cursor: page.cursor }
    }, 400)
    expectExactlyOnce(walked, expected, limit)
  })
})

describe('журналы: курсор по (created_at, id) (docs/22 §13.4)', () => {
  const ctx = () => ({ tenantId, actorId: adminId })
  const expected = { security: [] as string[], notifications: [] as string[], taskStatus: [] as string[] }

  beforeAll(async () => {
    for (let i = 0; i < MICROS.length; i++) {
      await admin`
        insert into security_log (tenant_id, user_id, event, severity, created_at)
        values (${tenantId}, ${logUserId}, 'keyset.probe', 'info', ${at('2026-09-24T09:00:03', i)}::text::timestamptz)`
      await admin`
        insert into notifications (tenant_id, user_id, code, channel, created_at)
        values (${tenantId}, ${logUserId}, 'keyset_probe', 'telegram', ${at('2026-09-24T09:00:04', i)}::text::timestamptz)`
    }
    expected.security = (await admin`
      select id::text as id from security_log where tenant_id = ${tenantId} and event = 'keyset.probe'
       order by created_at desc, id::text desc`).map(r => r.id as string)
    expected.notifications = (await admin`
      select id::text as id from notifications where user_id = ${logUserId} and code = 'keyset_probe'
       order by created_at desc, id::text desc`).map(r => r.id as string)

    // Протокол статусов — объединение таблиц: чётные строки — события курса, нечётные — события
    // программы. Ничья `.123456` приходится на обе таблицы сразу, и порядок внутри неё решает
    // id из разных источников.
    const [course] = await admin`
      select c.id, v.id as version_id from courses c join course_versions v on v.course_id = c.id
       where c.tenant_id = ${tenantId} limit 1`
    const [enr] = await admin`
      insert into enrollments (tenant_id, user_id, subject_type, subject_id, version_id, source, status)
      values (${tenantId}, ${logUserId}, 'course', ${course!.id}, ${course!.version_id}, 'assignment', 'in_progress') returning id`
    for (let i = 0; i < MICROS.length; i++) {
      const moment = at('2026-09-24T09:00:05', i)
      if (i % 2 === 0) {
        await admin`
          insert into enrollment_events (tenant_id, enrollment_id, event, created_at)
          values (${tenantId}, ${enr!.id}, 'started', ${moment}::text::timestamptz)`
      }
      else {
        await admin`
          insert into pass_events (tenant_id, subject_type, subject_id, enrollment_id, user_id, event, created_at)
          values (${tenantId}, 'training_program', gen_random_uuid(), gen_random_uuid(), ${logUserId}, 'started', ${moment}::text::timestamptz)`
      }
    }
    expected.taskStatus = (await admin`
      select id from (
        select ev.id::text as id, ev.created_at from enrollment_events ev join enrollments e on e.id = ev.enrollment_id where e.user_id = ${logUserId}
        union all
        select pe.id::text, pe.created_at from pass_events pe where pe.user_id = ${logUserId}
      ) x order by created_at desc, id desc`).map(r => r.id as string)
  })

  it.each(LIMITS)('журнал безопасности (id — bigint) страницами по %i: каждая запись ровно один раз', async (limit) => {
    const walked = await walk(limit, async (lim, cursor) => {
      const page = await readLogPage(ctx(), 'security', { userId: logUserId, type: 'keyset.', limit: lim, ...(cursor ? { cursor } : {}) })
      expect(page.rows.every(r => !('cursor_at' in r)), 'служебная колонка курсора попала в строки журнала').toBe(true)
      return { ids: page.rows.map(r => String(r.id)), cursor: page.cursor }
    })
    expectExactlyOnce(walked, expected.security, limit)
  })

  it.each(LIMITS)('уведомления (id — uuid) страницами по %i: каждая запись ровно один раз', async (limit) => {
    const walked = await walk(limit, async (lim, cursor) => {
      const page = await readLogPage(ctx(), 'notifications', { userId: logUserId, type: 'keyset_probe', limit: lim, ...(cursor ? { cursor } : {}) })
      return { ids: page.rows.map(r => String(r.id)), cursor: page.cursor }
    })
    expectExactlyOnce(walked, expected.notifications, limit)
  })

  it.each(LIMITS)('протокол статусов (две таблицы в один момент) страницами по %i: каждая запись ровно один раз', async (limit) => {
    expect(expected.taskStatus).toHaveLength(MICROS.length)
    const walked = await walk(limit, async (lim, cursor) => {
      const page = await readLogPage(ctx(), 'task-status', { userId: logUserId, limit: lim, ...(cursor ? { cursor } : {}) })
      return { ids: page.rows.map(r => String(r.id)), cursor: page.cursor }
    })
    expectExactlyOnce(walked, expected.taskStatus, limit)
  })
})
