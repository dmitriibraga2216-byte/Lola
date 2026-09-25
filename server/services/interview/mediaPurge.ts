import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { sql } from 'drizzle-orm'
import { withTenant, type TenantTx } from '../../utils/withTenant'
import { recordAudit } from '../audit'
import { S3_BUCKET, s3 } from '../media'
import { INTERVIEW_AUDIO_KEEP_DAYS } from '../../../shared/domain/interview'

/**
 * **Голос не живёт дольше срока** (`docs/v2/30-ai-interview.md` §7.7, §11 `interview.media_purge`,
 * §13 к. 10; `docs/v2/42` §5 проверка 18; план `45` PR-29).
 *
 * Аудио ответа (`media_assets.origin = 'interview_answer'`) живёт 90 дней от конца сессии, но не
 * дольше согласия на обработку ПД кандидата; отозванное согласие, перезапись и ответ текстом
 * отправляют запись в корзину сразу (`purge_after = now()`). Этот файл — единственное место,
 * где голос переходит в `purged`, и переходит он **только после удаления объекта из S3**:
 *
 * - `storage.purge` корзины хранилища объектов не удаляет вовсе (`docs/v2/44` §8: безвозвратное
 *   удаление файлов ждёт решения владельца продукта) — для голоса это решение уже принято самим
 *   документом: действие `purge`, «аудио физически удалено» (§7.7, §13 к. 10), а кандидату на
 *   экране согласия обещано «Аудіо зберігається 90 днів». Поэтому `storage.purge` голос
 *   пропускает (`server/services/storage.ts#purgeDue`), а здесь объект удаляется по-настоящему;
 * - **ошибка удаления не глушится** (в отличие от `deleteS3Prefix()` при удалении тенанта, где
 *   `MissingContentMD5` от MinIO проглатывался): объект, который не удалился, остаётся в строке
 *   `active`/`pending_delete` с истёкшим сроком — его видит SQL сквозной проверки 18, неудача
 *   пишется в `audit_log` (`interview.media.purge_failed`), а задача падает и уходит в повтор.
 *   Удаление — по одному объекту `DeleteObject`, без пакетного `DeleteObjects`: пакетный метод и
 *   дал ту ошибку на MinIO, а удалённый объект S3 подтверждает и при повторе (идемпотентно);
 * - срок проставляется и тем записям, у которых его ещё нет (запись брошенной сессии, записи
 *   до PR-29): от конца сессии, а у незавершённой — от последней активности, но не позже
 *   согласия на обработку ПД. Голоса без срока после прогона не остаётся.
 *
 * Строка `media_assets` не удаляется: на неё ссылается реплика, и карточка показывает «Аудіо
 * видалено {дата}. Розшифровка збережена» (§12 п. 10). Расшифровка, баллы и цитаты этой задачей
 * не трогаются — они живут до обезличивания кандидата (§7.7).
 *
 * Тенанты обходятся **все**, включая приостановленные и архивные (`tenantResolve.allTenantIds`):
 * срок голоса — обещание кандидату, а не политика хранения тенанта, и «клиент не может
 * возразить» (`34` §12) к нему не относится.
 */

/** Партия за один проход; за прогон — не больше десяти партий на тенант. */
export const AUDIO_PURGE_BATCH = 200
const AUDIO_PURGE_MAX_BATCHES = 10

type ObjectDeleter = (key: string) => Promise<void>

const s3Deleter: ObjectDeleter = async (key) => {
  await s3().send(new DeleteObjectCommand({ Bucket: S3_BUCKET(), Key: key }))
}

let deleter: ObjectDeleter = s3Deleter

/** Подмена удаления объекта в тестах (отказ S3); `null` — настоящий S3. */
export function setAudioObjectDeleter(fn: ObjectDeleter | null): void {
  deleter = fn ?? s3Deleter
}

/**
 * Срок голоса сессии при её завершении (`30` §7.7): записи реплик получают `purge_after`
 * сессии. Уже выброшенные (перезапись, ответ текстом) свой срок «сейчас» не теряют.
 */
export async function setSessionAudioTermTx(tx: TenantTx, sessionId: string, term: Date): Promise<void> {
  await tx.execute(sql`
    update media_assets set purge_after = ${term.toISOString()}::timestamptz, updated_at = now()
     where origin = 'interview_answer' and lifecycle in ('active', 'orphaned')
       and source_entity = 'interview_turns'
       and source_id in (select id from interview_turns where session_id = ${sessionId}::uuid)
       and (purge_after is null or purge_after > ${term.toISOString()}::timestamptz)`)
}

/**
 * Срок записям без срока: `interview_sessions.purge_after`, иначе конец сессии, иначе последняя
 * активность (+90 дней), но не позже дня окончания согласия на обработку ПД; запись без сессии —
 * от своего создания. Возвращает, скольким записям срок назначен.
 */
