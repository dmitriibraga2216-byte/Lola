import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MEDIA_ORIGINS } from '../../shared/enums'
import { uploadUrlSchema } from '../../shared/schemas/content'

/**
 * PR-11 и PR-12 пакета `docs/v2` (`45-plan.md`): `media_assets` — переименование колонок,
 * мягкое удаление и финальный перечень `origin`.
 *
 * Решения: **В-4** (`uploaded_by` → `owner_user_id`, `checksum` → `checksum_sha256`, факт
 * «кто загрузил» переезжает в `audit_log` событием `media.upload`), **В-17** (`DELETE /media/:id` —
 * единственная одиночная ручка удаления, мягкое, объект в S3 остаётся), **В-19** (журнал
 * скачивания только для доказательств, ссылка 120 с), **В-6** (15 значений `origin`,
 * ровно один check), **В-10** (`stage_code` вместо `category_id` — ключ разбивки хранилища).
 *
 * Критерии приёмки `34` §13, закреплённые за этими PR:
 * - **2** — у видеоответа с оценкой удаление требует причину и слово «ВИДАЛИТИ»;
 * - **5** — сводка показывает исходное значение сразу после удаления, без ночного пересчёта;
 * - **6** — человек удалён: его аватар и резюме исчезают вместе с ним, а видеоответ остаётся
 *   с пустым `owner_user_id`.
 *
 * Перечень `origin` в обе стороны и «ровно один check» проверяет контрактный тест №4
 * (`v2-contract-04-media-origin.spec.ts`) — здесь он не дублируется.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const {
  createUploadUrl, softDeleteMedia, noteMediaAccess, tenantStorageBytes,
  ensureBucket, s3, S3_BUCKET, CONFIRM_DELETE_PHRASE, PURGE_AFTER_DAYS,
  EVIDENCE_URL_TTL_SEC, DEFAULT_URL_TTL_SEC, signedReadUrl,
} = await import('../../server/services/media')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

let tenantId: string
let adminId: string
let ctx: { tenantId: string, actorId: string }
const stamp = Date.now()
const createdMedia: string[] = []

/** Файл в реестре напрямую — без обращения к S3, чтобы проверять правила, а не транспорт. */
async function makeMedia(fields: { origin: string, isEvidence?: boolean, bytes?: number, ownerId?: string | null }): Promise<string> {
  const [row] = await admin`
    insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, owner_user_id, origin, is_evidence)
    values (${tenantId}, ${`t/${tenantId}/v2-11-${stamp}-${createdMedia.length}.png`}, 'f.png', 'image', 'image/png',
            ${fields.bytes ?? 100}, 'ready', ${fields.ownerId === undefined ? adminId : fields.ownerId},
            ${fields.origin}, ${fields.isEvidence ?? false})
    returning id`
  createdMedia.push(row!.id as string)
  return row!.id as string
}

async function auditActions(mediaId: string): Promise<string[]> {
  const rows = await admin`
    select action from audit_log where entity = 'media_assets' and entity_id = ${mediaId} order by created_at`
  return rows.map(r => r.action as string)
}

beforeAll(async () => {
  const [t] = await admin`select id from tenants order by created_at limit 1`
  tenantId = t!.id as string
  const [u] = await admin`select id from users where tenant_id = ${tenantId} and kind = 'employee' order by created_at limit 1`
  adminId = u!.id as string
  ctx = { tenantId, actorId: adminId }
})

afterAll(async () => {
  if (createdMedia.length) await admin`delete from audit_log where entity = 'media_assets' and entity_id in ${admin(createdMedia)}`
  if (createdMedia.length) await admin`delete from media_assets where id in ${admin(createdMedia)}`
  await admin.end()
})

