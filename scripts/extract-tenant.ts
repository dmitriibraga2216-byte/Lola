import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'

/**
 * Выгрузка одного тенанта (docs/25 §11 «Вынос тенанта в отдельную базу», §16.3 «Песочница
 * тенанта»): все строки со своим `tenant_id` во всех таблицах + список/копия объектов S3
 * под префиксом `t/<tenant_id>/`. Долг `28` Spec 25 отк. (6) / docs/33 D-058.
 *
 * Использование:
 *   tsx scripts/extract-tenant.ts <tenantId> [--out <dir>] [--anonymize] [--skip-media]
 *
 * Порядок таблиц в манифесте — по зависимостям (родители раньше детей), тот же принцип,
 * что и у `purgeTenantData` (server/services/platformTenants.ts), только в обратную сторону:
 * там таблица, которую ещё держит внешний ключ, откладывается на следующий проход при
 * удалении; здесь порядок нужен, чтобы восстановление в чистую схему не упёрлось в FK.
 *
 * `--anonymize` (докс/25 §16.3 «обезличенный слепок», отдельная платная операция, не кнопка
 * в интерфейсе): в любой таблице обнуляются столбцы `request_context` (IP/geo/user-agent,
 * CLAUDE.md п. 14), их старые парные столбцы `ip`/`user_agent` (security_log/audit_log, докс/16
 * §15), `password_hash` (секрет, не переживает даже обычный бэкап-слепок для показа) и типовые
 * персональные столбцы (`phone`, `email`, `full_name`, `first_name`, `last_name`, `middle_name`,
 * `latin_name`, `avatar_key`, `telegram_chat_id`, `external_id`, `birth_date`, `work_contacts`,
 * `comment`) — по имени столбца, а не по конкретной таблице, поэтому работает и для `users`,
 * и для любой будущей таблицы с теми же именами. Результаты обучения (баллы, статусы, прогресс)
 * не трогаются. Известное ограничение: сырые данные внутри jsonb (например, `import_batches.rows`
 * с необработанными строками импорта) не разбираются — если понадобится обезличивать такие
 * блоки, это отдельная задача.
 */

const PII_COLUMNS = new Set([
  'phone', 'email', 'full_name', 'first_name', 'last_name', 'middle_name', 'latin_name',
  'avatar_key', 'telegram_chat_id', 'external_id', 'birth_date', 'work_contacts', 'comment',
])
// `request_context` (CLAUDE.md п. 14) и его старые парные столбцы `ip`/`user_agent` в security_log/audit_log
// (докс/16 §15) — обнуляются всегда; `password_hash` — не персональные данные, но секрет, тоже не переживает.
const GENERIC_SCRUB_COLUMNS = new Set(['request_context', 'ip', 'user_agent', 'password_hash'])

interface Args { tenantId: string, outDir: string, anonymize: boolean, skipMedia: boolean }

function parseArgs(argv: string[]): Args {
  const [tenantId, ...rest] = argv
  if (!tenantId) {
    console.error('Использование: tsx scripts/extract-tenant.ts <tenantId> [--out <dir>] [--anonymize] [--skip-media]')
    process.exit(1)
  }
  let outDir = join('tmp', 'extract-tenant')
  let anonymize = false
  let skipMedia = false
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out') outDir = rest[++i] ?? outDir
    else if (rest[i] === '--anonymize') anonymize = true
    else if (rest[i] === '--skip-media') skipMedia = true
  }
  return { tenantId, outDir, anonymize, skipMedia }
}

/** Таблицы с tenant_id — тот же запрос, что у `tenantTables()` в platformTenants.ts. */
async function tenantTables(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ t: string }[]>`
    select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
    order by c.relname`
  return rows.map(r => r.t)
}

/**
 * Топологический порядок «родители раньше детей» среди переданных таблиц по внешним ключам
 * между ними (внешние ключи на таблицы вне списка — например, на справочники без tenant_id —
 * не учитываются, они не часть выгрузки). Цикл (SET CONSTRAINTS DEFERRED в схеме не встречался)
 * разрывается — таблица идёт в оставшемся порядке, это не должно случиться при консистентной схеме.
 */
