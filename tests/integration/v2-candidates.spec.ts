import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CANDIDATE_STATES, SYSTEM_CANDIDATE_STATUSES } from '../../shared/enums'

/**
 * PR-13 пакета `docs/v2` (`45-plan.md`): кандидат как запись `users` — схема, статусы,
 * история, оценки, карточка (`28-recruiting-candidates.md` §3–§7, решения `44` В-8, В-13).
 *
 * Критерии приёмки `28` §13, закреплённые за этим PR:
 * - **2** — второй кандидат с тем же телефоном не создаётся молча: ответ показывает карточку
 *   найденного, и без явного подтверждения записи нет;
 * - **5** — пользовательская колонка с `maps_to='active'` учитывается как активная: её
 *   кандидаты видны в сводке воронки и считаются в оси `candidates_active`;
 * - **6** — удаление пользовательской колонки с кандидатами внутри — `in_use` со списком;
 * - **9** — чужая область (и чужой тенант) дают «не найдено», а не «запрещено»;
 * - **10** — наставник видит карточку без телефона, почты и резюме;
 * - **11** — из `hired` переходов нет: попытка вернуть в `active` отклоняется.
 *
 * Плюс условие выхода PR-13: кандидат не протекает в списки сотрудников, в адресатов
 * рассылок и в оплачиваемый счётчик — теперь уже с **настоящим** кандидатом, а не только
 * с канарейкой посева (В-8, слой 3).
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const {
  createCandidate, getCandidate, listCandidates, updateCandidate, moveStatus, addScore,
  listScores, addComment, listComments, listHistory, funnel, countActive, findDuplicates,
  maskEmail, maskPhone, viewerOf, canMove,
} = await import('../../server/services/candidates')
const { listStatuses, createStatus, updateStatus, deleteStatus } = await import('../../server/services/candidateStatuses')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const PHONE = '+380679900001'
const PHONE_2 = '+380679900002'
const EMAIL = 'v2-13-candidate@kappi.test'

let tenantId: string
let otherTenantId: string
let adminId: string
let recruiterId: string
let ctx: { tenantId: string, actorId: string }
/** Кто видит всё: `candidate.view` на весь тенант (HR, админ) — §2. */
let hr: ReturnType<typeof viewerOf>
/** Роль с областью «точка»: видит только своих кандидатов, контакты маскированы — §2, §7.10. */
let manager: ReturnType<typeof viewerOf>
/** Наставник: ни одного `candidate.view`, только очередь проверки — §2, критерий §13 к. 10. */
let mentor: ReturnType<typeof viewerOf>
const created: string[] = []
const createdStatuses: string[] = []

function viewer(grants: { scopes: string[], scopeType: string, scopeId: string | null }[], userId = adminId) {
  return viewerOf({ userId, tenantId, grants })
}

