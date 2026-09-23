import { and, asc, eq, sql } from 'drizzle-orm'
import { vacancies, vacancyCriteria, vacancyLanguages, vacancyTemplates } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { vacancyCreateSchema } from '../../shared/schemas/vacancies'
import type {
  VacancyCreateInput, VacancyTemplateFromVacancyInput, VacancyTemplateInput,
} from '../../shared/schemas/vacancies'
import { recordAudit } from './audit'
import { createVacancy } from './vacancies'
import type { Ctx, VacancyCard, Viewer } from './vacancies'

/**
 * Шаблоны вакансий (docs/v2/29-vacancies.md §3.4, §7.21, план PR-15).
 *
 * Шаблон — **самостоятельная сущность, а не вакансия-черновик**: иначе шаблоны попали бы в
 * реестр вакансий, в отчёты воронки и получили бы публичные ссылки. `criteria` и `languages`
 * лежат в самой строке, чтобы применение шло одной транзакцией.
 *
 * Чего в `payload` нет (§3.4): точки, рекрутера, токена, даты публикации, состояния и
 * статистики. Точка и рекрутер — свойство конкретного набора, а не позиции; остальное
 * принадлежит жизненному циклу вакансии, а не её описанию.
 */

const EXCLUDED_FROM_PAYLOAD = ['locationId', 'recruiterId'] as const

export interface TemplateRow {
  id: string
  name: string
  description: string | null
  payload: Partial<VacancyCreateInput>
  criteria: unknown[]
  languages: unknown[]
  usageCount: number
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

export async function listTemplates(ctx: Ctx, opts: { activeOnly?: boolean } = {}): Promise<TemplateRow[]> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(vacancyTemplates)
      .where(opts.activeOnly ? eq(vacancyTemplates.isActive, true) : undefined)
      .orderBy(asc(vacancyTemplates.name))
    return rows as unknown as TemplateRow[]
  })
}

export type TemplateResult = { ok: true, template: TemplateRow } | { ok: false, code: 'name_exists' | 'not_found' }

export async function createTemplate(ctx: Ctx, input: VacancyTemplateInput): Promise<TemplateResult> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    if (await nameTaken(tx, input.name)) return { ok: false, code: 'name_exists' } as TemplateResult
    const [row] = await tx.insert(vacancyTemplates).values({
      tenantId: ctx.tenantId,
      name: input.name,
      description: input.description ?? null,
      payload: stripExcluded(input.payload),
      criteria: input.criteria,
      languages: input.languages,
      createdBy: ctx.actorId,
    }).returning()
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'vacancy.template.create', entity: 'vacancy_template', entityId: row!.id, after: { name: input.name } })
    return { ok: true, template: row as unknown as TemplateRow } as TemplateResult
  })
}

/**
 * «Зберегти шаблон» из формы вакансии (§7.21). Снимает текущие значения вакансии, кроме
 * исключённых §3.4, вместе с её критериями и языками.
 */
