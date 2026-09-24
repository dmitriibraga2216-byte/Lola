import { randomBytes } from 'node:crypto'
import { and, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm'
import {
  candidateScores, courses, users, vacancies, vacancyCriteria, vacancyCriterionScores,
  vacancyLanguages,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { VACANCY_REOPEN_DAYS, VACANCY_TOKEN_LENGTH } from '../../shared/enums'
import type { VacancyState } from '../../shared/enums'
import { assignmentCreateSchema } from '../../shared/schemas/assignments'
import {
  EMPTY_ASSIGNMENT_TEMPLATE, vacancyAssignmentTemplateSchema,
} from '../../shared/schemas/vacancies'
import type {
  VacancyAssignmentTemplate, VacancyCloseInput, VacancyCreateInput, VacancyCriterionInput,
  VacancyCriterionScoresInput, VacancyCriterionUpdateInput, VacancyLanguageInput,
  VacancyListFilter, VacancyUpdateInput,
} from '../../shared/schemas/vacancies'
import { candidates as candidatesQuery } from './repo/people'
import { recordAudit } from './audit'
import { createAssignmentTx } from './assignments'

/**
 * Вакансии: реестр, состояния, критерии оценки, шаблон параметров назначения
 * (docs/v2/29-vacancies.md §3–§7, план docs/v2/45-plan.md PR-15).
 *
 * **Инвариант 1 документа `29`, он же правило 11 CLAUDE.md: вакансия не носитель правил
 * прохождения.** Она знает, какой курс назначить откликнувшемуся и с какими параметрами, но
 * параметры лежат в ней шаблоном, а применяются созданием обычной `assignments` —
 * `assignFromVacancy()` ниже. После создания назначения правки вакансии на него не влияют:
 * пути «переписать чужое назначение» нет ни в UI, ни в API (§7.12, критерий §13 к. 8).
 *
 * Отсюда же — ни одной собственной фильтрации ключей `params`: шаблон уходит в
 * `createAssignmentTx()`, а тот режет ключи единственным фильтром `stageParamsFor()`
 * (PR-06, `server/services/taskParams.ts`). Второй точки решения о параметрах в продукте нет.
 *
 * Критерии оценки (§3.3) ничего не блокируют: их единственный выход — свёртка в одну строку
 * `candidate_scores` с `kind='recruiter'`. `is_critical` даёт предупреждение, а не стоп:
 * жёсткий стоп-фактор был бы автоматизированным решением о человеке (инвариант 18).
 *
 * Чего здесь нет: публичной страницы и отклика (PR-16), AI-генерации текста и критериев
 * (PR-16/17), площадок и публикаций (PR-17) — у каждого свой PR плана.
 */

export interface Ctx { tenantId: string, actorId: string }

/**
 * Кто смотрит реестр (`29` §2). `locations = null` — вся сеть (`vacancy.view` на тенант:
 * HR, админ, рекрутер сети). Непустой массив — роль с областью «точка»: керівник точки видит
 * вакансии своей точки, рекрутер — свои плюс свои точки. Чужая вакансия не существует:
 * `404`, не `403` (CLAUDE.md п. 15, критерий §13 к. 14).
 */
export interface Viewer extends Ctx {
  locations: string[] | null
}

export function viewerOf(access: { userId: string, tenantId: string, grants: { scopes: string[], scopeType: string, scopeId: string | null }[] }): Viewer {
  const withView = access.grants.filter(g => g.scopes.includes('vacancy.view'))
  const tenantWide = withView.some(g => g.scopeType === 'tenant')
  return {
    tenantId: access.tenantId,
    actorId: access.userId,
    locations: tenantWide ? null : withView.filter(g => g.scopeType === 'location' && g.scopeId).map(g => g.scopeId!),
  }
}

/**
 * Область видимости: сеть — всё; точка — вакансии своих точек **или** те, где смотрящий
 * назначен рекрутером (§2 «рекрутер ✓ свои + своих точек»).
 */
export function scopeCond(v: Viewer) {
  if (v.locations === null) return undefined
  if (!v.locations.length) return eq(vacancies.recruiterId, v.actorId)
  return or(inArray(vacancies.locationId, v.locations), eq(vacancies.recruiterId, v.actorId))
}

export interface VacancyRow {
  id: string
  title: string
  state: VacancyState
  categoryId: string | null
  recruiterId: string | null
  recruiterName: string | null
  courseId: string | null
  courseTitle: string | null
  courseVersionId: string | null
  locationId: string | null
  orgUnitId: string | null
  positionId: string | null
  employmentType: string | null
  workFormat: string | null
  countryCode: string | null
  city: string | null
  experienceLevel: string | null
  educationLevel: string | null
  salaryFrom: string | null
  salaryTo: string | null
  salaryCurrency: string
  salaryVisible: boolean
  publicEnabled: boolean
  publicToken: string | null
  publicApplyOtp: boolean
  /** Язык публичной страницы (`29` §7.20); `null` — язык пространства. */
  publicLanguage: string | null
  applyDailyCap: number
  sourceBudget: string | null
  templateId: string | null
  publishedAt: Date | null
  closedAt: Date | null
  closeReason: string | null
  createdAt: Date
  updatedAt: Date
  /** Кандидатов в работе по этой вакансии — счётчик §7.12 «Кандидатів у роботі: N». */
  candidatesInProgress: number
}

const COLUMNS = {
  id: vacancies.id,
  title: vacancies.title,
  state: vacancies.state,
  categoryId: vacancies.categoryId,
  recruiterId: vacancies.recruiterId,
  courseId: vacancies.courseId,
  courseVersionId: vacancies.courseVersionId,
  locationId: vacancies.locationId,
  orgUnitId: vacancies.orgUnitId,
  positionId: vacancies.positionId,
  employmentType: vacancies.employmentType,
  workFormat: vacancies.workFormat,
  countryCode: vacancies.countryCode,
  city: vacancies.city,
  experienceLevel: vacancies.experienceLevel,
  educationLevel: vacancies.educationLevel,
  salaryFrom: vacancies.salaryFrom,
  salaryTo: vacancies.salaryTo,
  salaryCurrency: vacancies.salaryCurrency,
  salaryVisible: vacancies.salaryVisible,
  publicEnabled: vacancies.publicEnabled,
  publicToken: vacancies.publicToken,
  publicApplyOtp: vacancies.publicApplyOtp,
  publicLanguage: vacancies.publicLanguage,
  applyDailyCap: vacancies.applyDailyCap,
  sourceBudget: vacancies.sourceBudget,
  templateId: vacancies.templateId,
  publishedAt: vacancies.publishedAt,
  closedAt: vacancies.closedAt,
  closeReason: vacancies.closeReason,
  createdAt: vacancies.createdAt,
  updatedAt: vacancies.updatedAt,
  /**
   * ФИО рекрутера и название курса — подзапросами, а не соединениями: соединение с `users`
   * ради одного имени запутало бы сканер П-16.1, а выборка по первичному ключу фильтра по
   * виду человека не требует — рекрутер всегда сотрудник, и это обеспечено при записи.
   */
  recruiterName: sql<string | null>`(select u2.full_name from users u2 where u2.id = ${sql.raw('vacancies.recruiter_id')})`,
  courseTitle: sql<string | null>`(select c.title from courses c where c.id = ${sql.raw('vacancies.course_id')})`,
  /**
   * Кандидаты в работе — те, кто откликнулся и ещё проходит отбор (§7.12).
   *
   * Внешняя колонка названа **полным именем таблицы** (`sql.raw`), а не подстановкой
   * объекта колонки: Drizzle рендерит её в `sql` без квалификатора (`"id"`), а внутри
   * подзапроса выигрывает ближняя область видимости — условие тихо превращается в
   * `cu.vacancy_id = cu.id` и всегда даёт ноль. Ошибка не падает, а молча врёт числом.
   */
  candidatesInProgress: sql<number>`(
    select count(*)::int from users cu
     where cu.vacancy_id = vacancies.id and cu.kind = 'candidate' and cu.candidate_state = 'active'
  )`,
}

export interface CriterionRow {
  id: string
  vacancyId: string
  name: string
  description: string | null
  weight: string
  scaleMin: string
  scaleMax: string
  isCritical: boolean
  origin: string
  sort: number
  isActive: boolean
}

export interface LanguageRow {
  id: string
  langCode: string
  level: string
  isRequired: boolean
  sort: number
}

export interface VacancyCard extends VacancyRow {
  descriptionHtml: string | null
  requirementsHtml: string | null
  dutiesHtml: string | null
  extraHtml: string | null
  aiBlocks: Record<string, unknown>
  assignmentTemplate: VacancyAssignmentTemplate
  criteria: CriterionRow[]
  languages: LanguageRow[]
}

// ── Публичный токен (§7.2) ────────────────────────────────────────────────────────────────

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * 22 знака base62 из криптоисточника (≈132 бита, §7.2). Отбрасывание байтов вне диапазона —
 * не «лишняя строгость», а условие равномерности: `% 62` от случайного байта даёт первым
 * двум знакам алфавита лишний шанс, и перебор токенов из-за этого дешевеет.
 */
export function newPublicToken(length = VACANCY_TOKEN_LENGTH): string {
  let out = ''
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b >= 248) continue
      out += BASE62[b % 62]
      if (out.length === length) break
    }
  }
  return out
}

