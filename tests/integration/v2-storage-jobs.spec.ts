import { readFileSync, readdirSync } from 'node:fs'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Фоновые задачи хранилища `docs/v2/34-storage.md` §11 сверх корзины: `storage.retention_scan`,
 * `.orphan_scan`, `.object_reconcile`, `.quota_warn` (блок «Хранилище» журнала `46`).
 *
 * Первые три — **сухой прогон** (`docs/v2/44` §11 Р-S1): отчёт в `audit_log`, ни одна строка
 * `media_assets` и ни один объект S3 не меняются. Бакет подменяется листингом-заглушкой — тот же
 * приём, что заменяемый удалитель `interview/mediaPurge.ts`. `quota_warn` — настоящий: повторы
 * `limit_warning` / `limit_exceeded` по частоте §7.5 п. 3.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const {
  retentionScan, orphanScan, objectReconcile, quotaWarn, quotaWarnLevel, latestScans, setStorageObjectLister,
  MEDIA_REFERENCE_SOURCES, ORPHAN_MIN_AGE_DAYS,
} = await import('../../server/services/storageScans')
const { invalidateLimits } = await import('../../server/services/tenantLimits')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })
const stamp = Date.now()

let tenantId: string
let adminId: string
let adminCtx: { tenantId: string, actorId: string }
const createdMedia: string[] = []
let savedAvatar: string | null = null
/** Прежнее переопределение лимита: `undefined` — строки `tenant_limits` не было. */
let savedStorageGb: number | null | undefined

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()

async function makeMedia(f: { origin: string, bytes?: number, createdAt?: string, isEvidence?: boolean, lifecycle?: string, status?: string, sourceId?: string | null, key?: string }): Promise<{ id: string, key: string }> {
  const key = f.key ?? `t/${tenantId}/jobs-${stamp}-${createdMedia.length}.bin`
  const [row] = await admin`
    insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, owner_user_id, origin, is_evidence, created_at, lifecycle, source_entity, source_id)
    values (${tenantId}, ${key}, ${`f-${createdMedia.length}.bin`}, 'file', 'application/pdf', ${f.bytes ?? 1000}, ${f.status ?? 'ready'}, ${adminId},
            ${f.origin}, ${f.isEvidence ?? false}, ${f.createdAt ?? new Date().toISOString()}, ${f.lifecycle ?? 'active'},
            ${f.sourceId ? 'resources' : null}, ${f.sourceId ?? null})
    returning id`
  createdMedia.push(row!.id as string)
  return { id: row!.id as string, key }
}

async function lifecycleOf(ids: string[]): Promise<string[]> {
  const rows = await admin`select lifecycle from media_assets where id = any(${ids}::uuid[]) order by id`
  return rows.map(r => r.lifecycle as string)
}

async function lastReport(action: string, since: Date): Promise<Record<string, unknown> | null> {
  const [r] = await admin`select after from audit_log where tenant_id = ${tenantId} and action = ${action} and created_at >= ${since} order by created_at desc limit 1`
  return (r?.after as Record<string, unknown>) ?? null
}

async function dbNow(): Promise<Date> {
  const [r] = await admin`select now() as now`
  return r!.now as Date
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  adminCtx = { tenantId, actorId: adminId }
  savedAvatar = ((await admin`select avatar_key from users where id = ${adminId}`)[0]!.avatar_key as string | null) ?? null
  await admin`delete from storage_retention_policies where tenant_id = ${tenantId}`
})

afterAll(async () => {
  setStorageObjectLister(null)
  await admin`update users set avatar_key = ${savedAvatar} where id = ${adminId}`
  if (createdMedia.length) await admin`delete from media_assets where id = any(${createdMedia}::uuid[])`
  await admin`delete from storage_retention_policies where tenant_id = ${tenantId}`
  if (savedStorageGb === undefined) await admin`delete from tenant_limits where tenant_id = ${tenantId}`
  else await admin`update tenant_limits set storage_gb = ${savedStorageGb} where tenant_id = ${tenantId}`
  invalidateLimits(tenantId)
  await admin.end()
})

