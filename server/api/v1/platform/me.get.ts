import { requirePlatformSession } from '../../../utils/platformGuard'
import { hostConfig } from '../../../services/tenantResolve'
import { apiData } from '../../../utils/apiResponse'
import { PLATFORM_MATRIX } from '../../../../shared/domain/platformRoles'

/**
 * GET /platform/me — оператор, его роль и права (консоль прячет по ним кнопки, решает сервер),
 * шаг второго фактора и базовый домен тенантов (`<slug>.<base>`, docs/25 §16.1) для колонки «Тенант».
 * Открыт и промежуточной сессии: по нему консоль понимает, какой экран 2FA показать.
 */
export default defineEventHandler((event) => {
  const p = requirePlatformSession(event)
  return apiData({
    adminId: p.adminId, email: p.email, fullName: p.fullName, role: p.role,
    twoFactor: p.twoFactorPending ? (p.twoFactorEnrolled ? 'verify' : 'enroll') : null,
    actions: p.twoFactorPending ? [] : [...PLATFORM_MATRIX[p.role]],
    hostBase: hostConfig().base,
  })
})