async function dependencyOrder(sql: postgres.Sql, tables: string[]): Promise<string[]> {
  const set = new Set(tables)
  const deps = new Map<string, Set<string>>(tables.map(t => [t, new Set<string>()]))
  const rows = await sql<{ child: string, parent: string }[]>`
    select c.relname as child, p.relname as parent
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_class p on p.oid = con.confrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and con.contype = 'f' and c.relname != p.relname`
  for (const r of rows) {
    if (set.has(r.child) && set.has(r.parent)) deps.get(r.child)!.add(r.parent)
  }
  const ordered: string[] = []
  const done = new Set<string>()
  let guard = 0
  while (ordered.length < tables.length && guard++ < tables.length * tables.length + 1) {
    for (const t of tables) {
      if (done.has(t)) continue
      const parents = deps.get(t)!
      if ([...parents].every(p => done.has(p) || p === t)) {
        ordered.push(t)
        done.add(t)
      }
    }
  }
  for (const t of tables) if (!done.has(t)) ordered.push(t) // цикл — добавляем как есть, лучше, чем потерять таблицу
  return ordered
}

function anonymizeRow(row: Record<string, unknown>, counter: { n: number }): Record<string, unknown> {
  const out = { ...row }
  for (const col of Object.keys(out)) {
    if (GENERIC_SCRUB_COLUMNS.has(col)) out[col] = null
    else if (col === 'full_name' && out[col] != null) out[col] = `Людина ${++counter.n}`
    else if (PII_COLUMNS.has(col)) out[col] = col === 'work_contacts' ? {} : null
  }
  return out
}

async function extractMedia(tenantId: string, outDir: string): Promise<{ count: number, error: string | null }> {
  try {
    const { s3, S3_BUCKET } = await import('../server/services/media')
    const { ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3')
    const client = s3()
    const bucket = S3_BUCKET()
    const prefix = `t/${tenantId}/`
    let token: string | undefined
    let count = 0
    const mediaDir = join(outDir, 'media')
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
      for (const obj of page.Contents ?? []) {
        if (!obj.Key) continue
        const rel = obj.Key.slice(prefix.length)
        const dest = join(mediaDir, rel)
        await mkdir(join(dest, '..'), { recursive: true })
        const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }))
        const buf = Buffer.from(await got.Body!.transformToByteArray())
        await writeFile(dest, buf)
        count++
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return { count, error: null }
  }
  catch (err) {
    return { count: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

async function main() {
  const { tenantId, outDir, anonymize, skipMedia } = parseArgs(process.argv.slice(2))
  const url = process.env.DATABASE_ADMIN_URL
  if (!url) {
    console.error('DATABASE_ADMIN_URL не задан')
    process.exit(1)
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} })

  const [tenant] = await sql`select id, slug, name, status, created_at from tenants where id = ${tenantId}`
  if (!tenant) {
    console.error(`Тенант ${tenantId} не найден`)
    await sql.end()
    process.exit(1)
  }

  const dest = join(outDir, `${tenant.slug}-${Date.now()}`)
  await mkdir(dest, { recursive: true })

  const tables = await tenantTables(sql)
  const order = await dependencyOrder(sql, tables)

  const rowCounts: Record<string, number> = {}
  const nameCounter = { n: 0 }
  await writeFile(join(dest, 'tenant.json'), JSON.stringify(anonymize ? { ...tenant, name: tenant.slug, slug: tenant.slug } : tenant, null, 2))

  for (const table of order) {
    const rows = await sql`select * from ${sql(table)} where tenant_id = ${tenantId}`
    const data = anonymize ? rows.map(r => anonymizeRow(r as Record<string, unknown>, nameCounter)) : rows
    rowCounts[table] = data.length
    await writeFile(join(dest, `${table}.json`), JSON.stringify(data, null, 2))
  }

  let media: { count: number, error: string | null } = { count: 0, error: null }
  if (!skipMedia) media = await extractMedia(tenantId, dest)

  const manifest = {
    tenantId, slug: tenant.slug, extractedAt: new Date().toISOString(), anonymized: anonymize,
    tableOrder: order, rowCounts, totalRows: Object.values(rowCounts).reduce((a, b) => a + b, 0),
    media,
  }
  await writeFile(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(`Тенант ${tenant.slug} выгружен в ${dest}: ${manifest.totalRows} строк в ${order.length} таблицах, медиа: ${media.count}${media.error ? ` (ошибка: ${media.error})` : ''}${anonymize ? ' — обезличено' : ''}`)
  await sql.end()
}

await main()
