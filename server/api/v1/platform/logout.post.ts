import { PLATFORM_COOKIE } from '../../../middleware/01.session'
import { apiData } from '../../../utils/apiResponse'
export default defineEventHandler((event) => { deleteCookie(event, PLATFORM_COOKIE, { path: '/' }); return apiData({ ok: true }) })