// ── Реестр и карточка ─────────────────────────────────────────────────────────────────────

export async function listVacancies(v: Viewer, filter: VacancyListFilter): Promise<VacancyRow[]> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const q = filter.q?.trim()
    const conds = [
      scopeCond(v),
      filter.state ? eq(vacancies.state, filter.state) : undefined,
      filter.locationId ? eq(vacancies.locationId, filter.locationId) : undefined,
      filter.orgUnitId ? eq(vacancies.orgUnitId, filter.orgUnitId) : undefined,
      filter.recruiterId ? eq(vacancies.recruiterId, filter.recruiterId) : undefined,
      filter.categoryId ? eq(vacancies.categoryId, filter.categoryId) : undefined,
      filter.courseId ? eq(vacancies.courseId, filter.courseId) : undefined,
      filter.from ? gte(vacancies.createdAt, new Date(`${filter.from}T00:00:00Z`)) : undefined,
      filter.to ? lte(vacancies.createdAt, new Date(`${filter.to}T23:59:59Z`)) : undefined,
      q ? sql`${vacancies.title} ilike ${`%${q}%`}` : undefined,
    ].filter(Boolean)
    return await tx.select(COLUMNS).from(vacancies)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(vacancies.updatedAt))
      .limit(filter.limit) as unknown as VacancyRow[]
  })
}