export async function templateFromVacancy(v: Viewer, vacancyId: string, input: VacancyTemplateFromVacancyInput): Promise<TemplateResult> {
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const [row] = await tx.select().from(vacancies).where(eq(vacancies.id, vacancyId))
    if (!row) return { ok: false, code: 'not_found' } as TemplateResult
    if (await nameTaken(tx, input.name)) return { ok: false, code: 'name_exists' } as TemplateResult

    const payload = stripExcluded({
      title: row.title,
      categoryId: row.categoryId,
      courseId: row.courseId,
      orgUnitId: row.orgUnitId,
      positionId: row.positionId,
      descriptionHtml: row.descriptionHtml,
      requirementsHtml: row.requirementsHtml,
      dutiesHtml: row.dutiesHtml,
      extraHtml: row.extraHtml,
      employmentType: row.employmentType,
      workFormat: row.workFormat,
      countryCode: row.countryCode,
      city: row.city,
      experienceLevel: row.experienceLevel,
      educationLevel: row.educationLevel,
      salaryFrom: row.salaryFrom === null ? null : Number(row.salaryFrom),
      salaryTo: row.salaryTo === null ? null : Number(row.salaryTo),
      salaryCurrency: row.salaryCurrency,
      salaryVisible: row.salaryVisible,
      assignmentTemplate: row.assignmentTemplate,
      publicApplyOtp: row.publicApplyOtp,
      applyDailyCap: row.applyDailyCap,
    } as Record<string, unknown>)

    const criteria = await tx.select({
      name: vacancyCriteria.name, description: vacancyCriteria.description, weight: vacancyCriteria.weight,
      scaleMin: vacancyCriteria.scaleMin, scaleMax: vacancyCriteria.scaleMax,
      isCritical: vacancyCriteria.isCritical, sort: vacancyCriteria.sort,
    }).from(vacancyCriteria).where(and(eq(vacancyCriteria.vacancyId, vacancyId), eq(vacancyCriteria.isActive, true)))
    const languages = await tx.select({
      langCode: vacancyLanguages.langCode, level: vacancyLanguages.level,
      isRequired: vacancyLanguages.isRequired, sort: vacancyLanguages.sort,
    }).from(vacancyLanguages).where(eq(vacancyLanguages.vacancyId, vacancyId))

    const [created] = await tx.insert(vacancyTemplates).values({
      tenantId: v.tenantId,
      name: input.name,
      description: input.description ?? null,
      payload,
      // Происхождение критериев шаблона — `template`: в новой вакансии видно, откуда они.
      criteria: criteria.map(c => ({ ...c, weight: Number(c.weight), scaleMin: Number(c.scaleMin), scaleMax: Number(c.scaleMax), origin: 'template' })),
      languages,
      createdBy: v.actorId,
    }).returning()
    await recordAudit(tx, { tenantId: v.tenantId, actorId: v.actorId, action: 'vacancy.template.create', entity: 'vacancy_template', entityId: created!.id, after: { name: input.name, fromVacancy: vacancyId } })
    return { ok: true, template: created as unknown as TemplateRow } as TemplateResult
  })
}

export type FromTemplateResult = { ok: true, vacancy: VacancyCard } | { ok: false, code: 'not_found' | 'invalid_payload' }

/**
 * Создание вакансии из шаблона (§10 `POST /vacancies/from-template/:tid`). Точка и рекрутер
 * приходят телом: в шаблоне их нет (§3.4). Счётчик использований растёт — по нему §5.3
 * сортирует список шаблонов.
 */
export async function vacancyFromTemplate(ctx: Ctx, templateId: string, input: { locationId?: string | null, recruiterId?: string | null, title?: string }): Promise<FromTemplateResult> {
  const template = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [row] = await tx.select().from(vacancyTemplates).where(eq(vacancyTemplates.id, templateId))
    return row ?? null
  })
  if (!template) return { ok: false, code: 'not_found' }

  const parsed = vacancyCreateSchema.safeParse({
    ...(template.payload as Record<string, unknown>),
    ...(input.title ? { title: input.title } : {}),
    locationId: input.locationId ?? null,
    recruiterId: input.recruiterId ?? ctx.actorId,
    languages: (template.languages as { langCode: string, level: string, isRequired?: boolean, sort?: number }[] | null) ?? [],
  })
  if (!parsed.success) return { ok: false, code: 'invalid_payload' }

  const vacancy = await createVacancy(ctx, parsed.data)
  await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const criteria = (template.criteria as Record<string, unknown>[] | null) ?? []
    if (criteria.length) {
      await tx.insert(vacancyCriteria).values(criteria.map((c, i) => ({
        tenantId: ctx.tenantId,
        vacancyId: vacancy.id,
        name: String(c.name ?? ''),
        description: (c.description as string | null) ?? null,
        weight: String(c.weight ?? 1),
        scaleMin: String(c.scaleMin ?? 0),
        scaleMax: String(c.scaleMax ?? 5),
        isCritical: Boolean(c.isCritical),
        origin: 'template',
        sort: Number(c.sort ?? i),
      })))
    }
    await tx.update(vacancyTemplates)
      .set({ usageCount: sql`${vacancyTemplates.usageCount} + 1`, updatedAt: new Date() })
      .where(eq(vacancyTemplates.id, templateId))
    await tx.update(vacancies).set({ templateId }).where(eq(vacancies.id, vacancy.id))
  })
  return { ok: true, vacancy: { ...vacancy, templateId } }
}

async function nameTaken(tx: TenantTx, name: string): Promise<boolean> {
  const [row] = await tx.select({ id: vacancyTemplates.id }).from(vacancyTemplates).where(eq(vacancyTemplates.name, name))
  return !!row
}

function stripExcluded(payload: Record<string, unknown>): Record<string, unknown> {
  const excluded = new Set<string>(EXCLUDED_FROM_PAYLOAD)
  return Object.fromEntries(
    Object.entries(payload).filter(([k, v]) => !excluded.has(k) && v !== undefined),
  )
}
