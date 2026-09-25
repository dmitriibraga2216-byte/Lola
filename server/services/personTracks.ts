import { sql } from 'drizzle-orm'
import { withTenant } from '../utils/withTenant'
import { deadlineLight } from '../../shared/domain/personTracks'
import type { PersonTracks, TrackGroup, TrackItem } from '../../shared/domain/personTracks'
import type { StageCapabilityMap } from '../../shared/enums'
import type { Access } from './access'
import { areaCovers, areaOf, can } from './access'
import { stageCan } from './lifecycle'
import { cardSubject } from './personCard'
// Третий именованный вход в модуль норм (сквозная проверка 13): только показ «Плановий час»
// рядом с «Часом проходження» (docs/v2/38 §5.1); в балл, зачёт и індекс залученості норма не входит
import { versionPlannedSeconds } from './timeNorms'

/**
 * Блок «Етап» карточки человека (docs/v2/33-lifecycle.md §5.3, docs/v2/38-people-extensions.md
 * §5.1, §7.15; П-16.2; PR-35): текущий этап человека с датой входа — в шапке, назначенное обучение —
 * «Призначені треки», сгруппированные по этапам жизненного цикла в порядке справочника тенанта.
 *
 * Поведение группы — только через `stageCan()` (инвариант 16): этап без `progress` рисуется
 * плоским списком без процента и срока (как база знаний на эталоне, критерий `33` §13 к. 2), без
 * `deadline` — без строки срока. Этап, который сотруднику не назначается (`applies_to_employee`),
 * пустой строкой не показывается — только если у человека уже есть его курс (пройденный ещё
 * кандидатом). Курс без этапа — отдельная группа «Без етапу».
 *
 * Метрики времени не считаются здесь заново (PR-21/22): «Плановий час» — нормы элементов версии
 * записи (`versionPlannedSeconds()`, модуль норм), «Час проходження» — витрина учёта времени
 * биениями `learning_time_totals` (контент + испытание). Видны тому, кому видно время человека:
 * ему самому и носителю `time.metrics.view` в области его точки (`docs/v2/37` §2); остальным — нет.
 * «Пройдено модулів X/Y» — обязательные уроки **версии записи** (`required_done`/`required_total`),
 * а не текущей опубликованной (§7.15): те же счётчики, из которых сервер считает прогресс.
 */

export type PersonTracksResult = { ok: true, data: PersonTracks } | { ok: false, code: 'not_found' }

export async function personTracks(access: Access, personId: string): Promise<PersonTracksResult> {
  const timeArea = await areaOf(access, 'time.metrics.view')
  return withTenant(access.tenantId, access.userId, async (tx) => {
    const subject = await cardSubject(tx, personId)
    if (!subject) return { ok: false as const, code: 'not_found' as const }
    const timeVisible = (access.viaToken !== true && access.userId === subject.id) || areaCovers(timeArea, subject.locationId)

    const stages = await tx.execute(sql`
      select id::text as id, name_uk as name, color, capabilities, is_enabled from lifecycle_stages
       order by sort, name_uk`) as unknown as { id: string, name: string, color: string, capabilities: StageCapabilityMap, is_enabled: boolean }[]

    const [current] = can(access, 'lifecycle.view')
      ? await tx.execute(sql`
          select s.name_uk as stage_name, s.color, st.entered_at from employee_lifecycle_state st
            join lifecycle_stages s on s.id = st.stage_id
           where st.user_id = ${subject.id}::uuid and st.is_current`) as unknown as { stage_name: string, color: string, entered_at: Date | string }[]
      : []

    const rows = await tx.execute(sql`
      select e.id::text as enrollment_id, e.subject_id::text as course_id, e.version_id::text as version_id, c.title,
             c.lifecycle_stage_id::text as stage_id, e.status, e.progress_pct::float8 as progress_pct, e.created_at, e.due_at,
             e.deadline_shifted_reason, e.required_done, e.required_total
        from enrollments e join courses c on c.id = e.subject_id
       where e.user_id = ${subject.id}::uuid and e.cancelled_at is null and e.status <> 'not_assigned'
       order by e.created_at desc, e.id desc
       limit 200`) as unknown as {
      enrollment_id: string, course_id: string, version_id: string, title: string, stage_id: string | null, status: string,
      progress_pct: number, created_at: Date | string, due_at: Date | string | null, deadline_shifted_reason: string | null,
      required_done: number, required_total: number
    }[]

    const planned = timeVisible ? await versionPlannedSeconds(tx, [...new Set(rows.map(r => r.version_id))]) : new Map<string, number | null>()
    const spent = new Map<string, number>()
    if (timeVisible && rows.length) {
      const totals = await tx.execute(sql`
        select enrollment_id::text as enrollment_id, sum(content_seconds + attempt_seconds)::int as seconds
          from learning_time_totals where enrollment_id in ${rows.map(r => r.enrollment_id)}
         group by enrollment_id`) as unknown as { enrollment_id: string, seconds: number }[]
      for (const t of totals) spent.set(t.enrollment_id, Number(t.seconds) || 0)
    }

    const now = new Date()
    const toItem = (r: typeof rows[number], stage: { capabilities: StageCapabilityMap } | null): TrackItem => {
      const progress = stageCan(stage, 'progress')
      const deadline = progress && stageCan(stage, 'deadline')
      const dueAt = deadline && r.due_at ? new Date(r.due_at).toISOString() : null
      return {
        enrollmentId: r.enrollment_id,
        courseId: r.course_id,
        title: r.title,
        status: r.status,
        progressPct: progress ? Math.round(Number(r.progress_pct) || 0) : null,
        assignedAt: new Date(r.created_at).toISOString(),
        dueAt,
        light: deadline ? deadlineLight(dueAt, r.status === 'done', now) : 'none',
        deadlineShifted: deadline && r.deadline_shifted_reason === 'absence',
        modulesDone: Number(r.required_done) || 0,
        modulesTotal: Number(r.required_total) || 0,
        plannedSeconds: timeVisible ? planned.get(r.version_id) ?? null : null,
        spentSeconds: timeVisible ? spent.get(r.enrollment_id) ?? 0 : null,
      }
    }

    // Группа — каждый включённый этап, который назначается сотруднику (пустой — строкой «немає
    // призначень»), и любой этап, по которому у человека уже есть записи (например, курс
    // рекрутинга, пройденный ещё кандидатом, — он остаётся в своём этапе, а не «без етапу»)
    const groups: TrackGroup[] = []
    for (const s of stages) {
      const items = rows.filter(r => r.stage_id === s.id).map(r => toItem(r, s))
      if (!items.length && !(s.is_enabled && stageCan(s, 'applies_to_employee'))) continue
      const progress = stageCan(s, 'progress')
      groups.push({ stage: { id: s.id, name: s.name, color: s.color }, flat: !progress, showDeadline: progress && stageCan(s, 'deadline'), items })
    }
    // Курс без этапа — полный набор возможностей, как в базовом ТЗ (`33` §7.3)
    const loose = rows.filter(r => !r.stage_id).map(r => toItem(r, null))
    if (loose.length) groups.push({ stage: null, flat: false, showDeadline: true, items: loose })

    return {
      ok: true as const,
      data: {
        current: current ? { stageName: current.stage_name, color: current.color, enteredAt: new Date(current.entered_at).toISOString() } : null,
        groups,
        timeVisible,
      },
    }
  })
}
