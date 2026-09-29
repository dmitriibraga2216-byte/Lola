import { sql } from 'drizzle-orm'
import { users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import type { TenantTx } from '../utils/withTenant'
import { recordAudit } from './audit'
import { isUuid } from './personCard'
import { personById } from './repo/people'

/**
 * Выгрузка персональных данных по запросу субъекта (docs/v2/38-people-extensions.md §7.4, §7.6,
 * §9 п. 6, §12; пара к `gdpr.erase`, docs/16 §7.9).
 *
 * **Кто.** `[решение]` Р-38.4: тот же, кто стирает данные, — носитель `settings.tenant`
 * (администратор пространства, проверка в эндпоинте). Запрос субъекта — юридическое действие
 * работодателя-контролёра: человек обращается к нему, а не нажимает кнопку сам; и это
 * единственный законный канал выдачи содержания заметок (§9 п. 6), поэтому он узкий и
 * журналируемый. Основание запроса (`reason`) обязательно и уходит в `audit_log`
 * (`person.personal_data_export`, в `after` — разделы и число строк, **без содержимого**).
 *
 * **Кого.** Только сотрудник (`kind = 'employee'`, инвариант 17): у кандидата своё согласие и
 * своё обезличивание (`v2/28`), его карточки сотрудника нет — `404`, как у заметок и документов.
 * Уволенный — выгружается: право субъекта на доступ с увольнением не прекращается.
 *
 * **Что.** Профиль, размещения, записи на обучение, документы (факт, маскированный номер,
 * без файлов), отсутствия, суточная лента активности, снимки индекса залученості, **все**
 * заметки о человеке — включая `visibility = 'hr'` и архивные (§12) — и список фактов чтения
 * заметок **без имён читавших** (§7.6). `[решение]` Р-38.5: имён других людей в файле нет
 * вовсе — ни читавших, ни авторов заметок, ни тех, кто загрузил документ: выгружаются данные
 * субъекта, а не персональные данные коллег; вместо автора — признак «написано вами / другим».
 */

export const PERSONAL_DATA_SECTIONS = [
  'profile', 'placements', 'enrollments', 'documents', 'absences', 'activity', 'engagement', 'notes', 'noteReads',
] as const
export type PersonalDataSection = typeof PERSONAL_DATA_SECTIONS[number]

export interface PersonalDataExport {
  format: 'lola.personal-data.v1'
  generatedAt: string
  subjectId: string
  profile: Record<string, unknown>
  placements: Record<string, unknown>[]
  enrollments: Record<string, unknown>[]
  documents: Record<string, unknown>[]
  absences: Record<string, unknown>[]
  activity: Record<string, unknown>[]
  engagement: Record<string, unknown>[]
  notes: Record<string, unknown>[]
  noteReads: { at: string, count: number }[]
}

type Rows = Record<string, unknown>[]
const rows = async (tx: TenantTx, q: ReturnType<typeof sql>): Promise<Rows> => await tx.execute(q) as unknown as Rows

async function collect(tx: TenantTx, id: string): Promise<Omit<PersonalDataExport, 'format' | 'generatedAt' | 'subjectId'> | null> {
  const [profile] = await rows(tx, sql`
    select u.id, u.kind, u.full_name, u.last_name, u.first_name, u.middle_name, u.latin_name, u.email, u.phone,
           u.work_contacts, u.birth_date, u.gender, u.locale, u.timezone, u.comm_language, u.status, u.is_blocked,
           u.hired_at, u.position_since, u.archived_at, u.tags, u.comment, u.external_id, u.last_seen_at,
           u.rating_pct, u.rating_updated_at, u.created_at, (u.telegram_chat_id is not null) as telegram_connected
    from users u where u.id = ${id}::uuid and u.kind = 'employee'`)
  if (!profile) return null
  return {
    profile,
    placements: await rows(tx, sql`
      select l.name as location, p.name as position, up.is_primary, up.started_at, up.ended_at
      from user_placements up
      left join locations l on l.id = up.location_id
      left join positions p on p.id = up.position_id
      where up.user_id = ${id}::uuid order by up.started_at`),
    enrollments: await rows(tx, sql`
      select e.subject_type, coalesce(c.title, e.subject_type) as title, e.source, e.status, e.progress_pct, e.score,
             e.starts_at, e.due_at, e.started_at, e.completed_at, e.valid_until, e.time_spent_sec, e.deadline_shifted_reason
      from enrollments e
      left join courses c on e.subject_type = 'course' and c.id = e.subject_id
      where e.user_id = ${id}::uuid order by e.created_at`),
    documents: await rows(tx, sql`
      select t.name as type, d.title, d.number_masked, d.issued_at, d.expires_at, d.status,
             (d.uploaded_by = d.user_id) as uploaded_by_you, (d.media_id is not null) as has_file,
             d.note, d.revoked_at, d.revoke_reason, d.created_at
      from person_documents d join person_document_types t on t.id = d.type_id
      where d.user_id = ${id}::uuid order by d.created_at`),
    absences: await rows(tx, sql`
      select kind, date_from, date_to, days_count, status, source, comment, created_at
      from absence_records where user_id = ${id}::uuid order by date_from`),
    activity: await rows(tx, sql`
      select local_date, events_count, seconds_spent, kinds, level
      from user_activity_daily where user_id = ${id}::uuid order by local_date`),
    engagement: await rows(tx, sql`
      select calc_date, base_pct, bonus_early, bonus_streak, bonus_help, total_pct, window_from, window_to
      from person_rating_snapshots where user_id = ${id}::uuid order by calc_date`),
    notes: await rows(tx, sql`
      select n.created_at, n.updated_at, n.category, n.visibility, n.is_pinned, n.body, n.shared_at, n.archived_at,
             (n.author_id is null or n.author_id = n.user_id) as written_by_you
      from user_notes n where n.user_id = ${id}::uuid order by n.created_at`),
    // Факты чтения — момент и число заметок, без имени читавшего (§7.6, §12)
    noteReads: (await rows(tx, sql`
      select created_at as at, coalesce((after->>'count')::int, 0) as count
      from audit_log where action = 'person_note.read' and entity = 'user' and entity_id = ${id}::uuid
      order by created_at`)).map(r => ({ at: new Date(r.at as string).toISOString(), count: Number(r.count) })),
  }
}

export type PersonalDataResult = { ok: true, data: PersonalDataExport } | { ok: false, code: 'not_found' }

export async function exportPersonalData(ctx: { tenantId: string, actorId: string }, personId: string, reason: string): Promise<PersonalDataResult> {
  if (!isUuid(personId)) return { ok: false, code: 'not_found' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [p] = await personById(tx, { id: users.id, kind: users.kind }, personId)
    if (!p || p.kind !== 'employee') return { ok: false, code: 'not_found' }
    const body = await collect(tx, p.id)
    if (!body) return { ok: false, code: 'not_found' }
    const counts = Object.fromEntries(PERSONAL_DATA_SECTIONS.filter(s => s !== 'profile').map(s => [s, (body[s] as unknown[]).length]))
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'person.personal_data_export',
      entity: 'user',
      entityId: p.id,
      after: { reason, sections: PERSONAL_DATA_SECTIONS, counts },
    })
    return { ok: true, data: { format: 'lola.personal-data.v1', generatedAt: new Date().toISOString(), subjectId: p.id, ...body } }
  })
}
