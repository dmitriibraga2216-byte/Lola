import { eq, sql } from 'drizzle-orm'
import { users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { enqueueNotification } from './notifications'
import type { Access } from './access'
import { can } from './access'

interface Ctx { tenantId: string, actorId: string }

/**
 * Люди в хабе (docs/21 §3.8, §14.7–14.8): дни рождения — вычисляемый виджет из users.birth_date
 * с учётом «Прихований» и согласия человека (29 Б.16: opt-out); контакты — витрина над карточкой
 * человека, отдельной таблицы и редактирования нет; личные поля — только руководителю/кадровику.
 */

interface PersonRow { id: string, full_name: string, avatar_key: string | null, birth_date: string | null, phone: string | null, email: string | null, work_contacts: { ext?: string, workEmail?: string, messenger?: string } | null, city: string | null, location: string | null, location_id: string | null, org_unit: string | null, position: string | null }

const PEOPLE_SQL = sql`
  select u.id, u.full_name, u.avatar_key, u.birth_date::text, u.phone, u.email, u.work_contacts,
         c.name as city, l.name as location, l.id as location_id, o.name as org_unit, p.name as position
  from users u
  left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
  left join locations l on l.id = up.location_id
  left join cities c on c.id = coalesce(up.city_id, l.city_id)
  left join org_units o on o.id = coalesce(up.org_unit_id, l.org_unit_id)
  left join positions p on p.id = up.position_id
  where u.status = 'active' and u.is_hidden = false`

/** День рождения в году `year` (29 февраля → 28 февраля в невисокосный). */
function birthdayIn(year: number, birth: string): Date {
  const [, m, d] = birth.split('-').map(Number)
  const dt = new Date(Date.UTC(year, m! - 1, d!))
  return dt.getUTCMonth() === m! - 1 ? dt : new Date(Date.UTC(year, m! - 1, 28))
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)

/**
 * Дни рождения за период (мокап Birthdays): по умолчанию две недели вперёд («Майбутні») или назад («Минулі»).
 * Показываются только те, кто не скрыт и дал согласие (docs/21 §7.8, §12).
 */
export async function birthdays(ctx: Ctx, q: { from?: string, to?: string, tab?: 'upcoming' | 'past' }) {
  const today = new Date(iso(new Date()))
  const from = q.from ? new Date(q.from) : q.tab === 'past' ? addDays(today, -14) : today
  const to = q.to ? new Date(q.to) : q.tab === 'past' ? addDays(today, -1) : addDays(today, 14)
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.execute(sql`${PEOPLE_SQL} and u.birth_date is not null and u.birthday_consent = true`) as unknown as PersonRow[]
    const out: { id: string, fullName: string, avatarKey: string | null, date: string, city: string | null, location: string | null, orgUnit: string | null, position: string | null }[] = []
    for (const r of rows) {
      for (const y of [from.getUTCFullYear(), to.getUTCFullYear()]) {
        const d = birthdayIn(y, r.birth_date!)
        if (d >= from && d <= to && !out.some(x => x.id === r.id && x.date === iso(d))) {
          out.push({ id: r.id, fullName: r.full_name, avatarKey: r.avatar_key, date: iso(d), city: r.city, location: r.location, orgUnit: r.org_unit, position: r.position })
        }
      }
    }
    out.sort((a, b) => a.date.localeCompare(b.date) || a.fullName.localeCompare(b.fullName))
    return { from: iso(from), to: iso(to), items: out }
  })
}

/** Согласие показывать день рождения (29 Б.16): человек снимает флаг в профиле — виджет его пропускает. */
export async function setBirthdayConsent(ctx: Ctx, consent: boolean) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [u] = await tx.update(users).set({ birthdayConsent: consent, updatedAt: new Date() }).where(eq(users.id, ctx.actorId)).returning({ birthdayConsent: users.birthdayConsent })
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'profile.birthday_consent', entity: 'user', entityId: ctx.actorId, after: { birthdayConsent: consent } })
    return u!
  })
}

