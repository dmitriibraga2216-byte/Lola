import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { publicApplyAttempts, users, vacancies, vacancyApplications, vacancyLanguages } from '../db/schema'
import { db } from '../db/client'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import {
  PUBLIC_CONSENT_TEXT_VERSION, VACANCY_APPLY_EXPIRE_HOURS, VACANCY_APPLY_LIMITS,
  VACANCY_APPLY_OTP_SENDS_PER_HOUR, VACANCY_APPLY_OTP_TTL_SEC, VACANCY_APPLY_REVIEW_SCORE,
  VACANCY_APPLY_SPAM_SCORE, VACANCY_APPLY_SPAM_SCORES, VACANCY_NONCE_MIN_SEC,
  VACANCY_NONCE_TTL_SEC,
} from '../../shared/enums'
import type { VacancyApplicationState } from '../../shared/enums'
import type { PublicApplyInput } from '../../shared/schemas/publicApply'
import type { CandidateCreateInput } from '../../shared/schemas/candidates'
import { hitRateLimit } from './rateLimit'
import { issueContactCode, verifyContactCode } from './otp'
import { recordAudit } from './audit'
import { assignFromVacancy } from './vacancies'
import { createCandidateTx, precheckCandidate } from './candidates'
import { enqueueNotification } from './notifications'

/**
 * Публичный контур вакансии: страница по ссылке и приём отклика
 * (docs/v2/29-vacancies.md §3.9, §6.3, §7.1–§7.8, §7.20; решение docs/v2/44 В-9, патч П-25.3;
 * план docs/v2/45-plan.md PR-16).
 *
 * **Главное правило файла — правило 2 CLAUDE.md в самом неудобном месте продукта.** Здесь нет
 * сессии, а значит нет и тенанта в контексте: соблазн «сходить в базу напрямую, всё равно
 * фильтровать не по чему» максимален. Он не реализуется ни разу. Тенант выводится из токена
 * ссылки **одной** функцией `SECURITY DEFINER` (`vacancy_public_lookup`, миграция
 * `0074_v2_vacancy_apply`), отдающей ровно пять полей и ни одного поля вакансии, — а дальше
 * каждое обращение идёт через `withTenant(link.tenant_id, link.owner_id, …)`. Механизм не
 * придуман заново: буквально так же работает публичная ссылка тайного покупателя
 * (`server/services/mystery.ts`, `mystery_link_lookup`), и второй способ обойтись без сессии
 * в продукте не заводится.
 *
 * Второе правило — **ответ формы одинаков при успехе и при отказе** (§7.3). Честный код
 * ошибки на honeypot, на частотное ограничение или на исчерпанный лимит кандидатов
 * превратил бы публичную страницу в отладчик для бота: подобрать «проходящий» отклик
 * можно было бы за минуты. Поэтому наружу уходит один и тот же `202` с благодарностью, а
 * причина остаётся внутри — в `spam_reasons` отклика и в строке `public_apply_attempts`.
 * Единственное исключение — согласие на обработку ПД: о нём форма говорит прямо, потому что
 * это право человека, а не мера против спама.
 *
 * Чего здесь нет: загрузки резюме из публичного контура (см. [решение] у `resumeAssetId`
 * ниже), публикации на площадках и AI-генерации текста — это PR-17.
 */

export interface PublicCtx {
  ip: string
  userAgent?: string | null
}

interface LinkRow {
  id: string
  tenant_id: string
  state: string
  public_enabled: boolean
  owner_id: string | null
}

export type LinkState =
  | { ok: true, link: LinkRow }
  | { ok: false, code: 'not_found' | 'gone' }

// ── Хэши, подписи и задержка выравнивания ─────────────────────────────────────────────────

function secret(): string {
  // Тот же корень, что у остальных подписей приложения. Отдельного ключа публичный контур
  // не заводит: ещё один секрет в `.env` — ещё один способ потерять его на стенде.
  return process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY || 'dev-secret'
}

/**
 * `ip_hash` = HMAC-SHA256 адреса с посолью тенанта (§3.9 [решение]). Сырой IP не хранится
 * нигде: частотным правилам §7.4 нужен ответ «тот же ли это адрес», а не сам адрес, и
 * посоль тенанта не даёт сличать посетителей разных пространств между собой.
 */
export function ipHash(tenantId: string, ip: string): string {
  return createHmac('sha256', `${secret()}:${tenantId}`).update(ip).digest('hex')
}

export function uaHash(tenantId: string, ua: string | null | undefined): string | null {
  return ua ? createHmac('sha256', `${secret()}:${tenantId}:ua`).update(ua).digest('hex') : null
}

/**
 * `form_nonce` (§6.3, §7.6) — подписанная сервером метка выдачи формы: вакансия плюс момент.
 * Хранить её негде и не нужно — подпись проверяема без состояния, а одноразовость держит
 * счётчик `rate_limits` (см. `nonceUsed()`): второе применение того же значения — верный
 * признак скрипта, повторяющего удачную отправку.
 */
export function signNonce(vacancyId: string, issuedAt = Date.now()): string {
  const payload = `${vacancyId}.${issuedAt}`
  const sig = createHmac('sha256', secret()).update(payload).digest('base64url')
  return `${Buffer.from(payload).toString('base64url')}.${sig}`
}

