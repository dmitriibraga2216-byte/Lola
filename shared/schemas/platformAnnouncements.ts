import { z } from 'zod'
import { ANNOUNCEMENT_AUDIENCES } from '../enums'

/**
 * Объявления платформы (docs/v2/39 П-21, П-24.2; docs/24 §4.7). Пишет оператор платформы,
 * тенанты только читают — это не корпоративные новости тенанта (`news`, docs/21 §3.2).
 */

const target = {
  audience: z.enum(ANNOUNCEMENT_AUDIENCES),
  planCodes: z.array(z.string().trim().min(1).max(40)).max(20),
  tenantIds: z.array(z.string().uuid()).max(500),
}

/** Адресация согласована с видом — та же проверка, что CHECK `platform_announcements_target_chk`. */
function checkTarget(v: { audience?: string, planCodes?: string[], tenantIds?: string[] }, ctx: z.RefinementCtx): void {
  if (v.audience === undefined) return
  const plans = v.planCodes?.length ?? 0
  const tenants = v.tenantIds?.length ?? 0
  if (v.audience === 'all' && (plans || tenants)) ctx.addIssue({ code: 'custom', path: ['audience'], message: 'Для «Усім» тарифи й простори не вказуються' })
  if (v.audience === 'plans' && (!plans || tenants)) ctx.addIssue({ code: 'custom', path: ['planCodes'], message: 'Оберіть хоча б один тариф' })
  if (v.audience === 'tenants' && (!tenants || plans)) ctx.addIssue({ code: 'custom', path: ['tenantIds'], message: 'Оберіть хоча б один простір' })
}

export const announcementCreateSchema = z.object({
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(1).max(5000),
  audience: target.audience.default('all'),
  planCodes: target.planCodes.default([]),
  tenantIds: target.tenantIds.default([]),
  /** Сразу опубликовать; иначе — черновик, который видит только оператор */
  publish: z.boolean().default(false),
}).strict().superRefine(checkTarget)
export type AnnouncementCreate = z.infer<typeof announcementCreateSchema>

/** Правка текста и адресации; адресация меняется только целиком — вид вместе со списками. */
export const announcementPatchSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  body: z.string().trim().min(1).max(5000).optional(),
  audience: target.audience.optional(),
  planCodes: target.planCodes.optional(),
  tenantIds: target.tenantIds.optional(),
}).strict().superRefine((v, ctx) => {
  const touched = v.planCodes !== undefined || v.tenantIds !== undefined
  if (touched && v.audience === undefined) ctx.addIssue({ code: 'custom', path: ['audience'], message: 'Адресацію змінюють разом із видом' })
  checkTarget({ audience: v.audience, planCodes: v.planCodes ?? [], tenantIds: v.tenantIds ?? [] }, ctx)
})
export type AnnouncementPatch = z.infer<typeof announcementPatchSchema>
