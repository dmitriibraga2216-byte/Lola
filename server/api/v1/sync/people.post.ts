import { z } from 'zod'
import { requireScope } from '../../../services/access'
import { validateImport, applyImport } from '../../../services/importPeople'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * Входящий API учётной системы (docs/09 §9.6): идемпотентная синхронизация по
 * external_id через тот же конвейер, что импорт из файла — с протоколом.
 */
const row = z.object({
  externalId: z.string().min(1).max(100), fullName: z.string().min(2).max(200), phone: z.string().min(9).max(20),
  email: z.string().email().optional(), position: z.string().min(1).max(120), orgUnit: z.string().min(1).max(120), location: z.string().min(1).max(120),
  role: z.string().max(50).optional(), tags: z.array(z.string().max(50)).optional(), hiredAt: z.string().date().optional(), city: z.string().max(120).optional(), positionLevel: z.string().max(120).optional(),
})
const schema = z.object({ people: z.array(row).min(1).max(5000), archiveMissing: z.boolean().default(false) })

export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'people.import')
  const p = schema.safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', p.error.issues[0]?.message ?? 'Перевірте дані', { issues: p.error.issues.slice(0, 20) })
  const raw = p.data.people.map(r => ({
    'ПІБ': r.fullName, 'Телефон': r.phone, 'Email': r.email ?? '', 'Посада': r.position, 'Рівень посади': r.positionLevel ?? '', 'Місто': r.city ?? '',
    'Підрозділ': r.orgUnit, 'Точка': r.location, 'Роль': r.role ?? '', 'Мітки': (r.tags ?? []).join(','), 'Дата найму': r.hiredAt ?? '', 'Зовнішній ID': r.externalId,
  }))
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const validated = await validateImport(ctx, `api-sync-${Date.now()}.json`, raw)
  const applied = await applyImport(ctx, validated.jobId)
  return apiData({ jobId: validated.jobId, stats: applied?.stats ?? validated.stats, errors: validated.rows.filter(r => r.errors.length).map(r => ({ externalId: r.externalId, errors: r.errors })) })
})
