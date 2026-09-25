import { absenceNormPutSchema } from '../../../../shared/schemas/absences'
import { areaForScope, requireScope } from '../../../services/access'
import { normTargetLocation, putAbsenceNorm } from '../../../services/absenceNorms'
import { apiData, apiError } from '../../../utils/apiResponse'

/**
 * PUT /absence-norms (docs/04 §4.11, docs/v2/38 §10): `{scopeType, scopeId, year, vacationDays?,
 * sickDays?, reason?}`. Норму компании правит только право на весь тенант, точку и человека —
 * право в области этой точки (`38` §2: руководитель — своих точек). Чужая точка или человек —
 * 404 (CLAUDE.md п. 15); своя, но вне области — 403; уровень человека без причины — 422;
 * собственная индивидуальная норма — `409 absence_norm.self_edit` (`putAbsenceNorm`), даже
 * если право есть и точка своя.
 */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'person.absence.manage')
  const p = absenceNormPutSchema.safeParse(await readBody(event))
  if (!p.success) {
    const reason = p.error.issues.some(i => i.path[0] === 'reason')
    return reason
      ? apiError(event, 422, 'reason_required', 'Вкажіть причину індивідуального коригування — від 5 знаків', { issues: p.error.issues })
      : apiError(event, 400, 'validation_failed', 'Кількість днів — від 0 до 365 з кроком пів дня', { issues: p.error.issues })
  }
  const ctx = { tenantId: a.tenantId, actorId: a.userId }
  const area = await areaForScope(a, 'person.absence.manage')
  const target = await normTargetLocation(ctx, p.data)
  if (!target.found) return apiError(event, 404, 'not_found', p.data.scopeType === 'location' ? 'Точку не знайдено' : 'Співробітника не знайдено')
  const allowed = area === null || (p.data.scopeType !== 'tenant' && !!target.locationId && area.includes(target.locationId))
  if (!allowed) return apiError(event, 403, 'forbidden', p.data.scopeType === 'tenant' ? 'Норму компанії змінює лише HR або адміністратор простору' : 'Ви можете змінювати норми лише своїх точок')
  const r = await putAbsenceNorm(ctx, p.data)
  if (!r.ok) {
    switch (r.code) {
      case 'self': return apiError(event, 409, 'absence_norm.self_edit', 'Не можна коригувати власну норму відсутностей — попросіть іншого адміністратора або HR')
    }
  }
  return apiData(r.row)
})