/**
 * Контакты (docs/21 §14.8 [решение]): имя, должность, точка, город, подразделение, рабочий телефон и рабочая почта — всем;
 * личный телефон, почта и дата рождения — тем, кто видит карточку человека (`people.view`), остальным — по настройке тенанта
 * `settings.contacts.showPersonal`.
 */
export async function contacts(ctx: Ctx, access: Access, q: { q?: string, orgUnitId?: string, positionId?: string, cityId?: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.execute(sql`select coalesce((settings->'contacts'->>'showPersonal')::boolean, false) as show_personal from tenants where id = ${ctx.tenantId}::uuid`) as unknown as { show_personal: boolean }[]
    const personal = can(access, 'people.view') || !!t?.show_personal
    const rows = await tx.execute(sql`${PEOPLE_SQL}
      ${q.q ? sql`and u.full_name ilike ${`%${q.q}%`}` : sql``}
      ${q.orgUnitId ? sql`and coalesce(up.org_unit_id, l.org_unit_id) = ${q.orgUnitId}::uuid` : sql``}
      ${q.positionId ? sql`and up.position_id = ${q.positionId}::uuid` : sql``}
      ${q.cityId ? sql`and coalesce(up.city_id, l.city_id) = ${q.cityId}::uuid` : sql``}
      order by u.full_name limit 500`) as unknown as PersonRow[]
    return {
      showPersonal: personal,
      items: rows.map(r => ({
        id: r.id, fullName: r.full_name, avatarKey: r.avatar_key, position: r.position, location: r.location, city: r.city, orgUnit: r.org_unit,
        workPhone: r.work_contacts?.ext ?? null, workEmail: r.work_contacts?.workEmail ?? null, messenger: r.work_contacts?.messenger ?? null,
        ...(personal ? { phone: r.phone, email: r.email, birthDate: r.birth_date } : {}),
      })),
    }
  })
}

/**
 * Ежедневно (due.scan): `birthday_upcoming` руководителю точки за N дней (тенант: settings.birthdays.reminderDays, по умолчанию 3 —
 * «щоб встиг купити торт», docs/21 §14.7), `birthday_today` — коллегам точки именинника. Дедуп на год.
 */
export async function birthdayScan(tenantId: string): Promise<{ upcoming: number, today: number }> {
  const out = { upcoming: 0, today: 0 }
  await withTenant(tenantId, null, async (tx) => {
    const [t] = await tx.execute(sql`select coalesce((settings->'birthdays'->>'reminderDays')::int, 3) as days from tenants where id = ${tenantId}::uuid`) as unknown as { days: number }[]
    const days = t?.days ?? 3
    const today = new Date(iso(new Date()))
    const year = today.getUTCFullYear()
    const rows = await tx.execute(sql`${PEOPLE_SQL} and u.birth_date is not null and u.birthday_consent = true`) as unknown as PersonRow[]
    const mgrOf = new Map<string, string | null>()
    for (const r of rows) {
      const d = birthdayIn(year, r.birth_date!)
      const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000)
      const label = d.toISOString().slice(5, 10)
      if (diff === days && r.location_id) {
        if (!mgrOf.has(r.location_id)) {
          const [l] = await tx.execute(sql`select manager_id from locations where id = ${r.location_id}::uuid`) as unknown as { manager_id: string | null }[]
          mgrOf.set(r.location_id, l?.manager_id ?? null)
        }
        const mgr = mgrOf.get(r.location_id)
        if (mgr && mgr !== r.id && await enqueueNotification(tx, { tenantId, userId: mgr, code: 'birthday_upcoming', payload: { name: r.full_name, date: label, days }, dedupKey: `bday_up:${r.id}:${year}` })) out.upcoming++
      }
      if (diff === 0 && r.location_id) {
        const mates = await tx.execute(sql`select u.id from users u join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null where up.location_id = ${r.location_id}::uuid and u.status = 'active' and u.id <> ${r.id}::uuid`) as unknown as { id: string }[]
        for (const m of mates) {
          if (await enqueueNotification(tx, { tenantId, userId: m.id, code: 'birthday_today', payload: { name: r.full_name }, dedupKey: `bday:${r.id}:${m.id}:${year}` })) out.today++
        }
      }
    }
  })
  return out
}