export function readNonce(nonce: string): { vacancyId: string, issuedAt: number } | null {
  const [body, sig] = nonce.split('.')
  if (!body || !sig) return null
  let payload: string
  try {
    payload = Buffer.from(body, 'base64url').toString('utf8')
  }
  catch {
    return null
  }
  const expected = createHmac('sha256', secret()).update(payload).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  const [vacancyId, issuedAt] = payload.split('.')
  if (!vacancyId || !issuedAt) return null
  return { vacancyId, issuedAt: Number(issuedAt) }
}

/**
 * Выравнивание ответа задержкой 120 мс ± 20 мс (§7.2): несуществующий, закрытый и архивный
 * токены обязаны отвечать неразличимо **по времени**, иначе перебор снова становится
 * осмысленным — «этот отвечал дольше, значит строка нашлась».
 */
export async function alignDelay(): Promise<void> {
  if (process.env.NODE_ENV === 'test' || process.env.PUBLIC_APPLY_NO_DELAY === '1') return
  await new Promise(r => setTimeout(r, 100 + randomInt(0, 41)))
}

// ── Разбор токена (единственный вход в тенанта без сессии) ────────────────────────────────

/**
 * Токен → тенант. Единственное место файла, обращающееся к БД вне `withTenant()`, и обращение
 * это — вызов функции `SECURITY DEFINER`, отдающей пять полей: идентификатор, тенанта,
 * состояние, признак публичности и владельца контекста. Данных вакансии здесь нет вовсе;
 * всё остальное читается уже внутри тенанта.
 *
 * Чужой токен и несуществующий токен неразличимы: `404` без подробностей (правило 15
 * CLAUDE.md, критерий `29` §13 к. 14, сквозная проверка 16).
 */
export async function resolveVacancyToken(token: string): Promise<LinkState> {
  if (!token || token.length > 64) return { ok: false, code: 'not_found' }
  const rows = await db.execute(sql`select * from vacancy_public_lookup(${token})`) as unknown as LinkRow[]
  const link = rows[0]
  if (!link || !link.public_enabled) return { ok: false, code: 'not_found' }
  // Приостановленная и закрытая вакансия — `410`: ссылка была настоящей, и человеку честнее
  // сказать «набір призупинено», чем делать вид, что страницы не существовало (§4, §12.1).
  if (link.state !== 'published') return { ok: false, code: 'gone' }
  return { ok: true, link }
}

// ── Журнал попыток ────────────────────────────────────────────────────────────────────────

async function noteAttempt(tx: TenantTx, tenantId: string, vacancyId: string | null, ipHashValue: string, outcome: string, reason?: string | null): Promise<void> {
  await tx.insert(publicApplyAttempts).values({
    tenantId,
    vacancyId,
    ipHash: ipHashValue,
    outcome,
    reason: reason ?? null,
  })
}

// ── Публичная карточка вакансии (§5.4, §13 к. 2) ──────────────────────────────────────────

export interface PublicVacancy {
  title: string
  /** Язык страницы: вакансии, иначе пространства (§7.20). */
  language: string
  city: string | null
  countryCode: string | null
  employmentType: string | null
  workFormat: string | null
  experienceLevel: string | null
  educationLevel: string | null
  /** Вилка — только при `salary_visible` (§13 к. 2). */
  salary: { from: string | null, to: string | null, currency: string } | null
  descriptionHtml: string | null
  requirementsHtml: string | null
  dutiesHtml: string | null
  extraHtml: string | null
  languages: { langCode: string, level: string, isRequired: boolean }[]
  otpRequired: boolean
  consentVersion: string
  formNonce: string
}

export type PublicVacancyResult =
  | { ok: true, vacancy: PublicVacancy }
  | { ok: false, code: 'not_found' | 'gone' | 'rate_limited' }

/**
 * Публичная страница (`GET /api/v1/public/j/:token`, критерий §13 к. 2).
 *
 * Наружу уходит только то, что человек и так прочитает в объявлении: ни названия курса, ни
 * рекрутера, ни одного внутреннего идентификатора, кроме самого токена. Вилка — только при
 * `salary_visible`. Тридцать просмотров с адреса за десять минут — потолок (§7.4).
 */
export async function publicVacancy(token: string, ctx: PublicCtx): Promise<PublicVacancyResult> {
  const st = await resolveVacancyToken(token)
  if (!st.ok) {
    await alignDelay()
    return { ok: false, code: st.code }
  }
  const link = st.link
  const ipH = ipHash(link.tenant_id, ctx.ip)
  if (!await hitRateLimit(`apply:view:${link.tenant_id}:${ipH}`, VACANCY_APPLY_LIMITS.viewPer10Min, 600)) {
    await withTenant(link.tenant_id, link.owner_id, tx => noteAttempt(tx, link.tenant_id, link.id, ipH, 'submit_blocked', 'view_rate'))
    return { ok: false, code: 'rate_limited' }
  }

  return withTenant(link.tenant_id, link.owner_id, async (tx) => {
    const [row] = await tx.select().from(vacancies).where(eq(vacancies.id, link.id))
    if (!row) return { ok: false as const, code: 'not_found' as const }
    const langs = await tx.select({
      langCode: vacancyLanguages.langCode,
      level: vacancyLanguages.level,
      isRequired: vacancyLanguages.isRequired,
    }).from(vacancyLanguages).where(eq(vacancyLanguages.vacancyId, link.id)).orderBy(vacancyLanguages.sort)
    await noteAttempt(tx, link.tenant_id, link.id, ipH, 'view')
    return {
      ok: true as const,
      vacancy: {
        title: row.title,
        language: await pageLanguage(tx, link.tenant_id, row.publicLanguage),
        city: row.city,
        countryCode: row.countryCode,
        employmentType: row.employmentType,
        workFormat: row.workFormat,
        experienceLevel: row.experienceLevel,
        educationLevel: row.educationLevel,
        salary: row.salaryVisible ? { from: row.salaryFrom, to: row.salaryTo, currency: row.salaryCurrency } : null,
        descriptionHtml: row.descriptionHtml,
        requirementsHtml: row.requirementsHtml,
        dutiesHtml: row.dutiesHtml,
        extraHtml: row.extraHtml,
        languages: langs,
        otpRequired: row.publicApplyOtp,
        consentVersion: PUBLIC_CONSENT_TEXT_VERSION,
        formNonce: signNonce(link.id),
      },
    }
  })
}