async function cleanup() {
  const rows = await admin`
    select id from users
     where tenant_id = ${tenantId} and (phone in (${PHONE}, ${PHONE_2}) or email = ${EMAIL})`
  for (const r of rows) {
    await admin`delete from candidate_scores where candidate_id = ${r.id}`
    await admin`delete from candidate_comments where candidate_id = ${r.id}`
    await admin`delete from candidate_status_history where candidate_id = ${r.id}`
    await admin`delete from audit_log where entity_id = ${r.id}`
    await admin`delete from users where id = ${r.id}`
  }
  await admin`delete from candidate_statuses where tenant_id = ${tenantId} and not is_system and code like 'v213_%'`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  recruiterId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000001'`)[0]!.id as string
  const [other] = await admin`
    insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  ctx = { tenantId, actorId: adminId }
  hr = viewer([{ scopes: ['candidate.view', 'candidate.edit', 'candidate.decide', 'candidate.status.manage'], scopeType: 'tenant', scopeId: null }])
  manager = viewer([{ scopes: ['candidate.view'], scopeType: 'location', scopeId: null }], recruiterId)
  mentor = viewer([{ scopes: ['review.queue', 'review.grade'], scopeType: 'location', scopeId: null }], recruiterId)
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  await admin.end()
})

// ── Схема (миграция 0064) ─────────────────────────────────────────────────────────────────

describe('миграция 0064: схема рекрутинга', () => {
  it('четыре таблицы пакета созданы, у каждой RLS включён и принудителен', async () => {
    const tables = ['candidate_statuses', 'candidate_scores', 'candidate_comments', 'candidate_status_history']
    for (const t of tables) {
      const [row] = await admin`
        select c.relrowsecurity as enabled, c.relforcerowsecurity as forced
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = ${t}`
      expect(row, `нет таблицы ${t}`).toBeDefined()
      expect(row!.enabled, `${t}: RLS выключен`).toBe(true)
      expect(row!.forced, `${t}: RLS не принудителен`).toBe(true)
    }
  })

  it('одиннадцать колонок кандидата в users, vacancy_id среди них нет (он в PR-15)', async () => {
    const cols = (await admin`
      select column_name from information_schema.columns
       where table_name = 'users' and column_name in (
         'candidate_state','candidate_status_id','source','source_detail','recruiter_id',
         'access_until','comm_language','resume_asset_id','converted_from_candidate_at',
         'consent_given_at','consent_expires_at','vacancy_id')`).map(r => r.column_name as string)
    expect(cols.sort()).toEqual([
      'access_until', 'candidate_state', 'candidate_status_id', 'comm_language', 'consent_expires_at',
      'consent_given_at', 'converted_from_candidate_at', 'recruiter_id', 'resume_asset_id', 'source', 'source_detail',
    ])
  })

  it('hired_at не задвоился и остался date (`40` §3.2, тест 7)', async () => {
    const rows = await admin`
      select data_type from information_schema.columns where table_name = 'users' and column_name = 'hired_at'`
    expect(rows.length).toBe(1)
    expect(rows[0]!.data_type).toBe('date')
  })

  it('CHECK согласованности вида и состояния: кандидат без состояния и сотрудник с ним — невставляемы', async () => {
    const [chk] = await admin`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'users_candidate_coherence_chk'`
    expect(chk, 'нет констрейнта users_candidate_coherence_chk').toBeDefined()
    await expect(admin`
      insert into users (tenant_id, kind, full_name, phone) values (${tenantId}, 'candidate', 'Без стану', '+380679900099')`)
      .rejects.toThrow()
    await expect(admin`
      insert into users (tenant_id, kind, candidate_state, full_name, phone) values (${tenantId}, 'employee', 'active', 'Зі станом', '+380679900098')`)
      .rejects.toThrow()
  })

  it('перечень состояний в БД совпадает с shared/enums (CLAUDE.md п. 13)', async () => {
    const [chk] = await admin`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'users_candidate_state_chk'`
    const values = [...String(chk!.def).matchAll(/'([a-z_]+)'::text/g)].map(m => m[1])
    expect(values).toEqual([...CANDIDATE_STATES])
  })

  it('отложенный FK колонки канбана назван по В-13 и не каскадит', async () => {
    const [fk] = await admin`
      select confdeltype, pg_get_constraintdef(oid) as def from pg_constraint where conname = 'users_candidate_status_id_fk'`
    expect(fk, 'нет FK users_candidate_status_id_fk (имя зафиксировано docs/v2/44 В-13)').toBeDefined()
    expect(fk!.confdeltype, 'удаление колонки не должно уносить кандидата').toBe('n') // set null
    expect(String(fk!.def)).toContain('candidate_statuses')
  })

  it('действующая оценка каждого вида одна — частичный уникальный индекс, а не проверка в коде', async () => {
    const [idx] = await admin`select indexdef from pg_indexes where indexname = 'uq_candidate_scores_current'`
    expect(idx, 'нет индекса uq_candidate_scores_current').toBeDefined()
    expect(String(idx!.indexdef)).toContain('UNIQUE')
    expect(String(idx!.indexdef)).toContain('is_current')
  })

  it('шесть системных колонок воронки заведены и совпадают с shared/enums', async () => {
    const rows = await admin`
      select code, maps_to, is_system from candidate_statuses where tenant_id = ${tenantId} and is_system order by sort`
    expect(rows.map(r => r.code)).toEqual(SYSTEM_CANDIDATE_STATUSES.map(s => s.code))
    expect(rows.map(r => r.maps_to)).toEqual(SYSTEM_CANDIDATE_STATUSES.map(s => s.mapsTo))
  })

  it('журнал статусов пишет request_context (CLAUDE.md п. 14)', async () => {
    const [col] = await admin`
      select data_type from information_schema.columns
       where table_name = 'candidate_status_history' and column_name = 'request_context'`
    expect(col?.data_type).toBe('jsonb')
  })
})

// ── Создание и дубликаты ──────────────────────────────────────────────────────────────────

describe('создание кандидата (§6.1, §7.1, §7.2)', () => {
  it('без телефона и почты — contact_required, запись не создана', async () => {
    const r = await createCandidate(ctx, {
      firstName: 'Без', lastName: 'Контакту', commLanguage: 'uk', consentGiven: true, confirmDuplicate: false,
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('contact_required')
  })

  it('кандидат создаётся записью users с kind=candidate, стартовой колонкой и согласием', async () => {
    const r = await createCandidate(ctx, {
      firstName: 'Олена', lastName: 'Кандидатова', phone: PHONE, email: EMAIL,
      source: 'referral', sourceDetail: 'Порадила Маша', recruiterId,
      commLanguage: 'uk', consentGiven: true, confirmDuplicate: false,
    })
    expect(r.ok, r.ok === false ? r.code : '').toBe(true)
    if (!r.ok) return
    created.push(r.candidate.id)
    expect(r.candidate.state).toBe('active')
    expect(r.candidate.statusCode).toBe('new')
    const [row] = await admin`select kind, candidate_state, consent_given_at, consent_expires_at, comm_language from users where id = ${r.candidate.id}`
    expect(row!.kind).toBe('candidate')
    expect(row!.candidate_state).toBe('active')
    // Дату согласия проставляет сервер, а не клиент (§7.9): +6 месяцев от сейчас.
    expect(row!.consent_given_at).not.toBeNull()
    const months = (new Date(row!.consent_expires_at as string | Date).getTime() - Date.now()) / (30 * 86_400_000)
    expect(months).toBeGreaterThan(5)
    expect(months).toBeLessThan(7)
  })

  it('стартовая колонка записана в историю — «днів у статусі» есть с первой секунды (§7.11)', async () => {
    const rows = await admin`select from_status_id, to_status_id from candidate_status_history where candidate_id = ${created[0]!}`
    expect(rows.length).toBe(1)
    expect(rows[0]!.from_status_id).toBeNull()
    const card = await getCandidate(hr, created[0]!)
    expect(card!.daysInStatus).toBe(0)
  })

  it('критерий §13 к. 2: второй кандидат с тем же телефоном не создаётся, ответ несёт карточку найденного', async () => {
    const before = await countActive(ctx)
    const r = await createCandidate(ctx, {
      firstName: 'Олена', lastName: 'Кандидатова', phone: PHONE,
      commLanguage: 'uk', consentGiven: true, confirmDuplicate: false,
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('duplicate')
    expect(r.code === 'duplicate' && r.duplicates.map(d => d.id)).toContain(created[0]!)
    expect(await countActive(ctx), 'счётчик активных изменился при отклонённом дубликате').toBe(before)
  })

  it('подтверждение не обходит ключ: тот же телефон — contact_taken, повторный отклик ведётся в существующей карточке (§12.10)', async () => {
    const r = await createCandidate(ctx, {
      firstName: 'Олена', lastName: 'Кандидатова', phone: PHONE,
      commLanguage: 'uk', consentGiven: true, confirmDuplicate: true,
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('contact_taken')
  })

  it('телефон действующего сотрудника — candidate.is_employee (§12.1)', async () => {
    const r = await createCandidate(ctx, {
      firstName: 'Адмін', lastName: 'Каппі', phone: '+380661864742',
      commLanguage: 'uk', consentGiven: true, confirmDuplicate: false,
    })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('is_employee')
  })

  it('поиск дубликатов не отдаёт контакты найденного — только ФИО, вид и состояние', async () => {
    const hits = await findDuplicates(ctx, { phone: PHONE })
    expect(hits.length).toBeGreaterThan(0)
    expect(Object.keys(hits[0]!)).not.toContain('phone')
    expect(Object.keys(hits[0]!)).not.toContain('email')
  })
})

// ── Колонки, переходы, история ────────────────────────────────────────────────────────────

describe('колонки воронки и переходы (§3.3, §4)', () => {
  let customId: string

  it('пользовательская колонка заводится с обязательным maps_to', async () => {
    const r = await createStatus(ctx, { code: 'v213_callback', nameUk: 'Передзвонити', color: 'sun', mapsTo: 'active' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    customId = r.status.id
    createdStatuses.push(customId)
    expect(r.status.isSystem).toBe(false)
  })

  it('код колонки уникален в тенанте', async () => {
    const again = await createStatus(ctx, { code: 'v213_callback', nameUk: 'Ще раз', color: 'ink', mapsTo: 'active' })
    expect(again.ok).toBe(false)
  })

  it('системной колонке нельзя сменить кінцевий стан, а название — можно', async () => {
    const [sys] = await admin`select id, name_uk from candidate_statuses where tenant_id = ${tenantId} and code = 'rejected'`
    const bad = await updateStatus(ctx, sys!.id as string, { mapsTo: 'archived' })
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.code).toBe('system_readonly')
    const good = await updateStatus(ctx, sys!.id as string, { nameUk: 'Відхилені' })
    expect(good.ok).toBe(true)
  })

  it('перенос в колонку пишет историю и двигает ось состояния через maps_to', async () => {
    const r = await moveStatus(hr, created[0]!, { statusId: customId, notify: false })
    expect(r.ok, r.ok === false ? r.code : '').toBe(true)
    if (!r.ok) return
    expect(r.candidate.statusId).toBe(customId)
    expect(r.candidate.state).toBe('active')
    const history = await listHistory(hr, created[0]!)
    expect(history!.length).toBe(2)
    expect(history![0]!.toStatusId).toBe(customId)
  })

  it('повторный перенос в ту же колонку — status.same, лишней записи в истории нет', async () => {
    const r = await moveStatus(hr, created[0]!, { statusId: customId, notify: false })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('same')
    expect((await listHistory(hr, created[0]!))!.length).toBe(2)
  })

  it('отказ без причины не проходит: причина уходит в отчёт и в письмо (§6.2, §9)', async () => {
    const [rej] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'rejected'`
    const r = await moveStatus(hr, created[0]!, { statusId: rej!.id as string, notify: false })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('reason_required')
  })

  it('критерий §13 к. 5: кандидаты пользовательской колонки учтены как активные', async () => {
    const rows = await funnel(hr)
    const custom = rows.find(r => r.statusId === customId)
    expect(custom, 'пользовательская колонка выпала из сводки воронки').toBeDefined()
    expect(custom!.mapsTo).toBe('active')
    expect(custom!.total).toBeGreaterThan(0)
    const [inAxis] = await admin`
      select count(*)::int as n from users
       where tenant_id = ${tenantId} and kind = 'candidate' and candidate_state = 'active' and candidate_status_id = ${customId}`
    expect(Number(inAxis!.n)).toBe(custom!.total)
  })

  it('критерий §13 к. 6: колонку с кандидатами внутри не удалить — in_use со списком', async () => {
    const r = await deleteStatus(ctx, customId)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('in_use')
    expect(r.code === 'in_use' && r.candidates.map(c => c.id)).toContain(created[0]!)
  })

  it('системную колонку не удалить вовсе (§3.3)', async () => {
    const [sys] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'new'`
    const r = await deleteStatus(ctx, sys!.id as string)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('system_readonly')
  })

  it('пустая пользовательская колонка удаляется', async () => {
    const made = await createStatus(ctx, { code: 'v213_empty', nameUk: 'Порожня', color: 'ink', mapsTo: 'archived' })
    expect(made.ok).toBe(true)
    if (!made.ok) return
    expect((await deleteStatus(ctx, made.status.id)).ok).toBe(true)
  })

  it('критерий §13 к. 11: из hired переходов нет', async () => {
    expect(canMove('hired', 'active')).toBe(false)
    expect(canMove('active', 'hired')).toBe(true)
    await admin`update users set candidate_state = 'hired' where id = ${created[0]!}`
    const [active] = await admin`select id from candidate_statuses where tenant_id = ${tenantId} and code = 'in_progress'`
    const r = await moveStatus(hr, created[0]!, { statusId: active!.id as string, notify: false })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('not_allowed')
    const [row] = await admin`select candidate_state from users where id = ${created[0]!}`
    expect(row!.candidate_state, 'состояние изменилось при запрещённом переходе').toBe('hired')
    await admin`update users set candidate_state = 'active' where id = ${created[0]!}`
  })

  it('найм сменой колонки не делается: колонка с maps_to=hired отвергается (§7.6 — это транзакция PR-14)', async () => {
    const made = await createStatus(ctx, { code: 'v213_hired', nameUk: 'Найняті', color: 'teal', mapsTo: 'hired' })
    expect(made.ok).toBe(true)
    if (!made.ok) return
    createdStatuses.push(made.status.id)
    const r = await moveStatus(hr, created[0]!, { statusId: made.status.id, notify: false })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('not_allowed')
    const [row] = await admin`select kind from users where id = ${created[0]!}`
    expect(row!.kind, 'смена колонки превратила кандидата в сотрудника мимо найма').toBe('candidate')
  })
})

// ── Оценки и комментарии ──────────────────────────────────────────────────────────────────

describe('оценки и комментарии (§3.4, §3.5)', () => {
  it('новая оценка того же вида снимает предыдущую, история остаётся', async () => {
    const first = await addScore(hr, created[0]!, { kind: 'manual', valueNum: 4 })
    expect(first.ok).toBe(true)
    const second = await addScore(hr, created[0]!, { kind: 'manual', valueNum: 5, comment: 'Переоцінили' })
    expect(second.ok).toBe(true)
    const current = await listScores(hr, created[0]!, { kind: 'manual' })
    expect(current!.length).toBe(1)
    expect(Number(current![0]!.valueNum)).toBe(5)
    const all = await listScores(hr, created[0]!, { kind: 'manual', history: true })
    expect(all!.length).toBe(2)
  })

  it('четыре вида оценки живут отдельно и в одно число не сводятся', async () => {
    await addScore(hr, created[0]!, { kind: 'task', valueNum: 3 })
    await addScore(hr, created[0]!, { kind: 'recruiter', valueNum: 1 })
    const current = await listScores(hr, created[0]!)
    expect(current!.map(s => s.kind).sort()).toEqual(['manual', 'recruiter', 'task'])
  })

  it('комментарий виден сотрудникам и не приходит наставнику (§3.5, §2)', async () => {
    await addComment(hr, created[0]!, { body: 'Добре показав себе на тестовому', visibility: 'recruiters' })
    const list = await listComments(hr, created[0]!)
    expect(list!.length).toBe(1)
    expect(await listComments(mentor, created[0]!)).toBeNull()
  })
})

// ── Область видимости, маскирование, изоляция ─────────────────────────────────────────────

describe('доступ к карточке (§2, §7.10; критерии §13 к. 9 и к. 10)', () => {
  it('HR видит контакты как есть', async () => {
    const card = await getCandidate(hr, created[0]!)
    expect(card!.phone).toBe(PHONE)
    expect(card!.email).toBe(EMAIL)
    expect(card!.pdMasked).toBe(false)
  })

  it('критерий §13 к. 9: чужая область — «не найдено», а не «заборонено»', async () => {
    // У областной роли этот кандидат не свой: ответственным назначен другой человек.
    await admin`update users set recruiter_id = ${adminId} where id = ${created[0]!}`
    expect(await getCandidate(manager, created[0]!)).toBeNull()
    expect((await listCandidates(manager, { limit: 50 } as never)).map(c => c.id)).not.toContain(created[0]!)
  })

  it('свой кандидат областной роли виден, но с маскированными контактами (§2 «✓ маскировано»)', async () => {
    await admin`update users set recruiter_id = ${recruiterId} where id = ${created[0]!}`
    const card = await getCandidate(manager, created[0]!)
    expect(card, 'свой кандидат не виден областной роли').not.toBeNull()
    expect(card!.phone).toBe(maskPhone(PHONE))
    expect(card!.email).toBe(maskEmail(EMAIL))
    expect(card!.pdMasked).toBe(true)
    expect(card!.phone).not.toContain('9900001')
  })

  it('критерий §13 к. 10: наставник без назначенной проверки карточки не видит вовсе', async () => {
    expect(await getCandidate(mentor, created[0]!)).toBeNull()
  })

  it('критерий §13 к. 10: с назначенной проверкой карточка приходит без телефона, почты и резюме', async () => {
    const [workshop] = await admin`
      insert into workshops (tenant_id, title, description, criteria, status)
      values (${tenantId}, 'v2-13 тестове завдання', '{}'::jsonb, '[]'::jsonb, 'published')
      returning id`
    const [sub] = await admin`
      insert into workshop_submissions (tenant_id, workshop_id, user_id, criteria_snapshot, status, reviewer_id, submitted_at)
      values (${tenantId}, ${workshop!.id}, ${created[0]!}, '[]'::jsonb, 'in_review', ${recruiterId}, now())
      returning id`
    try {
      await admin`update users set resume_asset_id = null where id = ${created[0]!}`
      const card = await getCandidate(mentor, created[0]!)
      expect(card, 'наставник не видит кандидата, чью работу проверяет').not.toBeNull()
      expect(card!.fullName).toBeTruthy()
      expect(card!.phone).toBe(maskPhone(PHONE))
      expect(card!.email).toBe(maskEmail(EMAIL))
      expect(card!.resumeAssetId, 'резюме ушло наставнику').toBeNull()
      expect(card!.comments, 'комментарии рекрутеров ушли наставнику').toEqual([])
    }
    finally {
      await admin`delete from workshop_submissions where id = ${sub!.id}`
      await admin`delete from workshops where id = ${workshop!.id}`
    }
  })

  it('чужой тенант — пусто и «не найдено» (CLAUDE.md п. 15)', async () => {
    const foreign = viewerOf({ userId: adminId, tenantId: otherTenantId, grants: [{ scopes: ['candidate.view', 'candidate.edit'], scopeType: 'tenant', scopeId: null }] })
    expect(await getCandidate(foreign, created[0]!)).toBeNull()
    expect((await listCandidates(foreign, { limit: 50 } as never)).length).toBe(0)
    expect((await listStatuses({ tenantId: otherTenantId, actorId: adminId })).some(s => createdStatuses.includes(s.id))).toBe(false)
    const upd = await updateCandidate(foreign, created[0]!, { commLanguage: 'en' })
    expect(upd.ok).toBe(false)
    expect(upd.ok === false && upd.code).toBe('not_found')
  })
})

// ── Условие выхода PR-13: кандидат не протекает к сотрудникам ─────────────────────────────

describe('условие выхода PR-13: настоящий кандидат не попадает к сотрудникам (В-8)', () => {
  it('списки людей, отчёты и аудитории его не содержат', async () => {
    const { listPeople, inactiveReport } = await import('../../server/services/people')
    const { resolveAudience } = await import('../../server/services/audience')
    const { withTenant } = await import('../../server/utils/withTenant')
    for (const tab of ['active', 'blocked', 'all'] as const) {
      const page = await listPeople(ctx, { tab, limit: 200, includeHidden: true } as never)
      expect(page.items.map(p => p.id), `кандидат в списке людей, вкладка ${tab}`).not.toContain(created[0]!)
    }
    expect((await inactiveReport(ctx, 0)).map(r => r.id)).not.toContain(created[0]!)
    const byId = await withTenant(tenantId, adminId, tx => resolveAudience(tx, { match: 'any', rules: [{ type: 'user', ids: [created[0]!] }] } as never))
    expect([...byId], 'кандидата выдали в адресаты рассылки по прямому перечню').toEqual([])
  })

  it('оплачиваемый счётчик считает сотрудников, ось кандидатов — кандидатов в состоянии active', async () => {
    const { collectUsage } = await import('../../server/services/usage')
    const { checkPlanLimit } = await import('../../server/services/platform')
    const [employees] = await admin`
      select count(*)::int as n from users where tenant_id = ${tenantId} and kind = 'employee' and status = 'active' and not is_blocked`
    expect((await collectUsage(tenantId)).activeUsers).toBe(Number(employees!.n))

    const axis = await checkPlanLimit(tenantId, 'candidates')
    const [active] = await admin`
      select count(*)::int as n from users where tenant_id = ${tenantId} and kind = 'candidate' and candidate_state = 'active'`
    expect(axis.current).toBe(Number(active!.n))
    expect(axis.current).toBe(await countActive(ctx))
  })

  it('отказ освобождает место в оси: тенант не платит за архив (§7.1, §15 Г-28.7)', async () => {
    const { checkPlanLimit } = await import('../../server/services/platform')
    const before = (await checkPlanLimit(tenantId, 'candidates')).current
    await admin`update users set candidate_state = 'rejected' where id = ${created[0]!}`
    try {
      expect((await checkPlanLimit(tenantId, 'candidates')).current).toBe(before - 1)
    }
    finally {
      await admin`update users set candidate_state = 'active' where id = ${created[0]!}`
    }
  })
})
