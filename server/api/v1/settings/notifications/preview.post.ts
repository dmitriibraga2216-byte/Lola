import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { requireScope } from '../../../../services/access'
import { renderTemplate, DEFAULT_TEMPLATES } from '../../../../services/notifications'
import { buildEmailHtml } from '../../../../services/emailRender'
import { tenantOverrides } from '../../../../services/translations'
import { tenantSettings } from '../../../../services/settings'
import { withTenant } from '../../../../utils/withTenant'
import { apiData, apiError } from '../../../../utils/apiResponse'
/** Предпросмотр шаблона на реальном человеке, с {{#_tr}} по локалі та MJML → HTML (docs/23 §5.2, §13.4). */
export default defineEventHandler(async (event) => {
  const a = await requireScope(event, 'settings.notifications')
  const p = z.object({
    body: z.string().max(2000),
    bodyMjml: z.string().max(20_000).optional(),
    userId: z.string().uuid().optional(),
    code: z.string().max(60).optional(),
    locale: z.enum(['uk', 'en']).default('uk'),
  }).safeParse(await readBody(event))
  if (!p.success) return apiError(event, 400, 'validation_failed', 'Перевірте шаблон')
  const userId = p.data.userId ?? a.userId
  const { vars, layout } = await withTenant(a.tenantId, a.userId, async (tx) => {
    const [r] = await tx.execute(sql`
      select u.full_name, u.first_name, l.name as location, p.name as position, (select name from tenants where id = ${a.tenantId}::uuid) as tenant
      from users u left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null left join locations l on l.id = up.location_id left join positions p on p.id = up.position_id where u.id = ${userId}::uuid`) as unknown as Record<string, string | null>[]
    const s = await tenantSettings({ tenantId: a.tenantId, actorId: a.userId })
    return {
      layout: s.emailLayout,
      vars: { 'user.full_name': r?.full_name ?? '', 'user.first_name': r?.first_name ?? '', 'location.name': r?.location ?? '', 'position.name': r?.position ?? '', 'tenant.name': r?.tenant ?? '', 'name': r?.full_name ?? '', 'link': `${process.env.APP_URL ?? ''}/learn`, 'mail_settings_url': `${process.env.APP_URL ?? ''}/learn/notifications`,
        'course.title': 'Стандарти сервісу', course: 'Стандарти сервісу', title: 'Стандарти сервісу', due: '2026-10-01', 'due.date': '01.10.2026', 'due.days_left': 3, days: 3, 'progress.pct': 40, score: 85, attempts_left: 2, 'mentor.name': 'Наставник', 'certificate.number': 'LC-0001', n: 3, url: `${process.env.APP_URL ?? ''}/learn`, text: 'Текст розсилки' },
    }
  })
  const overrides = await tenantOverrides(a.tenantId, p.data.locale)
  const tr = (phrase: string) => overrides[phrase] ?? phrase
  const body = p.data.body || (p.data.code ? DEFAULT_TEMPLATES[p.data.code] ?? '' : '')
  const text = renderTemplate(body, vars, tr)
  const html = p.data.bodyMjml
    ? buildEmailHtml({
        bodyMjml: renderTemplate(p.data.bodyMjml, vars, tr),
        fallbackText: text,
        layout: { headerMjml: layout.headerMjml ? renderTemplate(layout.headerMjml, vars, tr) : '', footerMjml: layout.footerMjml ? renderTemplate(layout.footerMjml, vars, tr) : '' },
      })
    : null
  return apiData({ text, html, variables: Object.keys(vars) })
})