/**
 * Язык публичной страницы (§7.20): вакансии, иначе пространства. Язык администратора,
 * открывшего форму вакансии, к посетителю отношения не имеет — он сюда не попадает никак.
 */
async function pageLanguage(tx: TenantTx, tenantId: string, vacancyLanguage: string | null): Promise<string> {
  if (vacancyLanguage) return vacancyLanguage
  const rows = await tx.execute(sql`select locale from tenants where id = ${tenantId}::uuid`) as unknown as { locale: string }[]
  return rows[0]?.locale ?? 'uk'
}

// ── Оценка подозрительности (§7.6, §7.7) ──────────────────────────────────────────────────

export interface SpamInput {
  website?: string | null
  comment?: string | null
  fullName: string
  fillSeconds: number | null
  nonceReplay: boolean
  ipMarkedSpam: boolean
}

export interface SpamVerdict {
  score: number
  reasons: string[]
}

/**
 * Слагаемые §7.7 — чистая функция, потому что это правило, а не запрос: её проверяет
 * `tests/unit/vacancy-apply.spec.ts` построчно, без базы.
 *
 * Чёрного списка контактов тенанта (§7.7, слагаемое 100) в продукте нет ни таблицей, ни
 * экраном — заводить его молча здесь значило бы придумать сущность мимо ТЗ (CLAUDE.md
 * «не выдумывать поля»). Слагаемое учтено списком `29` §7.7 и добавится вместе с самим
 * списком; сегодня его место занимает `ipMarkedSpam`, который считается по журналу.
 */
export function spamOf(input: SpamInput): SpamVerdict {
  const reasons: string[] = []
  let score = 0
  if (input.website && input.website.trim() !== '') {
    score += VACANCY_APPLY_SPAM_SCORES.honeypot
    reasons.push('honeypot')
  }
  if (input.nonceReplay) {
    score += VACANCY_APPLY_SPAM_SCORES.nonceReplay
    reasons.push('nonce_replay')
  }
  if (input.fillSeconds != null && input.fillSeconds < VACANCY_NONCE_MIN_SEC) {
    score += VACANCY_APPLY_SPAM_SCORES.fastSubmit
    reasons.push('fast_submit')
  }
  if (input.comment && /https?:\/\/|www\./i.test(input.comment)) {
    score += VACANCY_APPLY_SPAM_SCORES.commentLinks
    reasons.push('comment_links')
  }
  // Имя из одних латинских согласных (§7.7): «qwrtp zxcvb» — след генератора, а не человека.
  // Кириллица и любая гласная снимают признак: «Ольга» и «Ian» нормальны, «Krzysztof» — тоже,
  // поэтому проверяется каждое слово, и достаточно одной гласной в имени целиком.
  const letters = input.fullName.replace(/[^\p{L}]/gu, '')
  if (letters.length > 0 && /^[a-z]+$/i.test(letters) && !/[aeiouy]/i.test(letters)) {
    score += VACANCY_APPLY_SPAM_SCORES.consonantName
    reasons.push('consonant_name')
  }
  if (input.ipMarkedSpam) {
    score += VACANCY_APPLY_SPAM_SCORES.ipMarkedSpam
    reasons.push('ip_spam')
  }
  return { score, reasons }
}

/**
 * Состояние отклика по итогам проверок (§7.7 плюс критерий §13 к. 3).
 *
 * [гипотеза] §7.7 задаёт два порога: 50–99 — модерация, ≥100 — немой отсев. Но критерий
 * §13 к. 3 требует `pending_review` при быстрой отправке, которая стоит 40 — ниже порога.
 * [решение] Порог — **не единственный** вход в модерацию: любая сработавшая причина уводит
 * отклик к человеку, а порог решает только, показывать его рекрутеру (`pending_review`) или
 * не показывать вовсе (`spam`). Так выполняются оба правила разом, и ни одна сработавшая
 * проверка не теряется молча — чего §7.7 и добивается.
 */
export function stateFor(verdict: SpamVerdict, blocked: boolean): VacancyApplicationState {
  if (verdict.score >= VACANCY_APPLY_SPAM_SCORE) return 'spam'
  if (verdict.score >= VACANCY_APPLY_REVIEW_SCORE || verdict.reasons.length > 0 || blocked) return 'pending_review'
  return 'pending'
}

// ── Приём отклика (§7.3) ──────────────────────────────────────────────────────────────────