async function rowById(tx: TenantTx, v: Viewer, id: string): Promise<VacancyRow | null> {
  const cond = scopeCond(v)
  const [row] = await tx.select(COLUMNS).from(vacancies)
    .where(cond ? and(eq(vacancies.id, id), cond) : eq(vacancies.id, id))
  return (row as unknown as VacancyRow) ?? null
}

/** Карточка вакансии с критериями и языками (`29` §10 `GET /vacancies/:id`). */
export async function getVacancy(v: Viewer, id: string): Promise<VacancyCard | null> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const row = await rowById(tx, v, id)
    if (!row) return null
    const [full] = await tx.select({
      descriptionHtml: vacancies.descriptionHtml,
      requirementsHtml: vacancies.requirementsHtml,
      dutiesHtml: vacancies.dutiesHtml,
      extraHtml: vacancies.extraHtml,
      aiBlocks: vacancies.aiBlocks,
      assignmentTemplate: vacancies.assignmentTemplate,
    }).from(vacancies).where(eq(vacancies.id, id))
    return {
      ...row,
      descriptionHtml: full?.descriptionHtml ?? null,
      requirementsHtml: full?.requirementsHtml ?? null,
      dutiesHtml: full?.dutiesHtml ?? null,
      extraHtml: full?.extraHtml ?? null,
      aiBlocks: (full?.aiBlocks ?? {}) as Record<string, unknown>,
      assignmentTemplate: templateOf(full?.assignmentTemplate),
      criteria: await criteriaOf(tx, id),
      languages: await languagesOf(tx, id),
    }
  })
}

/**
 * Шаблон из БД — всегда через zod (`29` §3.5: «неизвестные отбрасываются zod-схемой»).
 * Разбор в одном месте: строка могла быть записана старой версией формы или миграцией, и
 * доверять её форме без проверки нельзя.
 */
export function templateOf(raw: unknown): VacancyAssignmentTemplate {
  const parsed = vacancyAssignmentTemplateSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : EMPTY_ASSIGNMENT_TEMPLATE
}

async function criteriaOf(tx: TenantTx, vacancyId: string): Promise<CriterionRow[]> {
  return await tx.select({
    id: vacancyCriteria.id,
    vacancyId: vacancyCriteria.vacancyId,
    name: vacancyCriteria.name,
    description: vacancyCriteria.description,
    weight: vacancyCriteria.weight,
    scaleMin: vacancyCriteria.scaleMin,
    scaleMax: vacancyCriteria.scaleMax,
    isCritical: vacancyCriteria.isCritical,
    origin: vacancyCriteria.origin,
    sort: vacancyCriteria.sort,
    isActive: vacancyCriteria.isActive,
  }).from(vacancyCriteria).where(eq(vacancyCriteria.vacancyId, vacancyId)).orderBy(vacancyCriteria.sort) as CriterionRow[]
}

async function languagesOf(tx: TenantTx, vacancyId: string): Promise<LanguageRow[]> {
  return await tx.select({
    id: vacancyLanguages.id,
    langCode: vacancyLanguages.langCode,
    level: vacancyLanguages.level,
    isRequired: vacancyLanguages.isRequired,
    sort: vacancyLanguages.sort,
  }).from(vacancyLanguages).where(eq(vacancyLanguages.vacancyId, vacancyId)).orderBy(vacancyLanguages.sort) as LanguageRow[]
}

// ── Создание и правка ─────────────────────────────────────────────────────────────────────

const num = (v: number | null | undefined) => (v === null || v === undefined ? null : String(v))

function writableFields(input: VacancyCreateInput | VacancyUpdateInput) {
  const o: Record<string, unknown> = {}
  const set = <K extends string>(k: K, value: unknown) => { if (value !== undefined) o[k] = value }
  set('title', input.title)
  set('categoryId', input.categoryId)
  set('recruiterId', input.recruiterId)
  set('courseId', input.courseId)
  set('locationId', input.locationId)
  set('orgUnitId', input.orgUnitId)
  set('positionId', input.positionId)
  set('descriptionHtml', input.descriptionHtml)
  set('requirementsHtml', input.requirementsHtml)
  set('dutiesHtml', input.dutiesHtml)
  set('extraHtml', input.extraHtml)
  set('employmentType', input.employmentType)
  set('workFormat', input.workFormat)
  set('countryCode', input.countryCode)
  set('city', input.city)
  set('experienceLevel', input.experienceLevel)
  set('educationLevel', input.educationLevel)
  set('salaryFrom', input.salaryFrom === undefined ? undefined : num(input.salaryFrom))
  set('salaryTo', input.salaryTo === undefined ? undefined : num(input.salaryTo))
  set('salaryCurrency', input.salaryCurrency)
  set('salaryVisible', input.salaryVisible)
  set('assignmentTemplate', input.assignmentTemplate)
  set('publicApplyOtp', input.publicApplyOtp)
  set('publicLanguage', input.publicLanguage)
  set('applyDailyCap', input.applyDailyCap)
  set('sourceBudget', input.sourceBudget === undefined ? undefined : num(input.sourceBudget))
  return o
}