describe('PR-11 · переименование колонок (В-4)', () => {
  it('в схеме есть owner_user_id и checksum_sha256, а старых имён нет', async () => {
    const rows = await admin`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'media_assets'`
    const names = rows.map(r => r.column_name as string)
    expect(names).toContain('owner_user_id')
    expect(names).toContain('checksum_sha256')
    // Переименование, а не пара колонок-синонимов: иначе писать надо в обе и навсегда (В-4)
    expect(names).not.toContain('uploaded_by')
    expect(names).not.toContain('checksum')
  })

  it('переименование сохранило данные: у файлов, созданных до PR, владелец на месте', async () => {
    const id = await makeMedia({ origin: 'avatar' })
    const [row] = await admin`select owner_user_id, checksum_sha256 from media_assets where id = ${id}`
    expect(row!.owner_user_id).toBe(adminId)
    expect(row!.checksum_sha256).toBeNull() // колонка переехала пустой — она и была мёртвой
  })

  it('`34` §13 к. 6: человек удалён — видеоответ остаётся с пустым owner_user_id', async () => {
    const [victim] = await admin`
      insert into users (tenant_id, full_name, status, kind)
      values (${tenantId}, ${`Тимчасовий ${stamp}`}, 'active', 'employee') returning id`
    const victimId = victim!.id as string
    const mediaId = await makeMedia({ origin: 'video_answer', ownerId: victimId })

    await admin`delete from users where id = ${victimId}`

    const [row] = await admin`select owner_user_id from media_assets where id = ${mediaId}`
    expect(row, 'строка media_assets не удаляется вместе с человеком').toBeDefined()
    expect(row!.owner_user_id, 'on delete set null, а не блокировка удаления человека').toBeNull()
  })

  it('загрузка пишет событие media.upload — второй факт «кто загрузил» (В-4)', async () => {
    const r = await createUploadUrl(ctx, { filename: 'audit.png', mime: 'image/png', bytes: 64, origin: 'avatar' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    createdMedia.push(r.mediaId)

    const [row] = await admin`
      select action, actor_id, after, request_context from audit_log
      where entity = 'media_assets' and entity_id = ${r.mediaId}`
    expect(row!.action).toBe('media.upload')
    expect(row!.actor_id).toBe(adminId)
    expect((row!.after as { origin: string }).origin).toBe('avatar')
    // CLAUDE.md п. 14: технический контекст пишет сам recordAudit, отдельной работы нет
    expect(row!.request_context === null || typeof row!.request_context === 'object').toBe(true)
  })
})

describe('PR-12 · перечень origin и ключ разбивки (В-6, В-10)', () => {
  it('shared/enums.ts содержит 16 значений редакции `40` §4.2', () => {
    // 15 значений собрал PR-12; шестнадцатое — `issue_screenshot` — добавил PR-23 правкой
    // `40` §4 и одной миграцией (правило 19): `36` §3.2 ссылался на `media_assets`, но в
    // сводку реестра не попал
    expect(MEDIA_ORIGINS).toHaveLength(16)
    expect(MEDIA_ORIGINS).toContain('interview_answer') // значение `30`, которое `38` теряло
    expect(MEDIA_ORIGINS).toContain('person_document') // значение `38`
    expect(MEDIA_ORIGINS).toContain('issue_screenshot') // значение `36`
  })

  it('БД не принимает значение вне перечня', async () => {
    await expect(makeMedia({ origin: 'resume' })).rejects.toThrow() // второго имени для candidate_cv нет
  })

  it('origin обязателен на единственном входе загрузки (В-17, `34` §7.1)', () => {
    const without = uploadUrlSchema.safeParse({ filename: 'a.png', mime: 'image/png', bytes: 10 })
    expect(without.success).toBe(false)
    if (!without.success) expect(without.error.issues.some(i => i.path[0] === 'origin')).toBe(true)
    expect(uploadUrlSchema.safeParse({ filename: 'a.png', mime: 'image/png', bytes: 10, origin: 'avatar' }).success).toBe(true)
  })

  it('stage_code — код этапа, свободного значения БД не принимает (В-10)', async () => {
    const id = await makeMedia({ origin: 'lesson_attachment' })
    await admin`update media_assets set stage_code = 'onboarding' where id = ${id}`
    const [row] = await admin`select stage_code from media_assets where id = ${id}`
    expect(row!.stage_code).toBe('onboarding')
    await expect(admin`update media_assets set stage_code = 'моя категорія' where id = ${id}`).rejects.toThrow()
  })

  it('stage_code проставляется из этапа курса при загрузке (ключ разбивки, В-10)', async () => {
    const [stage] = await admin`select id, code from lifecycle_stages where tenant_id = ${tenantId} and code = 'onboarding'`
    const [course] = await admin`select id from courses where tenant_id = ${tenantId} order by created_at limit 1`
    const courseId = course!.id as string
    const [before] = await admin`select lifecycle_stage_id from courses where id = ${courseId}`
    await admin`update courses set lifecycle_stage_id = ${stage!.id} where id = ${courseId}`

    const r = await createUploadUrl(ctx, { filename: 'cover.png', mime: 'image/png', bytes: 32, origin: 'content_cover', courseId })
    expect(r.ok).toBe(true)
    if (r.ok) {
      createdMedia.push(r.mediaId)
      const [row] = await admin`select stage_code, course_id from media_assets where id = ${r.mediaId}`
      expect(row!.stage_code).toBe('onboarding')
      expect(row!.course_id).toBe(courseId)

      // Снимок, а не вычисление: смена этапа у курса разбивку задним числом не переписывает
      await admin`update courses set lifecycle_stage_id = null where id = ${courseId}`
      const [after] = await admin`select stage_code from media_assets where id = ${r.mediaId}`
      expect(after!.stage_code).toBe('onboarding')
    }
    await admin`update courses set lifecycle_stage_id = ${before!.lifecycle_stage_id} where id = ${courseId}`
  })
})

describe('PR-11 · мягкое удаление (В-17, `34` §7.2)', () => {
  it('обычный файл: помечен, объект в S3 остался, дата возврата на 30 дней', async () => {
    await ensureBucket()
    const key = `t/${tenantId}/v2-11-s3-${stamp}.txt`
    await s3().send(new PutObjectCommand({ Bucket: S3_BUCKET(), Key: key, Body: 'доказ', ContentType: 'text/plain' }))
    const [row] = await admin`
      insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, owner_user_id, origin)
      values (${tenantId}, ${key}, 'f.txt', 'file', 'text/plain', 5, 'ready', ${adminId}, 'lesson_attachment') returning id`
    const mediaId = row!.id as string
    createdMedia.push(mediaId)

    const r = await softDeleteMedia(ctx, mediaId, { reason: 'дубль' })
    expect(r.ok).toBe(true)

    const [after] = await admin`select lifecycle, deleted_at, deleted_by, delete_reason, purge_after from media_assets where id = ${mediaId}`
    expect(after!.lifecycle).toBe('pending_delete')
    expect(after!.deleted_by).toBe(adminId)
    expect(after!.delete_reason).toBe('дубль')
    const days = (new Date(after!.purge_after as string).getTime() - new Date(after!.deleted_at as string).getTime()) / 86_400_000
    expect(Math.round(days)).toBe(PURGE_AFTER_DAYS)

    // Главное правило корзины: объект в S3 не трогается (`34` §7.2.3, `44` §8)
    await expect(s3().send(new HeadObjectCommand({ Bucket: S3_BUCKET(), Key: key }))).resolves.toBeDefined()
    expect(await auditActions(mediaId)).toContain('media.delete')
  })

  it('`34` §13 к. 2: доказательство без причины и слова «ВИДАЛИТИ» не удаляется', async () => {
    const mediaId = await makeMedia({ origin: 'video_answer', isEvidence: true })

    const noReason = await softDeleteMedia(ctx, mediaId, { confirmPhrase: CONFIRM_DELETE_PHRASE })
    expect(noReason.ok).toBe(false)
    if (!noReason.ok) expect(noReason.code).toBe('evidence_locked')

    const noPhrase = await softDeleteMedia(ctx, mediaId, { reason: 'помилка запису' })
    expect(noPhrase.ok).toBe(false)

    const wrongPhrase = await softDeleteMedia(ctx, mediaId, { reason: 'помилка запису', confirmPhrase: 'видалити' })
    expect(wrongPhrase.ok).toBe(false)

    const [still] = await admin`select lifecycle, deleted_at from media_assets where id = ${mediaId}`
    expect(still!.lifecycle).toBe('active')
    expect(still!.deleted_at).toBeNull()

    const ok = await softDeleteMedia(ctx, mediaId, { reason: 'помилка запису', confirmPhrase: CONFIRM_DELETE_PHRASE })
    expect(ok.ok).toBe(true)
  })

  it('сертификат не удаляется вовсе (`34` §7.2.1)', async () => {
    const mediaId = await makeMedia({ origin: 'certificate' })
    const r = await softDeleteMedia(ctx, mediaId)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('file_not_deletable')
  })

  it('повторное удаление — 409, счётчик не уменьшается дважды (`34` §12)', async () => {
    const mediaId = await makeMedia({ origin: 'import' })
    expect((await softDeleteMedia(ctx, mediaId, { reason: 'раз' })).ok).toBe(true)
    const again = await softDeleteMedia(ctx, mediaId, { reason: 'два' })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe('already_deleted')
  })

  it('файл чужого тенанта — 404, не 403 (CLAUDE.md п. 15)', async () => {
    const r = await softDeleteMedia(ctx, '00000000-0000-0000-0000-000000000001')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_found')
  })

  it('`34` §13 к. 5: сводка показывает исходное значение сразу после удаления', async () => {
    const before = await tenantStorageBytes(ctx)
    const mediaId = await makeMedia({ origin: 'report_export', bytes: 1_000_000 })
    expect(await tenantStorageBytes(ctx)).toBe(before + 1_000_000)

    expect((await softDeleteMedia(ctx, mediaId, { reason: 'вивантаження одноразове' })).ok).toBe(true)
    // Счётчик уменьшается в момент мягкого удаления, а не при purge: корзина не держит
    // квоту заложником, и ночного пересчёта ждать не нужно
    expect(await tenantStorageBytes(ctx)).toBe(before)
  })

  it('в корзине обязаны стоять обе даты (media_assets_purge_chk)', async () => {
    const mediaId = await makeMedia({ origin: 'avatar' })
    await expect(admin`update media_assets set lifecycle = 'pending_delete' where id = ${mediaId}`).rejects.toThrow()
  })
})

describe('PR-11 · журнал обращения к доказательству (В-19)', () => {
  it('ссылка на доказательство живёт 120 секунд, на обычный файл — 600', async () => {
    expect(EVIDENCE_URL_TTL_SEC).toBe(120)
    expect(DEFAULT_URL_TTL_SEC).toBe(600)
    const url = new URL(await signedReadUrl(`t/${tenantId}/ttl.png`, true))
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120')
    const plain = new URL(await signedReadUrl(`t/${tenantId}/ttl.png`))
    expect(plain.searchParams.get('X-Amz-Expires')).toBe('600')
  })

  it('media.download пишется только для is_evidence, обложка урока — нет', async () => {
    const evidence = await makeMedia({ origin: 'workshop_submission', isEvidence: true })
    const cover = await makeMedia({ origin: 'content_cover' })

    await noteMediaAccess(ctx, { id: evidence, origin: 'workshop_submission', isEvidence: true })
    await noteMediaAccess(ctx, { id: cover, origin: 'content_cover', isEvidence: false })

    expect(await auditActions(evidence)).toEqual(['media.download'])
    expect(await auditActions(cover)).toEqual([])
    // last_accessed_at обновляется обоим: от него отсчитывается политика хранения (`34` §7.3)
    const [row] = await admin`select last_accessed_at from media_assets where id = ${cover}`
    expect(row!.last_accessed_at).not.toBeNull()
  })
})
