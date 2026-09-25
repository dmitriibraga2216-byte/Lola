import { requireAccess } from '../../../../../../services/access'
import { uploadAnswer } from '../../../../../../services/interview/session'
import { interviewUploadSchema } from '../../../../../../../shared/schemas/interview'
import { apiData } from '../../../../../../utils/apiResponse'
import { clientIp } from '../../../../../../utils/authCookies'
import { interviewFail, interviewMediaFail, interviewValidationFail } from '../../../../../../utils/interviewErrors'

/**
 * POST /interviews/:sessionId/turns/:ordinal/upload — ссылка на загрузку аудио реплики
 * (`docs/v2/30` §10, `41` §5.8): файл идёт в S3 напрямую, через API — только метаданные.
 * До 25 МБ (`413 media.too_big`), закрытая реплика — `422 turn.closed`, перезапись сверх
 * лимита сценария — `409 retake.limit`.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAccess(event)
  const p = interviewUploadSchema.safeParse(await readBody(event))
  if (!p.success) return interviewValidationFail(event, p.error)
  const ordinal = Number(getRouterParam(event, 'ordinal'))
  if (!Number.isInteger(ordinal) || ordinal < 1) return interviewFail(event, 'turn_closed')
  const r = await uploadAnswer({ tenantId: a.tenantId, actorId: a.userId }, getRouterParam(event, 'sessionId')!, ordinal, p.data, {
    ip: clientIp(event), userAgent: getHeader(event, 'user-agent') ?? null,
  })
  if (r.ok) return apiData({ mediaId: r.mediaId, uploadUrl: r.uploadUrl, retakesLeft: r.retakesLeft })
  if (r.code === 'media') return interviewMediaFail(event, r.mediaCode, r.message)
  return interviewFail(event, r.code)
})