async function replaceLanguages(tx: TenantTx, tenantId: string, vacancyId: string, langs: VacancyLanguageInput[]) {
  await tx.delete(vacancyLanguages).where(eq(vacancyLanguages.vacancyId, vacancyId))
  if (!langs.length) return
  await tx.insert(vacancyLanguages).values(langs.map((l, i) => ({
    tenantId, vacancyId, langCode: l.langCode, level: l.level, isRequired: l.isRequired, sort: l.sort || i,
  })))
}

/**
 * Создание (`29` §10 `POST /vacancies`). Вакансия всегда рождается черновиком: публикация —
 * явное действие со своими проверками (§4, Г-29.2), а не побочный эффект сохранения.
 */
export async function createVacancy(ctx: Ctx, input: VacancyCreateInput): Promise<VacancyCard> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.insert(vacancies).values({
      ...writableFields(input),
      tenantId: ctx.tenantId,
      title: input.title,
      state: 'draft',
      recruiterId: input.recruiterId ?? ctx.actorId,
      createdBy: ctx.actorId,
    } as typeof vacancies.$inferInsert).returning({ id: vacancies.id })
    await replaceLanguages(tx, ctx.tenantId, row!.id, input.languages ?? [])
    await recordAudit(tx, {
      tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'vacancy.create',
      entity: 'vacancy', entityId: row!.id, after: { title: input.title },
    })
    const v: Viewer = { ...ctx, locations: null }
    const created = await rowById(tx, v, row!.id)
    return {
      ...created!,
      descriptionHtml: input.descriptionHtml ?? null,
      requirementsHtml: input.requirementsHtml ?? null,
      dutiesHtml: input.dutiesHtml ?? null,
      extraHtml: input.extraHtml ?? null,
      aiBlocks: {},
      assignmentTemplate: templateOf(input.assignmentTemplate),
      criteria: [],
      languages: await languagesOf(tx, row!.id),
    }
  })
}

export type UpdateResult =
  | { ok: true, vacancy: VacancyCard }
  | { ok: false, code: 'not_found' }
  | { ok: false, code: 'conflict', vacancy: VacancyCard }
  | { ok: false, code: 'state_locked' }

/**
 * Правка (`29` §7.12). **Созданные назначения не трогает — вообще никак.** Изменение
 * `assignmentTemplate`, `courseId` или версии курса действует только на отклики после
 * сохранения; ответ несёт `candidatesInProgress`, чтобы форма написала «Зміни вплинуть лише
 * на нові відгуки. Кандидатів у роботі: N» (критерий §13 к. 8).
 *
 * Архивная вакансия не правится: она ушла из реестра, и правка там — способ тихо изменить
 * историю (§4 разрешает из `archived` только восстановление админом в `draft`).
 */
export async function updateVacancy(v: Viewer, id: string, input: VacancyUpdateInput): Promise<UpdateResult> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const before = await rowById(tx, v, id)
    if (!before) return { ok: false, code: 'not_found' } as UpdateResult
    if (before.state === 'archived') return { ok: false, code: 'state_locked' } as UpdateResult
    if (input.updatedAt && new Date(input.updatedAt).getTime() !== before.updatedAt.getTime()) {
      return { ok: false, code: 'conflict', vacancy: await cardOf(tx, before) } as UpdateResult
    }
    const fields = writableFields(input)
    if (Object.keys(fields).length) {
      await tx.update(vacancies).set({ ...fields, updatedAt: new Date() } as Partial<typeof vacancies.$inferInsert>)
        .where(eq(vacancies.id, id))
    }
    if (input.languages) await replaceLanguages(tx, v.tenantId, id, input.languages)
    await recordAudit(tx, {
      tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.update', entity: 'vacancy', entityId: id,
      before: { title: before.title, courseId: before.courseId },
      after: { changed: Object.keys(fields) },
    })
    const after = await rowById(tx, v, id)
    return { ok: true, vacancy: await cardOf(tx, after!) } as UpdateResult
  })
}

async function cardOf(tx: TenantTx, row: VacancyRow): Promise<VacancyCard> {
  const [full] = await tx.select({
    descriptionHtml: vacancies.descriptionHtml,
    requirementsHtml: vacancies.requirementsHtml,
    dutiesHtml: vacancies.dutiesHtml,
    extraHtml: vacancies.extraHtml,
    aiBlocks: vacancies.aiBlocks,
    assignmentTemplate: vacancies.assignmentTemplate,
  }).from(vacancies).where(eq(vacancies.id, row.id))
  return {
    ...row,
    descriptionHtml: full?.descriptionHtml ?? null,
    requirementsHtml: full?.requirementsHtml ?? null,
    dutiesHtml: full?.dutiesHtml ?? null,
    extraHtml: full?.extraHtml ?? null,
    aiBlocks: (full?.aiBlocks ?? {}) as Record<string, unknown>,
    assignmentTemplate: templateOf(full?.assignmentTemplate),
    criteria: await criteriaOf(tx, row.id),
    languages: await languagesOf(tx, row.id),
  }
}

// ── Состояния (§4) ────────────────────────────────────────────────────────────────────────