describe('storage.retention_scan — политики всухую (§7.3, §11)', () => {
  const oldIds: string[] = []
  let evidenceId: string

  beforeAll(async () => {
    await retentionScan(tenantId) // досеять строки политик
    await admin`
      update storage_retention_policies
         set enabled = true, keep_months = 3, anchor = 'created_at', action = 'purge', keep_evidence = true,
             warn_days_before = 14, max_batch_per_run = 2
       where tenant_id = ${tenantId} and origin = 'import'`
    for (let i = 0; i < 3; i++) oldIds.push((await makeMedia({ origin: 'import', createdAt: daysAgo(200), bytes: 500 })).id)
    evidenceId = (await makeMedia({ origin: 'import', createdAt: daysAgo(200), isEvidence: true })).id
    await makeMedia({ origin: 'import', createdAt: daysAgo(85) }) // срок истечёт через ≈5 дней — в окне предупреждения
    await makeMedia({ origin: 'import', createdAt: daysAgo(10) }) // свежий
  })

  it('считает, что взяла бы политика, с потолком за прогон и окном предупреждения', async () => {
    const since = await dbNow()
    const r = await retentionScan(tenantId)
    const p = r.policies.find(x => x.origin === 'import')!
    expect(p.files).toBeGreaterThanOrEqual(3)
    expect(p.bytes).toBeGreaterThanOrEqual(1500)
    expect(p.batchFiles).toBe(2) // max_batch_per_run — «не снести всё разом»
    expect(p.evidenceCount).toBe(0) // keep_evidence: доказательство не в счёт
    expect(p.upcomingFiles).toBeGreaterThanOrEqual(1)
    expect(r.dryRun).toBe(true)

    const report = await lastReport('storage.retention_scan', since)
    expect(report).toMatchObject({ dryRun: true })
    const [row] = await admin`select actor_id, entity from audit_log where tenant_id = ${tenantId} and action = 'storage.retention_scan' order by created_at desc limit 1`
    expect(row).toMatchObject({ actor_id: null, entity: 'storage_retention_policies' })
  })

  it('ничего не удаляет: файлы остаются active, квота не меняется', async () => {
    const before = await admin`select coalesce(sum(bytes), 0)::bigint as b from storage_usage_counters where tenant_id = ${tenantId}`
    await retentionScan(tenantId)
    expect(await lifecycleOf([...oldIds, evidenceId])).toEqual(Array(4).fill('active'))
    const after = await admin`select coalesce(sum(bytes), 0)::bigint as b from storage_usage_counters where tenant_id = ${tenantId}`
    expect(after[0]!.b).toBe(before[0]!.b)
  })

  it('keep_evidence=false считает и доказательства', async () => {
    await admin`update storage_retention_policies set keep_evidence = false where tenant_id = ${tenantId} and origin = 'import'`
    const r = await retentionScan(tenantId)
    expect(r.policies.find(x => x.origin === 'import')!.evidenceCount).toBeGreaterThanOrEqual(1)
    await admin`update storage_retention_policies set keep_evidence = true where tenant_id = ${tenantId} and origin = 'import'`
  })

  it('незавершённая загрузка старше суток — в отчёте мусора, не тронута', async () => {
    const stale = await makeMedia({ origin: 'other', status: 'uploading', createdAt: daysAgo(2), bytes: 777 })
    const r = await retentionScan(tenantId)
    expect(r.staleUploads.files).toBeGreaterThanOrEqual(1)
    expect(r.staleUploads.bytes).toBeGreaterThanOrEqual(777)
    expect(await lifecycleOf([stale.id])).toEqual(['active'])
  })

  it('выключенная политика в отчёт не попадает', async () => {
    await admin`update storage_retention_policies set enabled = false where tenant_id = ${tenantId} and origin = 'import'`
    const r = await retentionScan(tenantId)
    expect(r.policies.find(x => x.origin === 'import')).toBeUndefined()
  })
})

