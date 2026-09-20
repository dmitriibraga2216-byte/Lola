import { z } from 'zod'
import { requireAnyScope } from '../../../services/access'
import { listAllContent } from '../../../services/contentCatalog'
import { apiData } from '../../../utils/apiResponse'
import { CONTENT_TYPES } from '../../../../shared/enums'

const CONTENT_SCOPES = ['course.view', 'program.manage', 'complextest.manage', 'survey.manage', 'assessment.run', 'checklist.run', 'meetup.view']

/**
 * GET /content?q=&type=&page=&perPage= — витрина-агрегатор над одиннадцатью типами контента
 * (docs/33 D-063, докс/28 §28.4). Каждый тип виден только тому, у кого уже есть скоуп его
 * «родного» CRUD-эндпоинта (server/services/contentCatalog.ts) — тут ничего не открывается шире.
 */
export default defineEventHandler(async (event) => {
  const a = await requireAnyScope(event, CONTENT_SCOPES)
  const q = z.object({
    q: z.string().max(200).optional(),
    type: z.enum(CONTENT_TYPES).optional(),
    page: z.coerce.number().int().min(1).optional(),
    perPage: z.coerce.number().int().min(1).max(200).optional(),
  }).parse(getQuery(event))
  return apiData(await listAllContent(a, q))
})