export type TransitionResult =
  | { ok: true, vacancy: VacancyCard }
  | { ok: false, code: 'not_found' }
  | { ok: false, code: 'link_requirements', missing: string[] }
  | { ok: false, code: 'ai_text_unreviewed', blocks: string[] }
  | { ok: false, code: 'wrong_state', state: VacancyState }
  | { ok: false, code: 'reopen_expired' }
  | { ok: false, code: 'has_candidates', count: number }

/**
 * Чего не хватает для публичной ссылки (§7.1). Тот же перечень, что в констрейнте
 * `vacancies_public_chk`, — но с именами полей, чтобы форма подсветила именно их. Констрейнт
 * остаётся последней линией: он ловит и прямой UPDATE мимо сервиса (критерий §13 к. 1).
 */
export function missingForPublish(row: VacancyRow): string[] {
  const missing: string[] = []
  if (!row.courseId) missing.push('courseId')
  if (!row.locationId) missing.push('locationId')
  if (!row.recruiterId) missing.push('recruiterId')
  if (!row.title || row.title.trim().length < 3) missing.push('title')
  return missing
}

/**
 * Блоки, в которых стоит непроверенный AI-текст (§7.9): нет ни правки человеком, ни нажатия
 * «Текст перевірено». Публикация с таким текстом запрещена — компания отвечает за то, что
 * написано на её публичной странице, а не модель.
 */
export function unreviewedAiBlocks(aiBlocks: Record<string, unknown>): string[] {
  return Object.entries(aiBlocks ?? {})
    .filter(([, meta]) => {
      const m = (meta ?? {}) as { editedAt?: string | null, acknowledged?: boolean }
      return !m.editedAt && !m.acknowledged
    })
    .map(([k]) => k)
}

/**
 * Публикация (§4, §7.1, §7.9). Из `draft` и `paused` — тот же токен; из `closed` —
 * **новый**: старая ссылка расходится по чатам и агрегаторам, и пришедший через полгода
 * должен видеть «вакансію закрито», а не форму на позицию с другими условиями. Переоткрытие
 * позже 90 дней запрещено — за такой срок позиция меняется целиком.
 */
export async function publishVacancy(v: Viewer, id: string): Promise<TransitionResult> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const row = await rowById(tx, v, id)
    if (!row) return { ok: false, code: 'not_found' } as TransitionResult
    if (!['draft', 'paused', 'closed'].includes(row.state)) return { ok: false, code: 'wrong_state', state: row.state } as TransitionResult

    const missing = missingForPublish(row)
    if (missing.length) return { ok: false, code: 'link_requirements', missing } as TransitionResult

    const [full] = await tx.select({ aiBlocks: vacancies.aiBlocks }).from(vacancies).where(eq(vacancies.id, id))
    const blocks = unreviewedAiBlocks((full?.aiBlocks ?? {}) as Record<string, unknown>)
    if (blocks.length) return { ok: false, code: 'ai_text_unreviewed', blocks } as TransitionResult

    const reopen = row.state === 'closed'
    if (reopen && row.closedAt && Date.now() - row.closedAt.getTime() > VACANCY_REOPEN_DAYS * 86_400_000) {
      return { ok: false, code: 'reopen_expired' } as TransitionResult
    }

    // Версия курса фиксируется на момент публикации: правка курса не меняет отбор на лету (§3.1).
    const [c] = await tx.select({ v: courses.publishedVersionId }).from(courses).where(eq(courses.id, row.courseId!))
    await tx.update(vacancies).set({
      state: 'published',
      publicToken: reopen || !row.publicToken ? newPublicToken() : row.publicToken,
      publicEnabled: true,
      courseVersionId: c?.v ?? row.courseVersionId,
      publishedAt: row.publishedAt ?? new Date(),
      closedAt: null,
      closeReason: null,
      updatedAt: new Date(),
    }).where(eq(vacancies.id, id))
    await recordAudit(tx, {
      tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.publish', entity: 'vacancy', entityId: id,
      before: { state: row.state }, after: { state: 'published', reopened: reopen },
    })
    return { ok: true, vacancy: await cardOf(tx, (await rowById(tx, v, id))!) } as TransitionResult
  })
}

/**
 * Приостановка (§4). Публикации на площадках **не снимаются**: снятие и повторная постановка
 * стоят денег и теряют позицию в выдаче. Публичная страница отдаёт 410 с подпиской —
 * это работа публичного контура (PR-16), здесь только состояние.
 */
export async function pauseVacancy(v: Viewer, id: string): Promise<TransitionResult> {
  return transition(v, id, ['published'], { state: 'paused' }, 'vacancy.pause')
}

/**
 * Закрытие (§4, §7.13 `28` §12.3). Прохождение кандидатов **не прерывается**: рекрутер
 * получает `vacancy.closed_with_candidates` и решает по каждому. Ссылка умирает: токен
 * снимается, `public_enabled = false` (критерий §13 к. 13).
 */