export type SubmitResult =
  /** `devCode` — только при `OTP_DEBUG=1` (dev и CI), как у входа по коду: в проде переменной нет. */
  | { ok: true, applicationId: string, otpRequired: boolean, channel: 'sms' | 'email' | null, devCode?: string }
  | { ok: false, code: 'not_found' | 'gone' | 'consent_required' | 'contact_required' | 'nonce_stale' }

/**
 * Приём отклика — **одна транзакция** (§7.3). Порядок проверок: состояние вакансии →
 * суточный потолок → частота по IP → `form_nonce` → honeypot → согласие → наличие контакта →
 * лимит `candidates_active`.
 *
 * Наружу уходит один ответ. Не «один из двух», не «одинаковый текст с разным кодом» —
 * буквально один: `202` с `otpRequired` вакансии. Отклик при этом может оказаться в
 * `pending`, `pending_review` или `spam`, и различить это снаружи нельзя (§13 к. 3, 4, 5).
 *
 * Код подтверждения уходит и на отклик, попавший на модерацию: человек, которого частотное
 * правило задело случайно (общий офисный адрес, повторная отправка), обязан иметь
 * возможность подтвердить номер — а вот кандидатом он от этого не станет, решение
 * останется за рекрутером.
 */
export async function submitApplication(token: string, input: PublicApplyInput, ctx: PublicCtx): Promise<SubmitResult> {
  const st = await resolveVacancyToken(token)
  if (!st.ok) {
    await alignDelay()
    return { ok: false, code: st.code }
  }
  const link = st.link
  const tenantId = link.tenant_id
  const ipH = ipHash(tenantId, ctx.ip)

  const nonce = readNonce(input.formNonce)
  // Протухший или подделанный nonce — единственный «технический» отказ формы: человеку нужно
  // обновить страницу, и молчать об этом бессмысленно — он всё равно не получит ни кода, ни
  // отклика (§6.3, §7.6). Подделанный при этом неотличим от протухшего.
  if (!nonce || nonce.vacancyId !== link.id || Date.now() - nonce.issuedAt > VACANCY_NONCE_TTL_SEC * 1000) {
    await withTenant(tenantId, link.owner_id, tx => noteAttempt(tx, tenantId, link.id, ipH, 'submit_blocked', 'nonce_stale'))
    return { ok: false, code: 'nonce_stale' }
  }

  const fillSeconds = Math.max(0, Math.round((Date.now() - nonce.issuedAt) / 1000))
  // Одноразовость nonce держит счётчик частоты: первое применение проходит, второе — нет.
  const nonceReplay = !await hitRateLimit(`apply:nonce:${input.formNonce}`, 1, VACANCY_NONCE_TTL_SEC)

  const blocked = await rateVerdict(tenantId, link.id, ipH)
  const ipMarkedSpam = await ipWasSpam(tenantId, ipH)
  const verdict = spamOf({
    website: input.website,
    comment: input.comment,
    fullName: input.fullName,
    fillSeconds,
    nonceReplay,
    ipMarkedSpam,
  })
  if (blocked) verdict.reasons.push(blocked)

  const phone = input.phone ?? null
  const email = input.email ?? null
  const consentGivenAt = new Date()

  const state = stateFor(verdict, Boolean(blocked))
  const created = await withTenant(tenantId, link.owner_id, async (tx) => {
    // Суточный потолок вакансии (§3.1, §7.3 проверка 2) — не про спам, а про ёмкость
    // рекрутера: выше потолка отклик не принимается, но ответ снаружи тот же.
    const [row] = await tx.select({ cap: vacancies.applyDailyCap, otp: vacancies.publicApplyOtp, lang: vacancies.publicLanguage }).from(vacancies).where(eq(vacancies.id, link.id))
    const today = await tx.execute(sql`
      select count(*)::int as n from vacancy_applications
       where vacancy_id = ${link.id}::uuid and created_at > now() - interval '24 hours'
    `) as unknown as { n: number }[]
    const overCap = (today[0]?.n ?? 0) >= (row?.cap ?? 0)
    if (overCap) verdict.reasons.push('daily_cap')

    const [app] = await tx.insert(vacancyApplications).values({
      tenantId,
      vacancyId: link.id,
      state: overCap ? 'pending_review' : state,
      fullName: input.fullName,
      phone,
      email,
      comment: input.comment ?? null,
      // [решение] Резюме из публичного контура в PR-16 не принимается. Загрузка файла без
      // сессии — это анонимная запись в хранилище тенанта, ограниченная только частотным
      // правилом: ставить её **до** подтверждения контакта нельзя, а после подтверждения
      // человек уже кандидат и приносит резюме обычным путём. Колонка заведена, уборка
      // (§13 к. 6) реализована, сам приём файла отнесён к PR-17 вместе с площадками.
      resumeAssetId: null,
      source: input.s ? 'job_board' : 'vacancy_link',
      sourceDetail: input.s ?? null,
      utm: input.s ? { s: input.s } : {},
      consentGivenAt,
      consentTextVersion: PUBLIC_CONSENT_TEXT_VERSION,
      spamScore: verdict.score,
      spamReasons: verdict.reasons,
      ipHash: ipH,
      userAgentHash: uaHash(tenantId, ctx.userAgent),
      formNonce: input.formNonce,
      fillSeconds,
    }).returning({ id: vacancyApplications.id })

    await noteAttempt(tx, tenantId, link.id, ipH,
      blocked || overCap ? 'submit_blocked' : 'submit_ok',
      blocked ?? (overCap ? 'daily_cap' : null))

    return { id: app!.id, otpRequired: row?.otp ?? true, language: row?.lang ?? null }
  })

  if (!created.otpRequired) {
    // Без подтверждения контакта конверсия идёт сразу (§6.3 «При выключенном OTP — сразу
    // второй текст»), но только для чистого отклика: придержанный ждёт рекрутера.
    await convertIfClean(tenantId, link.owner_id, link.id, created.id)
    return { ok: true, applicationId: created.id, otpRequired: false, channel: null }
  }

  const channel = phone ? 'sms' as const : 'email' as const
  const contact = phone ?? email!
  const sent = await issueContactCode({
    tenantId,
    contact,
    channel,
    ttlSec: VACANCY_APPLY_OTP_TTL_SEC,
    sendsPerHour: VACANCY_APPLY_OTP_SENDS_PER_HOUR,
    locale: created.language ?? undefined,
  })
  await withTenant(tenantId, link.owner_id, tx => noteAttempt(tx, tenantId, link.id, ipH, sent.ok ? 'otp_sent' : 'otp_failed', sent.ok ? null : 'send_rate'))
  return {
    ok: true,
    applicationId: created.id,
    otpRequired: true,
    channel,
    ...(sent.ok && sent.devCode ? { devCode: sent.devCode } : {}),
  }
}

