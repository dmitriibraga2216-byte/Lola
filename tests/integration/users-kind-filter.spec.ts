import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Слой 2 патча П-16.1 (docs/v2/39-patches.md; решение docs/v2/44-decisions.md В-8) —
 * сканер исходников, и слой 3 — канареечный кандидат в посеве.
 *
 * Зачем сканер. Кандидат и сотрудник — одна запись `users` с разным `kind`. Забытый фильтр
 * не падает, а молча возвращает кандидатов в списки сотрудников, в адресаты рассылок и
 * в оплачиваемый счётчик (docs/v2/42-stages-delta.md §7.1 — главный риск всего пакета).
 * ESLint-правило отвергнуто (В-8, вариант B): оно видит Drizzle и не видит сырой SQL, где
 * как раз живут счётчик биллинга и платформенные отчёты. Представления отвергнуты (вариант D):
 * они ломают `drizzle-kit generate`, `rls.spec.ts`, `schema-parity.spec.ts` и рискуют обойти RLS.
 *
 * Как читать отказ теста. Сканер нашёл выборку из `users`, про которую нельзя сказать, какой
 * вид людей она возвращает. Варианты действий, в порядке предпочтения:
 *   1. если это список людей — пропустить его через `server/services/repo/people.ts`
 *      (`employees()`, `employeeOnly()`, `EMPLOYEES_ONLY()`, `candidates()`, …);
 *   2. если фильтр по виду тут бессмыслен или вреден — добавить строку в ALLOWLIST ниже
 *      **с комментарием, почему**. Allowlist — не список исключений, а список осознанных
 *      решений: строка без объяснения не принимается ревьюером (В-8).
 */

const ROOT = resolve(__dirname, '../..')
const REPO_FILE = 'server/services/repo/people.ts'