export async function closeVacancy(v: Viewer, id: string, input: VacancyCloseInput): Promise<TransitionResult & { candidates?: { id: string, fullName: string }[] }> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const row = await rowById(tx, v, id)
    if (!row) return { ok: false, code: 'not_found' } as TransitionResult
    if (!['published', 'paused'].includes(row.state)) return { ok: false, code: 'wrong_state', state: row.state } as TransitionResult

    const inProgress = await candidatesInProgress(tx, id)
    await tx.update(vacancies).set({
      state: 'closed', publicEnabled: false, publicToken: null,
      closedAt: new Date(), closeReason: input.reason, updatedAt: new Date(),
    }).where(eq(vacancies.id, id))
    await recordAudit(tx, {
      tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.close', entity: 'vacancy', entityId: id,
      before: { state: row.state }, after: { state: 'closed', reason: input.reason, reasonText: input.reasonText ?? null, candidates: inProgress.length },
    })
    return { ok: true, vacancy: await cardOf(tx, (await rowById(tx, v, id))!), candidates: inProgress }
  })
}

/**
 * Архивация (§4). Кандидаты в работе держат вакансию в реестре: убрать её из глаз, пока по
 * людям не принято решение, — значит потерять этих людей.
 */
export async function archiveVacancy(v: Viewer, id: string): Promise<TransitionResult> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const row = await rowById(tx, v, id)
    if (!row) return { ok: false, code: 'not_found' } as TransitionResult
    if (!['draft', 'closed'].includes(row.state)) return { ok: false, code: 'wrong_state', state: row.state } as TransitionResult
    const inProgress = await candidatesInProgress(tx, id)
    if (inProgress.length) return { ok: false, code: 'has_candidates', count: inProgress.length } as TransitionResult
    await tx.update(vacancies).set({ state: 'archived', publicEnabled: false, publicToken: null, updatedAt: new Date() }).where(eq(vacancies.id, id))
    await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.archive', entity: 'vacancy', entityId: id, before: { state: row.state }, after: { state: 'archived' } })
    return { ok: true, vacancy: await cardOf(tx, (await rowById(tx, v, id))!) } as TransitionResult
  })
}

/** Смена токена (§7.8 «Оновити посилання»): старый умирает немедленно. */
export async function rotateToken(v: Viewer, id: string): Promise<TransitionResult> {
  return transition(v, id, ['published', 'paused'], { publicToken: newPublicToken() }, 'vacancy.rotate_token')
}

async function transition(
  v: Viewer, id: string, from: VacancyState[],
  patch: Partial<typeof vacancies.$inferInsert>, action: string,
): Promise<TransitionResult> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const row = await rowById(tx, v, id)
    if (!row) return { ok: false, code: 'not_found' } as TransitionResult
    if (!from.includes(row.state)) return { ok: false, code: 'wrong_state', state: row.state } as TransitionResult
    await tx.update(vacancies).set({ ...patch, updatedAt: new Date() }).where(eq(vacancies.id, id))
    await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action, entity: 'vacancy', entityId: id, before: { state: row.state }, after: patch as Record<string, unknown> })
    return { ok: true, vacancy: await cardOf(tx, (await rowById(tx, v, id))!) } as TransitionResult
  })
}

/** Кандидаты в работе по вакансии — всегда через репозиторный слой (правило 17). */
async function candidatesInProgress(tx: TenantTx, vacancyId: string): Promise<{ id: string, fullName: string }[]> {
  return await candidatesQuery(tx, { id: users.id, fullName: users.fullName },
    eq(users.vacancyId, vacancyId), eq(users.candidateState, 'active')) as { id: string, fullName: string }[]
}

// ── Критерии оценки (§3.3, §7.11) ─────────────────────────────────────────────────────────

export async function listCriteria(v: Viewer, vacancyId: string): Promise<CriterionRow[] | null> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    if (!await rowById(tx, v, vacancyId)) return null
    return criteriaOf(tx, vacancyId)
  })
}

export async function addCriterion(v: Viewer, vacancyId: string, input: VacancyCriterionInput): Promise<CriterionRow | 'not_found'> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    if (!await rowById(tx, v, vacancyId)) return 'not_found' as const
    const [row] = await tx.insert(vacancyCriteria).values({
      tenantId: v.tenantId, vacancyId, name: input.name, description: input.description ?? null,
      weight: String(input.weight), scaleMin: String(input.scaleMin), scaleMax: String(input.scaleMax),
      isCritical: input.isCritical, origin: input.origin, sort: input.sort, isActive: input.isActive,
    }).returning()
    await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.criterion.add', entity: 'vacancy_criterion', entityId: row!.id, after: { vacancyId, name: input.name, origin: input.origin } })
    return row as unknown as CriterionRow
  })
}

export async function updateCriterion(v: Viewer, vacancyId: string, criterionId: string, input: VacancyCriterionUpdateInput): Promise<CriterionRow | 'not_found' | 'bad_scale'> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    if (!await rowById(tx, v, vacancyId)) return 'not_found' as const
    const [before] = await tx.select().from(vacancyCriteria).where(and(eq(vacancyCriteria.id, criterionId), eq(vacancyCriteria.vacancyId, vacancyId)))
    if (!before) return 'not_found' as const
    const min = input.scaleMin ?? Number(before.scaleMin)
    const max = input.scaleMax ?? Number(before.scaleMax)
    if (max <= min) return 'bad_scale' as const
    const [row] = await tx.update(vacancyCriteria).set({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.weight === undefined ? {} : { weight: String(input.weight) }),
      ...(input.scaleMin === undefined ? {} : { scaleMin: String(input.scaleMin) }),
      ...(input.scaleMax === undefined ? {} : { scaleMax: String(input.scaleMax) }),
      ...(input.isCritical === undefined ? {} : { isCritical: input.isCritical }),
      ...(input.sort === undefined ? {} : { sort: input.sort }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      updatedAt: new Date(),
    }).where(eq(vacancyCriteria.id, criterionId)).returning()
    await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.criterion.update', entity: 'vacancy_criterion', entityId: criterionId, after: { vacancyId } })
    return row as unknown as CriterionRow
  })
}