/**
 * Частотные правила §7.4. Возвращает причину блокировки или `null`.
 *
 * Считается **успешными откликами**, а не запросами: цель правила — не пустить одного
 * человека заполнять воронку, а не защитить сервер от нагрузки (для этого есть счётчик
 * просмотров). Каждое превышение оседает строкой `public_apply_attempts` — критерий
 * §13 к. 5 требует именно этого.
 */
async function rateVerdict(tenantId: string, vacancyId: string, ipH: string): Promise<string | null> {
  if (!await hitRateLimit(`apply:ip:h:${tenantId}:${ipH}`, VACANCY_APPLY_LIMITS.ipHour, 3600)) return 'ip_hour'
  if (!await hitRateLimit(`apply:ip:d:${tenantId}:${ipH}`, VACANCY_APPLY_LIMITS.ipDay, 86_400)) return 'ip_day'
  if (!await hitRateLimit(`apply:vac:${vacancyId}:${ipH}`, VACANCY_APPLY_LIMITS.perVacancyDay, 86_400)) return 'vacancy_day'
  return null
}

/** Был ли адрес уже помечен спамом (§7.7, слагаемое 50). */
async function ipWasSpam(tenantId: string, ipH: string): Promise<boolean> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      select 1 from vacancy_applications
       where ip_hash = ${ipH} and state = 'spam' and created_at > now() - interval '30 days' limit 1
    `) as unknown as unknown[]
    return rows.length > 0
  })
}

// ── Подтверждение контакта (§7.5) ─────────────────────────────────────────────────────────

export type ConfirmResult =
  | { ok: true, status: 'accepted' }
  | { ok: false, code: 'not_found' | 'gone' | 'otp_invalid' | 'otp_too_many' | 'expired' }

/**
 * Ввод кода (`POST /api/v1/public/j/:token/apply/:aid/confirm`, §7.5).
 *
 * Успех отвечает `accepted` **всегда** — и когда кандидат создан, и когда отклик остался на
 * модерации: различие здесь снова сделало бы форму отладчиком (§7.3). Неверный код —
 * честный `400`: он про ввод человека, а не про сработавшую проверку.
 */
export async function confirmApplication(token: string, applicationId: string, code: string, ctx: PublicCtx): Promise<ConfirmResult> {
  const st = await resolveVacancyToken(token)
  if (!st.ok) {
    await alignDelay()
    return { ok: false, code: st.code }
  }
  const link = st.link
  const tenantId = link.tenant_id
  const ipH = ipHash(tenantId, ctx.ip)

  const app = await withTenant(tenantId, link.owner_id, async (tx) => {
    const [row] = await tx.select().from(vacancyApplications)
      .where(and(eq(vacancyApplications.id, applicationId), eq(vacancyApplications.vacancyId, link.id)))
    return row ?? null
  })
  if (!app) return { ok: false, code: 'not_found' }
  if (app.state === 'expired') return { ok: false, code: 'expired' }

  const contact = app.phone ?? app.email!
  const verified = await verifyContactCode(tenantId, contact, code)
  if (!verified.ok) {
    await withTenant(tenantId, link.owner_id, tx => noteAttempt(tx, tenantId, link.id, ipH, 'otp_failed', verified.code))
    return { ok: false, code: verified.code === 'rate_limited' ? 'otp_too_many' : 'otp_invalid' }
  }

  await withTenant(tenantId, link.owner_id, tx => tx.update(vacancyApplications)
    .set({ otpConfirmedAt: new Date(), updatedAt: new Date() })
    .where(eq(vacancyApplications.id, applicationId)))

  await convertIfClean(tenantId, link.owner_id, link.id, applicationId)
  return { ok: true, status: 'accepted' }
}

// ── Конверсия отклика в кандидата (§7.20) ─────────────────────────────────────────────────

export type ConvertResult =
  | { ok: true, state: 'accepted' | 'merged', candidateId: string, assignmentId?: string }
  | { ok: false, code: 'not_found' | 'wrong_state' | 'limit' | 'no_course' | 'failed' }

/** Конверсия только чистого отклика: придержанный ждёт решения рекрутера (§7.7). */
async function convertIfClean(tenantId: string, ownerId: string | null, vacancyId: string, applicationId: string): Promise<void> {
  await convertApplication(tenantId, ownerId, vacancyId, applicationId, { onlyPending: true }).catch((err) => {
    console.error('[vacancy.apply] конверсия отклика не удалась', applicationId, err)
  })
}

/**
 * **Единственный путь, которым отклик становится кандидатом** (§7.20).
 *
 * Одна транзакция, полный откат при ошибке: `users` с `kind='candidate'`, обычная
 * `assignments` по шаблону вакансии и отметка на самом отклике живут или умирают вместе.
 * Кандидат создаётся `createCandidateTx()` — тем же телом, что и форма рекрутера: второго
 * места, где появляется человек с `kind='candidate'`, в продукте нет, и ни один из его
 * инвариантов (дубликаты, лимит оси, согласие, история статусов) здесь не переписан.
 *
 * Уже работающий человек и уже заведённый кандидат (§12.6, §12.5) дают `merged`: новый
 * профиль не создаётся никогда — `unique (tenant_id, phone)` этого и не позволил бы, —
 * а повторный отклик остаётся строкой `vacancy_applications` со ссылкой на существующего
 * человека плюс записью `vacancy.application_merged` в `audit_log`.
 *
 * Исчерпанная ось `candidates_active` не теряет отклик и не отвечает человеку отказом
 * (§12.2): отклик остаётся `pending_review` с причиной `limit`, рекрутер видит «Відгук не
 * створив кандидата: вичерпано ліміт тарифу». Проверка оси — `precheckCandidate()`, то есть
 * `checkLimit()` из `tenantLimits.ts`: сырых сравнений «использовано против лимита» в этом
 * файле нет ни одного.
 */
export async function convertApplication(
  tenantId: string,
  ownerId: string | null,
  vacancyId: string,
  applicationId: string,
  opts: { onlyPending?: boolean, actorId?: string } = {},
): Promise<ConvertResult> {
  const ctx = { tenantId, actorId: opts.actorId ?? ownerId ?? '' }
  const app = await withTenant(tenantId, ctx.actorId || null, async (tx) => {
    const [row] = await tx.select().from(vacancyApplications)
      .where(and(eq(vacancyApplications.id, applicationId), eq(vacancyApplications.vacancyId, vacancyId)))
    return row ?? null
  })
  if (!app) return { ok: false, code: 'not_found' }
  if (app.state === 'accepted' || app.state === 'merged') return { ok: false, code: 'wrong_state' }
  if (opts.onlyPending && app.state !== 'pending') return { ok: false, code: 'wrong_state' }

  const vacancy = await withTenant(tenantId, ctx.actorId || null, async (tx) => {
    const [row] = await tx.select({
      id: vacancies.id,
      title: vacancies.title,
      courseId: vacancies.courseId,
      recruiterId: vacancies.recruiterId,
      publicLanguage: vacancies.publicLanguage,
    }).from(vacancies).where(eq(vacancies.id, vacancyId))
    return row ?? null
  })
  if (!vacancy?.courseId) return { ok: false, code: 'no_course' }

  // Проверки, ходящие мимо транзакции тенанта (дубликаты и ось тарифа), — до неё.
  const blocked = await precheckCandidate(ctx, { phone: app.phone, email: app.email })
  if (blocked) {
    if (blocked.code === 'limit_exceeded') {
      await holdApplication(tenantId, ctx.actorId, applicationId, 'limit')
      return { ok: false, code: 'limit' }
    }
    // Человек уже есть в тенанте — кандидатом или сотрудником (§12.6, §12.10): повторный
    // отклик становится событием в его истории, а не вторым профилем.
    const existing = 'duplicates' in blocked ? blocked.duplicates[0] : undefined
    if (existing) {
      await withTenant(tenantId, ctx.actorId || null, async (tx) => {
        await tx.update(vacancyApplications).set({
          state: 'merged',
          candidateId: existing.id,
          updatedAt: new Date(),
        }).where(eq(vacancyApplications.id, applicationId))
        await recordAudit(tx, {
          tenantId,
          actorId: null,
          action: 'vacancy.application_merged',
          entity: 'vacancy_application',
          entityId: applicationId,
          after: { personId: existing.id, kind: existing.kind, vacancyId, title: vacancy.title },
        })
        await notifyRecruiter(tx, tenantId, vacancy.recruiterId, vacancy.title, 'merged')
      })
      return { ok: true, state: 'merged', candidateId: existing.id }
    }
    await holdApplication(tenantId, ctx.actorId, applicationId, blocked.code)
    return { ok: false, code: 'failed' }
  }

  const language = await withTenant(tenantId, ctx.actorId || null, tx => pageLanguage(tx, tenantId, vacancy.publicLanguage))

  const parts = splitFullName(app.fullName)

  return withTenant(tenantId, ctx.actorId || null, async (tx): Promise<ConvertResult> => {
    const created = await createCandidateTx(tx, ctx, {
      firstName: parts.firstName,
      lastName: parts.lastName,
      middleName: null,
      phone: app.phone,
      email: app.email,
      source: app.source as CandidateCreateInput['source'],
      sourceDetail: app.sourceDetail,
      recruiterId: vacancy.recruiterId,
      vacancyId,
      commLanguage: language,
      resumeAssetId: app.resumeAssetId,
      consentGiven: true,
      confirmDuplicate: false,
    }, {
      consentGivenAt: app.consentGivenAt,
      automatic: true,
    })
    if (!created.ok) throw new Error(`conversion failed: ${created.code}`)

    const assigned = await assignFromVacancy(tx, ctx, vacancyId, created.candidate.id)
    if (!assigned.ok) throw new Error(`assignment failed: ${assigned.code}`)

    await tx.update(vacancyApplications).set({
      state: 'accepted',
      candidateId: created.candidate.id,
      updatedAt: new Date(),
    }).where(eq(vacancyApplications.id, applicationId))

    await recordAudit(tx, {
      tenantId,
      actorId: null,
      action: 'vacancy.application_accepted',
      entity: 'vacancy_application',
      entityId: applicationId,
      after: { candidateId: created.candidate.id, assignmentId: assigned.assignmentId, vacancyId },
    })

    await enqueueNotification(tx, {
      tenantId,
      userId: created.candidate.id,
      code: 'vacancy_applied_welcome',
      channel: 'email',
      payload: { vacancy: vacancy.title },
      dedupKey: `vacancy_applied_welcome:${applicationId}`,
    }).catch(() => false)
    await notifyRecruiter(tx, tenantId, vacancy.recruiterId, vacancy.title, 'accepted')

    return { ok: true, state: 'accepted', candidateId: created.candidate.id, assignmentId: assigned.assignmentId }
  }).catch((err) => {
    console.error('[vacancy.apply] транзакция §7.20 откатилась', applicationId, err)
    return { ok: false, code: 'failed' } as ConvertResult
  })
}

/**
 * «Ім'я та прізвище» одним полем (§6.3) → две колонки карточки. Первое слово — имя, остальное —
 * фамилия: так подписан сам контрол на эталоне, и переставлять слова за человека нельзя.
 * Отчество из публичной формы не собирается вовсе — его там не спрашивают.
 */
export function splitFullName(value: string): { firstName: string, lastName: string } {
  const words = value.trim().split(/\s+/).filter(Boolean)
  const firstName = words[0] ?? value.trim()
  const lastName = words.slice(1).join(' ') || firstName
  return { firstName, lastName }
}

async function notifyRecruiter(tx: TenantTx, tenantId: string, recruiterId: string | null, title: string, outcome: string): Promise<void> {
  if (!recruiterId) return
  await enqueueNotification(tx, {
    tenantId,
    userId: recruiterId,
    code: 'vacancy_application_received',
    payload: { vacancy: title, outcome },
  }).catch(() => false)
}

/** Отклик, который не стал кандидатом, не теряется: он ждёт человека с явной причиной (§12.2). */
async function holdApplication(tenantId: string, actorId: string, applicationId: string, reason: string): Promise<void> {
  await withTenant(tenantId, actorId || null, tx => tx.update(vacancyApplications).set({
    state: 'pending_review',
    spamReasons: sql`array_append(${vacancyApplications.spamReasons}, ${reason})`,
    updatedAt: new Date(),
  }).where(eq(vacancyApplications.id, applicationId)))
}

// ── Кабинет рекрутера (§5.5, §10) ─────────────────────────────────────────────────────────

export interface Ctx { tenantId: string, actorId: string }

export interface ApplicationRow {
  id: string
  state: string
  fullName: string
  phone: string | null
  email: string | null
  comment: string | null
  source: string
  sourceDetail: string | null
  spamScore: number
  spamReasons: string[]
  candidateId: string | null
  otpConfirmedAt: Date | null
  createdAt: Date
}

const APP_COLUMNS = {
  id: vacancyApplications.id,
  state: vacancyApplications.state,
  fullName: vacancyApplications.fullName,
  phone: vacancyApplications.phone,
  email: vacancyApplications.email,
  comment: vacancyApplications.comment,
  source: vacancyApplications.source,
  sourceDetail: vacancyApplications.sourceDetail,
  spamScore: vacancyApplications.spamScore,
  spamReasons: vacancyApplications.spamReasons,
  candidateId: vacancyApplications.candidateId,
  otpConfirmedAt: vacancyApplications.otpConfirmedAt,
  createdAt: vacancyApplications.createdAt,
}

/** Отклики вакансии (`GET /vacancies/:id/applications`). Чужая вакансия — `404` (правило 15). */
export async function listApplications(ctx: Ctx, vacancyId: string, filter: { state?: string, limit: number }): Promise<ApplicationRow[] | null> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [v] = await tx.select({ id: vacancies.id }).from(vacancies).where(eq(vacancies.id, vacancyId))
    if (!v) return null
    const rows = await tx.select(APP_COLUMNS).from(vacancyApplications)
      .where(filter.state
        ? and(eq(vacancyApplications.vacancyId, vacancyId), eq(vacancyApplications.state, filter.state))
        : eq(vacancyApplications.vacancyId, vacancyId))
      .orderBy(desc(vacancyApplications.createdAt))
      .limit(filter.limit)
    return rows as unknown as ApplicationRow[]
  })
}

export type ReviewResult =
  | { ok: true, state: string, candidateId?: string }
  | { ok: false, code: 'not_found' | 'wrong_state' | 'limit' | 'no_course' | 'failed' }

/**
 * Принять придержанный отклик вручную (`POST …/applications/:aid/accept`). Решение о
 * человеке принимает человек: ни одна проверка §7.6–§7.7 не отказывает кандидату сама
 * (инвариант 18 пакета) — она лишь показывает отклик рекрутеру.
 */
export async function acceptApplication(ctx: Ctx, vacancyId: string, applicationId: string): Promise<ReviewResult> {
  const owner = await ownerOf(ctx, vacancyId, applicationId)
  if (!owner) return { ok: false, code: 'not_found' }
  const r = await convertApplication(ctx.tenantId, ctx.actorId, vacancyId, applicationId, { actorId: ctx.actorId })
  if (!r.ok) return { ok: false, code: r.code === 'wrong_state' ? 'wrong_state' : r.code }
  await markReviewed(ctx, applicationId)
  return { ok: true, state: r.state, candidateId: r.candidateId }
}

/** Отказ по отклику (`POST …/applications/:aid/reject`): причина обязательна. */
export async function rejectApplication(ctx: Ctx, vacancyId: string, applicationId: string, reason: string): Promise<ReviewResult> {
  return setReviewState(ctx, vacancyId, applicationId, 'rejected', reason)
}

/** Пометка «спам» (`POST …/applications/:aid/spam`): человеку ничего не уходит (§7.7). */
export async function markSpamApplication(ctx: Ctx, vacancyId: string, applicationId: string): Promise<ReviewResult> {
  return setReviewState(ctx, vacancyId, applicationId, 'spam', null)
}

async function setReviewState(ctx: Ctx, vacancyId: string, applicationId: string, state: 'rejected' | 'spam', reason: string | null): Promise<ReviewResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [v] = await tx.select({ id: vacancies.id }).from(vacancies).where(eq(vacancies.id, vacancyId))
    if (!v) return { ok: false as const, code: 'not_found' as const }
    const [row] = await tx.update(vacancyApplications).set({
      state,
      rejectReason: reason,
      reviewedBy: ctx.actorId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(vacancyApplications.id, applicationId), eq(vacancyApplications.vacancyId, vacancyId)))
      .returning({ id: vacancyApplications.id })
    if (!row) return { ok: false as const, code: 'not_found' as const }
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: `vacancy.application_${state}`,
      entity: 'vacancy_application',
      entityId: applicationId,
      after: { state, reason },
    })
    return { ok: true as const, state }
  })
}

async function ownerOf(ctx: Ctx, vacancyId: string, applicationId: string): Promise<boolean> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select({ id: vacancyApplications.id }).from(vacancyApplications)
      .where(and(eq(vacancyApplications.id, applicationId), eq(vacancyApplications.vacancyId, vacancyId)))
    return Boolean(row)
  })
}

async function markReviewed(ctx: Ctx, applicationId: string): Promise<void> {
  await withTenant(ctx.tenantId, ctx.actorId, tx => tx.update(vacancyApplications)
    .set({ reviewedBy: ctx.actorId, reviewedAt: new Date(), updatedAt: new Date() })
    .where(eq(vacancyApplications.id, applicationId)))
}

// ── Фоновые задачи (§11) ──────────────────────────────────────────────────────────────────

/**
 * `vacancy.application_expire` — ежечасно (§11, критерий §13 к. 6).
 *
 * Отклик без подтверждённого кода старше суток уходит в `expired`: кандидат не создан, ось
 * `candidates_active` не тронута (он её и не занимал — кандидата не было), временное резюме
 * удаляется. Перевод идёт одним `update` по индексу `(tenant_id, vacancy_id, state, …)`.
 */
export async function expireApplications(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      update vacancy_applications
         set state = 'expired', updated_at = now()
       where state = 'pending' and otp_confirmed_at is null
         and created_at < now() - make_interval(hours => ${VACANCY_APPLY_EXPIRE_HOURS})
      returning id, resume_asset_id
    `) as unknown as { id: string, resume_asset_id: string | null }[]
    for (const row of rows) {
      if (!row.resume_asset_id) continue
      // Файл неподтверждённого отклика — та же уборка, что у остальных файлов хранилища
      // (`docs/v2/34`), второго механизма удаления здесь не заводится.
      const { softDeleteMedia } = await import('./media')
      await softDeleteMedia({ tenantId, actorId: null as unknown as string }, row.resume_asset_id, { reason: 'application_expired' }).catch(() => null)
    }
    return rows.length
  })
}

/** `vacancy.attempts_gc` — ежедневно 03:40 (§11): журнал попыток старше 30 дней не нужен никому. */
export async function pruneApplyAttempts(tenantId: string, days = 30): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      delete from public_apply_attempts
       where created_at < now() - make_interval(days => ${days})
      returning id
    `) as unknown as { id: string }[]
    return rows.length
  })
}

/** Счётчик кандидатов в работе по вакансии — через репозиторный слой людей (правило 17). */
export async function candidatesOfVacancy(ctx: Ctx, vacancyId: string): Promise<number> {
  const { candidates: candidatesQuery } = await import('./repo/people')
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await candidatesQuery(tx, { id: users.id }, eq(users.vacancyId, vacancyId))
    return rows.length
  })
}