describe('storage.orphan_scan — файлы без ссылок всухую (§7.6 п. 3)', () => {
  it('находит старый файл без ссылок; ссылка ключом, источник и свежесть — не сироты; lifecycle не меняется', async () => {
    const lonely = await makeMedia({ origin: 'other', createdAt: daysAgo(ORPHAN_MIN_AGE_DAYS + 3), bytes: 4321 })
    const avatar = await makeMedia({ origin: 'avatar', createdAt: daysAgo(30) })
    await admin`update users set avatar_key = ${avatar.key} where id = ${adminId}`
    const sourced = await makeMedia({ origin: 'lesson_attachment', createdAt: daysAgo(30), sourceId: adminId })
    const fresh = await makeMedia({ origin: 'other', createdAt: daysAgo(1) })
    const cert = await makeMedia({ origin: 'certificate', createdAt: daysAgo(30) })

    const since = await dbNow()
    const r = await orphanScan(tenantId)
    const ids = new Set(r.sample)
    expect(r.dryRun).toBe(true)
    expect(r.found).toBeGreaterThanOrEqual(1)
    expect(r.byOrigin.other?.bytes).toBeGreaterThanOrEqual(4321)
    if (r.found <= r.sample.length) {
      expect(ids.has(lonely.id)).toBe(true)
    }
    for (const x of [avatar, sourced, fresh, cert]) expect(ids.has(x.id)).toBe(false)
    expect(await lifecycleOf([lonely.id])).toEqual(['active'])
    expect(await lastReport('storage.orphan_scan', since)).toMatchObject({ dryRun: true })
  })

  it('каталог ссылок покрывает каждую колонку схемы, ссылающуюся на файл', () => {
    const catalog = new Set(MEDIA_REFERENCE_SOURCES.flatMap(s => s.columns.map(c => `${s.table}.${c}`)))
    const dir = 'server/db/schema'
    const missing: string[] = []
    // Служебные колонки, которые файлом не владеют: заявка на удаление, счёт оператора (платформа, вне тенанта)
    const ignore = new Set(['storage_deletion_requests.media_ids', 'tenant_payments.invoice_media_id', 'media_assets.poster_key'])
    for (const f of readdirSync(dir).filter(n => n.endsWith('.ts'))) {
      let table = ''
      for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
        const t = line.match(/pgTable\('([a-z_0-9]+)'/)
        if (t) table = t[1]!
        const c = line.match(/(?:uuid|text)\('([a-z_0-9]+)'\)/)
        if (!c || !table) continue
        const col = c[1]!
        const isRef = /references\(\(\) => mediaAssets\.id/.test(line)
          || /(^|_)media_ids?$|_media_id$|^avatar_key$|^cover_key$|^icon_key$|^card_image_key$|^image_key$|^telegram_image_key$|^pdf_key$|^file_key$|^report_key$|^resume_asset_id$|^instruction_media$/.test(col)
        if (isRef && !catalog.has(`${table}.${col}`) && !ignore.has(`${table}.${col}`)) missing.push(`${table}.${col}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('storage.object_reconcile — сверка с бакетом всухую (§7.4 п. 2)', () => {
  it('объект без строки, строка без объекта, purged с объектом — счётчиками; ничего не меняется', async () => {
    const present = await makeMedia({ origin: 'other', createdAt: daysAgo(5) })
    const gone = await makeMedia({ origin: 'other', createdAt: daysAgo(5), bytes: 2222 })
    const purged = await makeMedia({ origin: 'other', createdAt: daysAgo(90), lifecycle: 'purged' })
    const inFlight = await makeMedia({ origin: 'other' }) // моложе суток — не «пропал»
    const stray = `t/${tenantId}/stray-${stamp}.bin`
    let asked = ''
    setStorageObjectLister(async (prefix) => {
      asked = prefix
      return [
        { key: present.key, bytes: 1000 },
        { key: purged.key, bytes: 1000 },
        { key: stray, bytes: 5000 },
      ]
    })

    const since = await dbNow()
    const r = await objectReconcile(tenantId)
    expect(asked).toBe(`t/${tenantId}/`)
    expect(r.dryRun).toBe(true)
    expect(r.objects).toEqual({ files: 3, bytes: 7000 })
    expect(r.unregistered.sample).toEqual([stray])
    expect(r.unregistered.bytes).toBe(5000)
    expect(r.purgedAwaiting).toEqual({ files: 1, bytes: 1000 })
    expect(r.missing.sample).toContain(gone.id)
    expect(r.missing.sample).not.toContain(present.id)
    expect(r.missing.sample).not.toContain(inFlight.id)
    expect(await lifecycleOf([gone.id])).toEqual(['active'])
    const [n] = await admin`select count(*)::int as n from media_assets where tenant_id = ${tenantId} and key = ${stray}`
    expect(n!.n).toBe(0)
    expect(await lastReport('storage.object_reconcile', since)).toMatchObject({ dryRun: true })
  })

  it('отказ листинга — исключение, отчёта нет (задача уйдёт в повтор)', async () => {
    setStorageObjectLister(async () => { throw new Error('S3 down') })
    const since = await dbNow()
    await expect(objectReconcile(tenantId)).rejects.toThrow('S3 down')
    expect(await lastReport('storage.object_reconcile', since)).toBeNull()
    setStorageObjectLister(null)
  })
})

describe('GET /storage/scans — последние отчёты своего тенанта', () => {
  it('отдаёт по одному отчёту каждой задачи; чужой тенант их не видит (CLAUDE.md п. 15)', async () => {
    const view = await latestScans(adminCtx)
    expect(view.orphans?.report.dryRun).toBe(true)
    expect(view.objects?.report.dryRun).toBe(true)
    expect(view.retention?.report.dryRun).toBe(true)

    const [other] = await admin`select id from tenants where id <> ${tenantId} order by created_at limit 1`
    if (other) {
      const [u] = await admin`select id from users where tenant_id = ${other.id} limit 1`
      if (u) {
        const foreign = await latestScans({ tenantId: other.id as string, actorId: u.id as string })
        const own = [view.orphans?.at, view.objects?.at, view.retention?.at]
        for (const x of [foreign.orphans, foreign.objects, foreign.retention]) if (x) expect(own).not.toContain(x.at)
      }
    }
  })
})

describe('storage.quota_warn — напоминания 80 / 95 / 100 % (§7.5 п. 3)', () => {
  it('частота по заполненности', () => {
    expect(quotaWarnLevel(null)).toBe('none')
    expect(quotaWarnLevel(79.9)).toBe('none')
    expect(quotaWarnLevel(80)).toBe('weekly')
    expect(quotaWarnLevel(94.9)).toBe('weekly')
    expect(quotaWarnLevel(95)).toBe('daily')
    expect(quotaWarnLevel(100)).toBe('exceeded')
  })

  async function fillTo(share: number): Promise<string> {
    const [c] = await admin`select coalesce(sum(bytes), 0)::bigint as b from storage_usage_counters where tenant_id = ${tenantId}`
    const need = Math.round(1024 ** 3 * share) - Number(c!.b)
    return (await makeMedia({ origin: 'other', bytes: Math.max(1, need) })).id
  }

  async function warnings(code: string): Promise<number> {
    const [r] = await admin`select count(*)::int as n from notifications where tenant_id = ${tenantId} and code = ${code} and payload ->> 'axis' = 'storage_bytes'`
    return r!.n as number
  }

  beforeAll(async () => {
    await admin`delete from notifications where tenant_id = ${tenantId} and code in ('limit_warning', 'limit_exceeded') and payload ->> 'axis' = 'storage_bytes'`
    const [prev] = await admin`select storage_gb from tenant_limits where tenant_id = ${tenantId}`
    savedStorageGb = prev ? (prev.storage_gb as number | null) : undefined
    await admin`insert into tenant_limits (tenant_id, storage_gb) values (${tenantId}, 1) on conflict (tenant_id) do update set storage_gb = 1`
    invalidateLimits(tenantId)
  })

  it('95 % — ежедневно: письмо админам, повтор в тот же день не дублирует', async () => {
    const id = await fillTo(0.97)
    const first = await quotaWarn(tenantId)
    expect(first.level).toBe('daily')
    expect(first.sent).toBeGreaterThan(0)
    const n = await warnings('limit_warning')
    const again = await quotaWarn(tenantId)
    expect(again.sent).toBe(0)
    expect(await warnings('limit_warning')).toBe(n)
    await admin`delete from media_assets where id = ${id}`
  })

  it('80 % — раз в неделю: при письме за последние 7 дней молчит', async () => {
    const id = await fillTo(0.85)
    await admin`update notifications set dedup_key = dedup_key || ':old', created_at = now() - interval '3 days' where tenant_id = ${tenantId} and code = 'limit_warning' and payload ->> 'axis' = 'storage_bytes'`
    const r = await quotaWarn(tenantId)
    expect(r.level).toBe('weekly')
    expect(r.sent).toBe(0)
    await admin`update notifications set created_at = now() - interval '8 days' where tenant_id = ${tenantId} and code = 'limit_warning' and payload ->> 'axis' = 'storage_bytes'`
    expect((await quotaWarn(tenantId)).sent).toBeGreaterThan(0)
    await admin`delete from media_assets where id = ${id}`
  })

  it('ниже 80 % — тишина', async () => {
    const r = await quotaWarn(tenantId)
    expect(r.level).toBe('none')
    expect(r.sent).toBe(0)
  })
})