export async function deleteCriterion(v: Viewer, vacancyId: string, criterionId: string): Promise<'ok' | 'not_found'> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    if (!await rowById(tx, v, vacancyId)) return 'not_found' as const
    const deleted = await tx.delete(vacancyCriteria)
      .where(and(eq(vacancyCriteria.id, criterionId), eq(vacancyCriteria.vacancyId, vacancyId))).returning({ id: vacancyCriteria.id })
    if (!deleted.length) return 'not_found' as const
    await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.criterion.delete', entity: 'vacancy_criterion', entityId: criterionId, before: { vacancyId } })
    return 'ok' as const
  })
}

// ── Свёртка баллов в оценку рекрутера (§3.3, критерий §13 к. 11) ──────────────────────────

export interface RollupItem {
  /** Балл по шкале критерия. */
  value: number
  weight: number
  scaleMin: number
  scaleMax: number
  isCritical?: boolean
  name?: string
}

/**
 * Свёртка баллов по критериям в одно число 0–10 (§3.3).
 *
 * Каждый балл нормируется к 0–10 как `(value − min) / (max − min) × 10`, итог —
 * `Σ(норм × weight) / Σ(weight)`, округление до 0.01. Формула зафиксирована здесь, а не на
 * фронтенде, именно ради воспроизводимости: число попадает в карточку человека и в решение
 * о найме, и «как посчитал браузер» — не ответ на вопрос «почему 6.80».
 *
 * Чистая функция без БД: её проверяет unit-тест на примере критерия приёмки §13 к. 11
 * (веса 3, 1, 1 и баллы 5, 2, 0 по шкале 0–5 → ровно 6.80).
 */
export function rollupCriterionScores(items: RollupItem[]): { value: number, criticalLow: string[] } {
  let sum = 0
  let weights = 0
  const criticalLow: string[] = []
  for (const it of items) {
    const span = it.scaleMax - it.scaleMin
    if (span <= 0 || it.weight <= 0) continue
    const norm = ((it.value - it.scaleMin) / span) * 10
    sum += norm * it.weight
    weights += it.weight
    // Предупреждение, а не запрет (§3.3): жёсткий стоп-фактор был бы решением о человеке.
    if (it.isCritical && it.value <= it.scaleMin) criticalLow.push(it.name ?? '')
  }
  const value = weights === 0 ? 0 : Math.round((sum / weights) * 100) / 100
  return { value, criticalLow }
}

export type CriterionScoresResult =
  | { ok: true, score: { id: string, valueNum: string | null }, criticalLow: string[], counted: number }
  | { ok: false, code: 'not_found' }
  | { ok: false, code: 'out_of_scale', criterionId: string }

/**
 * Сохранение баллов и пересчёт свёртки (§3.3, §10 `POST /candidates/:id/criterion-scores`).
 *
 * Одна транзакция: баллы по критериям, затем **одна** строка `candidate_scores` с
 * `kind='recruiter'`, а предыдущая строка того же вида теряет `is_current` (этого же требует
 * частичный уникальный индекс `uq_candidate_scores_current`). Балл вне шкалы своего критерия
 * — `422`, а не молчаливое обрезание: обрезанный балл выглядит как осознанная оценка.
 */