export async function assignAudioTerms(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      update media_assets m set purge_after = t.term, updated_at = now()
        from (
          select m2.id,
                 least(
                   coalesce(s.purge_after,
                            coalesce(s.finished_at, s.last_activity_at, s.started_at, s.created_at, m2.created_at)
                              + make_interval(days => ${INTERVIEW_AUDIO_KEEP_DAYS})),
                   (u.consent_expires_at + time '23:59:59') at time zone 'UTC'
                 ) as term
            from media_assets m2
            left join interview_turns tr on m2.source_entity = 'interview_turns' and tr.id = m2.source_id
            left join interview_sessions s on s.id = tr.session_id
            left join users u on u.id = s.candidate_id
           where m2.origin = 'interview_answer' and m2.purge_after is null and m2.lifecycle <> 'purged'
        ) t
       where m.id = t.id
      returning m.id`) as unknown as { id: string }[]
    return rows.length
  })
}

export interface AudioPurgeReport {
  purged: number
  failed: number
  failures: { mediaId: string, error: string }[]
}

interface DueRow { id: string, key: string, poster_key: string | null, variants: Record<string, unknown> | null, lifecycle: string }

/** Все объекты записи: сам файл, обложка и варианты обработки, если они есть. */
function objectKeys(r: DueRow): string[] {
  const variants = r.variants && typeof r.variants === 'object' ? Object.values(r.variants).filter((v): v is string => typeof v === 'string' && v.startsWith('t/')) : []
  return [...new Set([r.key, ...(r.poster_key ? [r.poster_key] : []), ...variants])]
}

/**
 * Физическое удаление голоса с истёкшим сроком. Строка переходит в `purged` только после того,
 * как S3 подтвердил удаление каждого объекта записи; отказ — строка остаётся, причина — в
 * отчёте и в `audit_log`.
 */
export async function purgeDueAudio(tenantId: string, now: Date = new Date()): Promise<AudioPurgeReport> {
  const report: AudioPurgeReport = { purged: 0, failed: 0, failures: [] }
  const failedIds = new Set<string>()
  for (let batch = 0; batch < AUDIO_PURGE_MAX_BATCHES; batch++) {
    const due = await withTenant(tenantId, null, tx => tx.execute(sql`
      select id, key, poster_key, variants, lifecycle from media_assets
       where origin = 'interview_answer' and lifecycle <> 'purged' and purge_after <= ${now.toISOString()}::timestamptz
       order by purge_after, id
       limit ${AUDIO_PURGE_BATCH + failedIds.size}`) as unknown as Promise<DueRow[]>)
    const todo = due.filter(r => !failedIds.has(r.id))
    if (!todo.length) break

    const purgedIds: string[] = []
    for (const r of todo) {
      try {
        for (const key of objectKeys(r)) await deleter(key)
      }
      catch (err) {
        const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        failedIds.add(r.id)
        report.failures.push({ mediaId: r.id, error })
        continue
      }
      purgedIds.push(r.id)
    }

    if (purgedIds.length) {
      await withTenant(tenantId, null, async (tx) => {
        await tx.execute(sql`
          update media_assets
             set lifecycle = 'purged', deleted_at = coalesce(deleted_at, now()),
                 delete_reason = coalesce(delete_reason, 'retention'), updated_at = now()
           where id in (${sql.join(purgedIds.map(id => sql`${id}::uuid`), sql`, `)}) and lifecycle <> 'purged'`)
        await recordAudit(tx, {
          tenantId, actorId: null, action: 'interview.media.purge', entity: 'media_assets',
          entityId: purgedIds.length === 1 ? purgedIds[0]! : null,
          after: { files: purgedIds.length, mediaIds: purgedIds, objectDeleted: true },
        })
      })
      report.purged += purgedIds.length
    }
    if (todo.length < AUDIO_PURGE_BATCH) break
  }

  if (report.failures.length) {
    report.failed = report.failures.length
    await withTenant(tenantId, null, tx => recordAudit(tx, {
      tenantId, actorId: null, action: 'interview.media.purge_failed', entity: 'media_assets',
      entityId: report.failures.length === 1 ? report.failures[0]!.mediaId : null,
      after: { files: report.failures.length, failures: report.failures.slice(0, 50) },
    }))
  }
  return report
}

export class AudioPurgeError extends Error {
  constructor(public readonly tenantId: string, public readonly report: AudioPurgeReport) {
    super(`interview.media_purge: не удалось удалить ${report.failed} аудиозапис(ів) тенанта ${tenantId}: ${report.failures[0]?.error ?? ''}`)
    this.name = 'AudioPurgeError'
  }
}

/**
 * Задача `interview.media_purge` для одного тенанта (ежедневно 03:40, до `storage.purge` в 04:00,
 * `30` §11): сначала срок записям без срока, затем удаление истёкших. Неудача удаления —
 * исключение **после** того, как обработано всё остальное: одна упавшая запись не держит голос
 * других кандидатов, а сама задача падает и видна в очереди и журнале.
 */
export async function interviewMediaPurge(tenantId: string, now: Date = new Date()): Promise<{ termed: number } & AudioPurgeReport> {
  const termed = await assignAudioTerms(tenantId)
  const report = await purgeDueAudio(tenantId, now)
  if (report.failed) throw new AudioPurgeError(tenantId, report)
  return { termed, ...report }
}