/** Что считается обращением к таблице людей: Drizzle и сырой SQL одинаково. */
const HIT = /\.from\((?:\w+\.)?users\)|Join\((?:\w+\.)?users\b|\bfrom\s+users\b|\bjoin\s+users\b/i

/** Соединение с таблицей людей — у него свои правила: см. LEFT_JOIN и BY_PRIMARY_KEY. */
const IS_JOIN = /Join\((?:\w+\.)?users\b|\bjoin\s+users\b/i

/**
 * Признак того, что вид людей в выборке назван явно. Кроме прямых упоминаний `kind` —
 * имена из репозитория и `frameWhere()`: единый каркас отчётов (server/services/reportFrame.ts)
 * подставляет `EMPLOYEES_ONLY('u')` сам, одной точкой на все отчёты и журналы, — поэтому
 * запрос, который зовёт `frameWhere()`, отфильтрован по построению.
 */
const FILTERED = /EMPLOYEES_ONLY|CANDIDATES_ONLY|IS_EMPLOYEE|IS_CANDIDATE|employeeOnly|candidateOnly|\bemployees\(|\bcandidates\(|frameWhere\(|users\.kind|\b[a-z_]+\.kind\s*=|\bkind\s*=\s*'(?:employee|candidate)'/

/**
 * Выборка одного человека (или заранее известного набора) по первичному ключу. Фильтровать
 * её по виду бессмысленно: идентификатор уже пришёл из другой таблицы или из запроса,
 * и карточка, ФИО в журнале и проверка прав работают одинаково для обоих видов (В-8).
 */
const BY_PRIMARY_KEY = /eq\(users\.id,|inArray\(users\.id,|\$\{users\.id\}\s+in/

/**
 * То же для сырого SQL: выборка ограничена идентификатором-параметром (`where u.id = ${…}`,
 * `where up.user_id = ${…}`). Для соединений применимо только это правило — `eq(users.id, …)`
 * в Drizzle-джойне означает условие соединения, а не выборку одного человека.
 */
const BY_PARAM_ID = /\b[\w.]*\bid\s*(?:=|in)\s*\(?\$\{/i

/**
 * Соединение по первичному ключу людей: `join users u on u.id = <чужая колонка>`,
 * `innerJoin(users, eq(users.id, x.userId))`. Ведущая таблица здесь не `users`: набор людей
 * задаёт она (записи на курс, реєстрації, коментарі), а соединение только дописывает ФИО.
 * Именно это В-8 называет «join ради ФИО» и выводит из-под фильтра: обогащение именем
 * корректно для обоих видов людей, а фильтровать по виду нужно **ведущую** выборку.
 * Слепое пятно правила закрыто слоем 3 (канареечный кандидат) и тем, что единый каркас
 * отчётов (`frameWhere()`) фильтрует людей сам.
 */
const JOIN_BY_PK = /Join\((?:\w+\.)?users,\s*eq\(users\.id,|\bjoin\s+users\s+(\w+)\s+on\s+\1\.id\s*=/i

/**
 * Внешнее соединение с людьми: `left join users` не может добавить в ответ ни одного человека,
 * оно только дописывает ФИО к строкам ведущей таблицы. Обогащение именем корректно и для
 * кандидата, и для сотрудника — В-8 прямо выводит такие места из-под фильтра.
 */
const LEFT_JOIN = /leftJoin\(users\b|\bleft\s+join\s+users\b/i

/**
 * Поимённый allowlist: `путь:строка` → почему выборка законна без фильтра по виду.
 * Ровно то, чего требует docs/v2/40-data-model-delta.md §9 Р-9 — перечень, а не общее правило.
 */
const ALLOWLIST: Record<string, string> = {
  // ── Контур аутентификации ────────────────────────────────────────────────────────────────
  // Вход ищет человека по учётным данным, а не показывает список людей. Фильтр по виду здесь
  // означал бы «кандидату нельзя войти», а это решение принимает доступ (docs/v2/28 §6,
  // флаг tenants.candidates_enabled и access_until), а не запрос на чтение: иначе кандидат
  // с выданным доступом молча получал бы «неверный логин» вместо понятного отказа.
  // completeSignin() — общая для обоих колбеков Google (собственного и пути интеграций)
  'server/services/session.ts:151':
    'вход через Google: поиск человека по e-mail учётной записи, а не список людей — право входа решает контур доступа',
  'server/services/googleApps.ts:81':
    'сопоставление участников встречи Google Calendar с людьми тенанта по e-mail — поиск по ключу, не список',
  'server/services/googleApps.ts:176':
    'то же сопоставление по e-mail для второй точки синхронизации календаря — поиск по ключу, не список',

  // ── Идемпотентный импорт людей ───────────────────────────────────────────────────────────
  // Ограничения unique (tenant_id, phone) и unique (tenant_id, external_id) общие для обоих
  // видов людей. Импорт сверяется с ними, чтобы не создать дубль; отфильтруй он кандидатов —
  // строка с телефоном кандидата прошла бы проверку и упала на вставке нарушением unique.
  // Это ровно тот случай, когда фильтр по виду делает код неверным, а не безопасным.
  'server/services/importPeople.ts:179':
    'сверка телефонов со всеми людьми тенанта: unique (tenant_id, phone) не различает вид, фильтр породил бы дубль',
  'server/services/importPeople.ts:180':
    'сверка «зовнішніх №» со всеми людьми: unique (tenant_id, external_id) не различает вид',
  'server/services/importPeople.ts:614':
    'поиск людей по «зовнішньому №» для простановки руководителя размещения — сопоставление по ключу импорта',
  'server/services/importPeople.ts:615':
    'то же по телефону: ключ импорта, а не список людей',
  // Строка сдвинулась 633 → 634: PR crosschecks-markers добавил метку v2-allow: check9 строкой
  // выше в этом же файле (запись user_placements.manager_id из импорта, см. scripts/v2-crosschecks.sh).
  'server/services/importPeople.ts:634':
    'поиск строки импорта по «зовнішньому №» ради записи конфликта оргструктуры — один человек по ключу',

  // ── Справочник ФИО ───────────────────────────────────────────────────────────────────────
  // Номер сдвинулся с 81 на 82 в PR-30: `managerOf()` стал звать `resolveManager()`, и в шапку
  // файла добавился один импорт. Сама строка не менялась.
  'server/services/requests.ts:82':
    'словарь id → ПІБ для колонки «Відповідальний» в таблице заявок: обогащение именем, корректное для обоих видов людей',

  // ── Поиск того же человека перед созданием кандидата (PR-13) ─────────────────────────────
  // Единственное место, где выборка по людям обязана быть межвидовой. docs/v2/28 §7.2 требует
  // искать совпадение «среди всех users тенанта», а §12.1 — отвечать candidate.is_employee,
  // если телефон принадлежит действующему сотруднику. Фильтр по виду сделал бы проверку
  // не безопасной, а неверной: unique (tenant_id, phone) один на кандидатов и сотрудников,
  // и отфильтрованный дубль прошёл бы валидацию и упал на вставке нарушением ключа.
  'server/services/candidates.ts:398':
    'поиск дубликата перед созданием кандидата: ключ (tenant_id, phone/email) общий для обоих видов, §7.2 и §12.1 требуют межвидовой сверки',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const OPEN = /[([{]/g
const CLOSE = /[)\]}]/g
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

/**
 * «В пределах выражения» (В-8) — что это значит технически. Для запроса в шаблонной строке
 * выражение — весь шаблон (фильтр стоит строкой ниже `from users u`); для цепочки Drizzle —
 * строки, связанные незакрытыми скобками и точками (`.from(users).where(…)` может быть разбит
 * переносами). Обе границы расширяются не дальше 40 строк.
 */
function expressionAt(lines: string[], i: number): string {
  const ticksBefore = lines.slice(0, i).join('\n').split('`').length - 1
  let s = i
  let e = i
  if (ticksBefore % 2 === 1) {
    // Строка внутри шаблона: выражение — весь шаблон целиком.
    while (s > 0 && !lines[s]!.includes('`') && i - s < 40) s--
    while (e < lines.length - 1 && !lines[e]!.includes('`') && e - i < 40) e++
    if (s > 0) s--
  }
  else {
    let bal = count(lines[i]!, OPEN) - count(lines[i]!, CLOSE)
    while (s > 0 && bal < 0 && i - s < 40) { s--; bal += count(lines[s]!, OPEN) - count(lines[s]!, CLOSE) }
    while (e < lines.length - 1 && bal > 0 && e - i < 40) { e++; bal += count(lines[e]!, OPEN) - count(lines[e]!, CLOSE) }
  }
  // Цепочка вызовов и тернарник разорваны переносом строки — дочитываем их с обеих сторон.
  while (s > 0 && /^\s*[.?:]|[([,=]$|\bsql`$/.test(lines[s - 1]!) && i - s < 40) s--
  while (e < lines.length - 1 && /^\s*[.?:)]/.test(lines[e + 1]!) && e - i < 40) e++
  return lines.slice(s, e + 1).join('\n')
}

interface Hit { key: string, file: string, line: number, text: string, expr: string }

function scan(): Hit[] {
  const hits: Hit[] = []
  for (const file of walk(join(ROOT, 'server'))) {
    const rel = relative(ROOT, file)
    if (rel === REPO_FILE) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, idx) => {
      if (!HIT.test(text)) return
      if (/^\s*(\/\/|\*)/.test(text)) return // комментарий, а не запрос
      hits.push({ key: `${rel}:${idx + 1}`, file: rel, line: idx + 1, text: text.trim(), expr: expressionAt(lines, idx) })
    })
  }
  return hits
}

describe('слой 2: сканер выборок из users (П-16.1, В-8)', () => {
  const hits = scan()

  it('сканер видит обращения к users — иначе он проходит по построению', () => {
    expect(hits.length).toBeGreaterThan(100)
  })

  it('каждая списочная выборка людей называет вид явно или объяснена в allowlist', () => {
    const bad = hits
      .filter(h => !FILTERED.test(h.expr) && !LEFT_JOIN.test(h.text) && !BY_PARAM_ID.test(h.expr) && !JOIN_BY_PK.test(h.text)
        && !(!IS_JOIN.test(h.text) && BY_PRIMARY_KEY.test(h.expr)) && !(h.key in ALLOWLIST))
      .map(h => `${h.key}: ${h.text}`)
    expect(bad, `выборка людей без явного вида (см. шапку файла):\n${bad.join('\n')}`).toEqual([])
  })

  it('в allowlist нет строк без объяснения и нет протухших строк', () => {
    const empty = Object.entries(ALLOWLIST).filter(([, why]) => why.trim().length < 20).map(([k]) => k)
    expect(empty, `строка allowlist без объяснения: ${empty.join(', ')}`).toEqual([])
    const keys = new Set(hits.map(h => h.key))
    const stale = Object.keys(ALLOWLIST).filter(k => !keys.has(k))
    expect(stale, `allowlist указывает на строки, где обращения к users больше нет: ${stale.join(', ')}`).toEqual([])
  })
})

const adminUrl = process.env.DATABASE_ADMIN_URL
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL должен быть задан (см. .env.example)')
const admin = postgres(adminUrl, { max: 2, onnotice: () => {} })

afterAll(async () => {
  await admin.end()
})

describe('миграция 0056: users.kind и tenants.candidates_enabled', () => {
  it('колонка kind есть, not null, по умолчанию employee', async () => {
    const [col] = await admin`
      select is_nullable, column_default from information_schema.columns
      where table_name = 'users' and column_name = 'kind'`
    expect(col, 'нет колонки users.kind').toBeDefined()
    expect(col!.is_nullable).toBe('NO')
    expect(String(col!.column_default)).toContain('employee')
  })

  it('CHECK users_kind_chk разрешает ровно employee и candidate', async () => {
    const [chk] = await admin`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'users_kind_chk'`
    expect(chk, 'нет констрейнта users_kind_chk').toBeDefined()
    const values = [...String(chk!.def).matchAll(/'([a-z_]+)'::text/g)].map(m => m[1])
    expect(values).toEqual(['employee', 'candidate'])
  })

  it('частичный индекс (tenant_id, status) where kind = employee', async () => {
    const [idx] = await admin`select indexdef from pg_indexes where indexname = 'users_tenant_status_employee_idx'`
    expect(idx, 'нет индекса users_tenant_status_employee_idx').toBeDefined()
    expect(String(idx!.indexdef)).toContain('tenant_id, status')
    expect(String(idx!.indexdef)).toContain(`kind = 'employee'`)
  })

  /**
   * До PR-14 здесь проверялось «флаг выключен у всех тенантов» — условие выхода PR-04,
   * пока воронки не существовало и включать её было нечем. С PR-14 включение стало
   * **условием выхода**, а не нарушением (`docs/v2/45-plan.md` PR-14), и проверка сменила
   * смысл: рекрутинг выключен **по умолчанию** — у колонки `not null default false`, и
   * новый тенант получает выключенный флаг. Включённый у кого-то флаг с этого PR законен.
   */
  it('tenants.candidates_enabled выключен по умолчанию — рекрутинг включается решением тенанта', async () => {
    const [col] = await admin`
      select is_nullable, column_default from information_schema.columns
      where table_name = 'tenants' and column_name = 'candidates_enabled'`
    expect(col, 'нет колонки tenants.candidates_enabled').toBeDefined()
    expect(col!.is_nullable).toBe('NO')
    expect(String(col!.column_default)).toContain('false')
    const [fresh] = await admin`
      insert into tenants (slug, name) values ('kind-filter-default', 'Перевірка умовчання')
      on conflict (slug) do update set name = excluded.name
      returning candidates_enabled`
    expect(fresh!.candidates_enabled, 'новый тенант обязан заводиться с выключенным рекрутингом').toBe(false)
    await admin`delete from tenants where slug = 'kind-filter-default'`
  })

  it('существующие люди остались сотрудниками — миграция никого не превратила в кандидата', async () => {
    const [row] = await admin`select count(*)::int as n from users where kind not in ('employee', 'candidate')`
    expect(row!.n).toBe(0)
  })
})

/**
 * Слой 3 (В-8, вариант E) — канареечный кандидат. Сканер слоя 2 читает текст и не понимает
 * конкатенацию; канарейка читает ответ и не понимает ничего, кроме лишней строки в нём.
 * У двух механизмов нет общей слепой зоны — в этом весь смысл комбинации.
 *
 * Проверки поставлены там, где цена ошибки максимальна (В-8, слой 3): список людей и выгрузка,
 * раскрытие аудитории, счётчик оплачиваемых мест, жёсткая проверка лимита, отчёты по людям.
 */
describe('слой 3: канареечный кандидат не попадает в списки сотрудников', () => {
  let tenantId: string
  let adminId: string
  let canaries: { id: string, fullName: string }[] = []

  beforeAll(async () => {
    tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
    adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
    canaries = (await admin`select id, full_name from users where tenant_id = ${tenantId} and kind = 'candidate'`)
      .map(r => ({ id: r.id as string, fullName: r.full_name as string }))
  })

  const ctx = () => ({ tenantId, actorId: adminId })
  const isCanary = (id: unknown) => canaries.some(c => c.id === id)

  it('посев содержит не менее трёх кандидатов — иначе слой 3 не проверяет ничего', () => {
    expect(canaries.length, 'в тенанте нет канареечных кандидатов: нужен `pnpm db:seed` на чистой базе').toBeGreaterThanOrEqual(3)
  })

  it('список людей не показывает кандидата ни на одной вкладке, и счётчик чипов его не считает', async () => {
    const { listPeople } = await import('../../server/services/people')
    for (const tab of ['active', 'blocked', 'all'] as const) {
      const page = await listPeople(ctx(), { tab, limit: 100, includeHidden: true } as never)
      expect(page.items.filter(p => isCanary(p.id)).map(p => p.fullName), `кандидат в списке людей, вкладка ${tab}`).toEqual([])
    }
    const all = await listPeople(ctx(), { tab: 'all', limit: 100, includeHidden: true } as never)
    const [staff] = await admin`select count(*)::int as n from users where tenant_id = ${tenantId} and kind = 'employee'`
    expect(all.counts.all, 'счётчик чипа «Усі» считает кандидатов').toBe(Number(staff!.n))
  })

  /**
   * > [исправлено, PR-15: `docs/v2/29` §7.20 создаёт кандидату обычную `assignments`]
   * > Ранее: «раскрытие аудитории не возвращает кандидата ни по метке, ни по прямому перечню».
   *
   * Инвариант П-16.1 не ослаб, а стал точным: кандидат не попадает в аудиторию, собранную
   * **условием** («мітка», «посада», «точка», сегмент) — там его появление всегда случайно.
   * Названный поимённо он в неё попадает: иначе отклик по вакансии не смог бы выдать ему
   * материалы, а правила прохождения получили бы второго носителя (инвариант 1). Курс
   * чужого этапа кандидату всё равно не назначить — `stageForbidsCandidates()` смотрит
   * ровно на названных поимённо (`docs/v2/33` §7.9).
   */
  it('раскрытие аудитории не возвращает кандидата по условию, но возвращает названного поимённо', async () => {
    const { resolveAudience } = await import('../../server/services/audience')
    const { withTenant } = await import('../../server/utils/withTenant')
    const byTag = await withTenant(tenantId, adminId, tx => resolveAudience(tx, { match: 'any', rules: [{ type: 'tag', values: ['кандидат'] }] } as never))
    expect([...byTag], 'кандидат попал в аудиторию по метке').toEqual([])
    const ids = canaries.map(c => c.id)
    const byId = await withTenant(tenantId, adminId, tx => resolveAudience(tx, { match: 'any', rules: [{ type: 'user', ids }] } as never))
    expect([...byId].sort(), 'названный поимённо кандидат обязан попадать в аудиторию (`29` §7.20)').toEqual([...ids].sort())
  })

  it('счётчик оплачиваемых мест и жёсткая проверка лимита считают только штат', async () => {
    const { collectUsage } = await import('../../server/services/usage')
    const { checkPlanLimit } = await import('../../server/services/platform')
    const [row] = await admin`
      select count(*)::int as n from users
      where tenant_id = ${tenantId} and kind = 'employee' and status = 'active' and not is_blocked`
    const expected = Number(row!.n)
    expect((await collectUsage(tenantId)).activeUsers, 'кандидат в tenant_usage.active_users').toBe(expected)
    expect((await checkPlanLimit(tenantId, 'users')).current, 'кандидат в жёсткой проверке лимита людей').toBe(expected)
  })

  it('отчёты по людям и отчёт по Telegram не показывают кандидата', async () => {
    const { inactiveReport } = await import('../../server/services/people')
    const rows = await inactiveReport(ctx(), 30)
    expect(rows.filter(r => isCanary(r.id)), 'кандидат в отчёте «неактивні понад 30 днів»').toEqual([])
    const { notificationsReport } = await import('../../server/services/notifications')
    const rep = await notificationsReport(ctx())
    expect(rep.blocked.filter(r => isCanary(r.id)), 'кандидат в списке заблокировавших бота').toEqual([])
    const { listTelegramConnections } = await import('../../server/services/telegram')
    const conns = await listTelegramConnections(ctx())
    expect(conns.filter(r => isCanary(r.user_id)), 'кандидат в таблице подключений Telegram').toEqual([])
  })

  /**
   * `28` §13 к.4 в той части, что относится к `kind`: перевод кандидата в штат меняет вид
   * у той же записи, а не заводит вторую. Сам сценарий найма (точка, должность, дата,
   * `candidate.hired` в журнале) появится в PR-13/PR-14 — здесь проверяется инвариант пакета,
   * на котором тот сценарий стоит.
   */
  it('перевод кандидата в штат меняет kind той же записи — второй строки users не появляется', async () => {
    const canary = canaries[0]!
    const [before] = await admin`select id, created_at from users where id = ${canary.id}`
    const [total] = await admin`select count(*)::int as n from users where tenant_id = ${tenantId}`
    // С PR-13 у записи есть вторая ось — `candidate_state`, и `users_candidate_coherence_chk`
    // (docs/v2/28 §3.2) требует её ровно у кандидата: сотрудника с состоянием воронки не
    // бывает. Поэтому «перевод в штат» здесь снимает состояние вместе со сменой вида — ровно
    // так же, как это сделает транзакция найма (§7.6, PR-14). Факт прихода через воронку
    // сохраняет `converted_from_candidate_at`, а не остаточный `candidate_state`.
    await admin`update users set kind = 'employee', candidate_state = null, converted_from_candidate_at = now() where id = ${canary.id}`
    try {
      const { listPeople } = await import('../../server/services/people')
      const page = await listPeople(ctx(), { tab: 'all', limit: 100, includeHidden: true } as never)
      const found = page.items.find(p => p.id === canary.id)
      expect(found, 'бывший кандидат не виден в списке людей после перевода в штат').toBeDefined()
      const [after] = await admin`select count(*)::int as n from users where tenant_id = ${tenantId}`
      expect(after!.n, 'перевод в штат завёл вторую запись users').toBe(Number(total!.n))
      const [row] = await admin`select id, created_at from users where id = ${canary.id}`
      expect(row!.created_at, 'история человека переехала на другую запись').toEqual(before!.created_at)
    }
    finally {
      await admin`update users set kind = 'candidate', candidate_state = 'active', converted_from_candidate_at = null where id = ${canary.id}`
    }
  })

  it('кандидат виден, если спросить про него явно — значит из списков его убрал фильтр, а не RLS', async () => {
    const { withTenant } = await import('../../server/utils/withTenant')
    const rows = await withTenant(tenantId, adminId, async tx =>
      await tx.execute(sql`select id from users where kind = 'candidate'`) as unknown as { id: string }[])
    expect(rows.length, 'канарейка не видна изнутри тенанта — сломан посев, а не фильтр').toBeGreaterThanOrEqual(3)
  })
})