export async function saveCriterionScores(v: Viewer, candidateId: string, input: VacancyCriterionScoresInput): Promise<CriterionScoresResult> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [candidate] = await candidatesQuery(tx, { id: users.id, vacancyId: users.vacancyId }, eq(users.id, candidateId))
    if (!candidate) return { ok: false, code: 'not_found' } as CriterionScoresResult

    const ids = input.scores.map(s => s.criterionId)
    const criteria = await tx.select().from(vacancyCriteria).where(inArray(vacancyCriteria.id, ids))
    if (criteria.length !== new Set(ids).size) return { ok: false, code: 'not_found' } as CriterionScoresResult

    for (const s of input.scores) {
      const c = criteria.find(x => x.id === s.criterionId)!
      if (s.valueNum < Number(c.scaleMin) || s.valueNum > Number(c.scaleMax)) {
        return { ok: false, code: 'out_of_scale', criterionId: s.criterionId } as CriterionScoresResult
      }
    }

    for (const s of input.scores) {
      await tx.insert(vacancyCriterionScores).values({
        tenantId: v.tenantId, candidateId, criterionId: s.criterionId,
        valueNum: String(s.valueNum), comment: s.comment ?? null, authorId: v.actorId,
      }).onConflictDoUpdate({
        target: [vacancyCriterionScores.tenantId, vacancyCriterionScores.candidateId, vacancyCriterionScores.criterionId, vacancyCriterionScores.authorId],
        set: { valueNum: String(s.valueNum), comment: s.comment ?? null, updatedAt: new Date() },
      })
    }

    // Свёртка считается по всем сохранённым баллам кандидата, а не только по присланным:
    // второй рекрутер дооценивает того же человека, и итог обязан учитывать обе пачки.
    const all = await tx.select({
      value: vacancyCriterionScores.valueNum,
      weight: vacancyCriteria.weight,
      scaleMin: vacancyCriteria.scaleMin,
      scaleMax: vacancyCriteria.scaleMax,
      isCritical: vacancyCriteria.isCritical,
      name: vacancyCriteria.name,
    }).from(vacancyCriterionScores)
      .innerJoin(vacancyCriteria, eq(vacancyCriteria.id, vacancyCriterionScores.criterionId))
      .where(and(eq(vacancyCriterionScores.candidateId, candidateId), eq(vacancyCriteria.isActive, true)))

    const rollup = rollupCriterionScores(all.map(r => ({
      value: Number(r.value), weight: Number(r.weight), scaleMin: Number(r.scaleMin),
      scaleMax: Number(r.scaleMax), isCritical: r.isCritical, name: r.name,
    })))

    await tx.update(candidateScores)
      .set({ isCurrent: false, updatedAt: new Date() })
      .where(and(eq(candidateScores.candidateId, candidateId), eq(candidateScores.kind, 'recruiter'), eq(candidateScores.isCurrent, true)))

    const [score] = await tx.insert(candidateScores).values({
      tenantId: v.tenantId,
      candidateId,
      kind: 'recruiter',
      valueNum: rollup.value.toFixed(2),
      comment: `Оцінено за ${all.length} критеріями`,
      sourceType: 'vacancy_criteria',
      sourceId: candidate.vacancyId ?? null,
      authorId: v.actorId,
      isCurrent: true,
    }).returning({ id: candidateScores.id, valueNum: candidateScores.valueNum })

    await recordAudit(tx, {
      tenantId: v.tenantId, actorId: v.actorId, action: 'candidate.score', entity: 'candidate_score',
      entityId: score!.id, after: { candidateId, kind: 'recruiter', valueNum: rollup.value, criteria: all.length },
    })
    return { ok: true, score: score!, criticalLow: rollup.criticalLow, counted: all.length } as CriterionScoresResult
  })
}

// ── Применение шаблона: вакансия → обычное назначение (§3.5, §7.20) ───────────────────────

export type AssignResult =
  | { ok: true, assignmentId: string }
  | { ok: false, code: 'no_course' | 'subject_not_found' | 'empty_audience' | 'not_for_candidate' }

/**
 * **Единственный способ, которым шаблон вакансии превращается в правила прохождения**
 * (§3.5, §7.20, инвариант 1).
 *
 * Создаётся обычная `assignments`: `kind='manual'`, носитель — курс вакансии, версия —
 * зафиксированная при публикации, аудитория — один кандидат поимённо, `autoSync=false`,
 * метка `vacancy:<id>`. Дальше живёт назначение: вакансия может меняться сколько угодно, на
 * созданную строку это не влияет (§7.12, критерий §13 к. 8) — потому что второго пути,
 * который бы переписывал чужие `params`, в продукте нет.
 *
 * Ключи `params` режет `createAssignmentTx()` через `stageParamsFor()` — тот же фильтр по
 * типу контента и возможностям этапа, что у формы назначения (PR-06). Вакансия своей
 * фильтрации не имеет и иметь не должна: иначе правил стало бы два набора.
 */
export async function assignFromVacancy(tx: TenantTx, ctx: Ctx, vacancyId: string, candidateId: string): Promise<AssignResult> {
  const [row] = await tx.select({
    id: vacancies.id, title: vacancies.title, courseId: vacancies.courseId,
    courseVersionId: vacancies.courseVersionId, assignmentTemplate: vacancies.assignmentTemplate,
  }).from(vacancies).where(eq(vacancies.id, vacancyId))
  if (!row?.courseId) return { ok: false, code: 'no_course' }

  const template = templateOf(row.assignmentTemplate)
  const input = assignmentCreateSchema.parse({
    title: row.title,
    subjectType: 'course',
    subjectId: row.courseId,
    audience: { rules: [{ type: 'user', ids: [candidateId] }], match: 'any' },
    dueMode: template.dueMode,
    ...(template.dueMode === 'relative' && template.dueDays ? { dueDays: template.dueDays } : {}),
    isMandatory: template.isMandatory,
    params: template.params,
    reminders: { ...template.reminders, notifyOnAssign: template.notifyOnAssign },
    autoSync: false,
    tags: [`vacancy:${vacancyId}`],
    status: 'active',
  })
  const created = await createAssignmentTx(tx, ctx, input, { kind: 'manual' })
  if (!created.ok) return { ok: false, code: created.code }

  // Версия курса зафиксирована вакансией при публикации: отбор не меняется на лету (§3.1).
  if (row.courseVersionId) {
    const { assignments } = await import('../db/schema')
    await tx.update(assignments).set({ subjectVersionId: row.courseVersionId }).where(eq(assignments.id, created.assignmentId))
  }
  return { ok: true, assignmentId: created.assignmentId }
}
