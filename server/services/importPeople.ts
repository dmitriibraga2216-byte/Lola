import ExcelJS from 'exceljs'
import { currentRequestContext } from '../utils/requestContext'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  cities, importJobs, locations, orgUnits, positionLevels, positions, roles,
  userPlacements, userRoles, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { applyPositionRoles } from './positionRoleMap'
import { enqueueNotification } from './notifications'
import { splitName } from './people'
import { phoneSchema } from '../../shared/schemas/auth'

/**
 * Импорт людей (docs/06-infra.md §6.5): разбор файла → построчная валидация →
 * предпросмотр → применение батчами по 200 → отчёт.
 */

export const IMPORT_COLUMNS = [
  'ПІБ', 'Телефон', 'Email', 'Посада', 'Рівень посади', 'Місто',
  'Підрозділ', 'Точка', 'Роль', 'Мітки', 'Дата найму', 'Зовнішній ID',
  'Прізвище', 'Імʼя', 'По батькові', 'Дата народження',
] as const
export type ImportColumn = typeof IMPORT_COLUMNS[number]

/** Синонимы заголовков для автосопоставления (docs/16 §5.4 шаг 2). */
const COLUMN_ALIASES: Record<ImportColumn, string[]> = {
  'ПІБ': ['піб', 'пиб', 'фио', 'full name', 'fullname', 'name', 'імя та прізвище', 'прізвище та імя', 'працівник'],
  'Телефон': ['телефон', 'phone', 'mobile', 'тел', 'моб', 'номер'],
  'Email': ['email', 'e-mail', 'пошта', 'почта', 'mail'],
  'Посада': ['посада', 'должность', 'position', 'job title', 'title'],
  'Рівень посади': ['рівень посади', 'рівень', 'level', 'уровень', 'grade'],
  'Місто': ['місто', 'город', 'city'],
  'Підрозділ': ['підрозділ', 'подразделение', 'department', 'unit', 'org unit', 'відділ'],
  'Точка': ['точка', 'локація', 'location', 'заклад', 'магазин', 'store', 'obiekt', 'обʼєкт', 'обєкт'],
  'Роль': ['роль', 'role'],
  'Мітки': ['мітки', 'теги', 'tags', 'метки', 'tag'],
  'Дата найму': ['дата найму', 'дата прийняття', 'hired', 'hire date', 'hired at', 'дата приема', 'прийнятий'],
  'Зовнішній ID': ['зовнішній id', 'external id', 'external_id', 'ext id', 'табельний', 'табельный', 'id', 'external'],
  'Прізвище': ['прізвище', 'фамилия', 'last name', 'lastname', 'surname'],
  'Імʼя': ['імя', 'ім\'я', 'имя', 'first name', 'firstname', 'given name'],
  'По батькові': ['по батькові', 'отчество', 'middle name', 'patronymic'],
  'Дата народження': ['дата народження', 'дата рождения', 'birth date', 'birthday', 'dob', 'д.н.'],
}
const norm = (s: string) => s.toLowerCase().replace(/[ʼ'’`]/g, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Угадать сопоставление «заголовок файла → колонка шаблона». */
export function guessMapping(headers: string[]): Record<string, ImportColumn> {
  const out: Record<string, ImportColumn> = {}
  const used = new Set<ImportColumn>()
  for (const h of headers) {
    const n = norm(h)
    if (!n) continue
    const exact = IMPORT_COLUMNS.find(c => norm(c) === n)
    const hit = exact ?? (Object.entries(COLUMN_ALIASES) as [ImportColumn, string[]][]).find(([, al]) => al.some(a => norm(a) === n))?.[0]
    if (hit && !used.has(hit)) { out[h] = hit; used.add(hit) }
  }
  return out
}

export interface ImportOptions { createRefs?: boolean, archiveMissing?: boolean, sendInvites?: boolean }

export interface ImportRow {
  line: number
  fullName: string
  phone: string
  email: string
  position: string
  positionLevel: string
  city: string
  orgUnit: string
  location: string
  role: string
  tags: string[]
  hiredAt: string
  externalId: string
  lastName?: string
  firstName?: string
  middleName?: string
  birthDate?: string
  action: 'create' | 'update' | 'skip'
  errors: string[]
  warnings?: string[]
  raw?: Record<string, string> // исходная строка — для пересопоставления колонок
}

interface Ctx { tenantId: string, actorId: string }

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    if ('text' in v) return String(v.text).trim()
    if ('result' in v) return String(v.result ?? '').trim()
    if ('richText' in v) return v.richText.map(r => r.text).join('').trim()
  }
  return String(v).trim()
}

/** Разбор xlsx или csv в сырые строки по колонкам шаблона. */
export async function parseImportFile(fileName: string, buffer: Buffer): Promise<Record<string, string>[]> {
  const rows: Record<string, string>[] = []

  if (fileName.toLowerCase().endsWith('.csv')) {
    const text = buffer.toString('utf-8').replace(/^\uFEFF/, '')
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '')
    if (lines.length < 2) return []
    const parseLine = (line: string): string[] => {
      const out: string[] = []
      let cur = ''
      let quoted = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!
        if (quoted) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
          else if (ch === '"') quoted = false
          else cur += ch
        }
        else if (ch === '"') { quoted = true }
        else if (ch === ',' || ch === ';') { out.push(cur); cur = '' }
        else cur += ch
      }
      out.push(cur)
      return out.map(s => s.trim())
    }
    const header = parseLine(lines[0]!)
    for (let i = 1; i < lines.length; i++) {
      const values = parseLine(lines[i]!)
      const row: Record<string, string> = {}
      header.forEach((h, idx) => { row[h] = values[idx] ?? '' })
      rows.push(row)
    }
    return rows
  }

  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer)
  const ws = wb.worksheets[0]
  if (!ws) return []
  const header: string[] = []
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { header[col] = cellText(cell.value) })
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return
    const rec: Record<string, string> = {}
    header.forEach((h, col) => {
      if (h) rec[h] = cellText(row.getCell(col).value)
    })
    if (Object.values(rec).some(v => v !== '')) rows.push(rec)
  })
  return rows
}

/** Применить сопоставление: строка файла → строка по колонкам шаблона. */
function remap(rec: Record<string, string>, mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [h, col] of Object.entries(mapping)) if (col && rec[h] !== undefined) out[col] = rec[h]!
  return out
}

/** Построчная валидация + определение create/update (docs/16 §5.4, §12). Пишет import_job со строками. */
export async function validateImport(ctx: Ctx, fileName: string, raw: Record<string, string>[], input: { mapping?: Record<string, string>, options?: ImportOptions, jobId?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const headers = [...new Set(raw.flatMap(r => Object.keys(r)))]
    const mapping = input.mapping ?? (headers.every(h => (IMPORT_COLUMNS as readonly string[]).includes(h)) ? Object.fromEntries(headers.map(h => [h, h])) : guessMapping(headers))
    const options: ImportOptions = { createRefs: true, archiveMissing: false, sendInvites: false, ...input.options }
    const [existingPhones, existingExternal, positionRows, roleRows, cityRows, levelRows, unitRows, locRows] = await Promise.all([
      tx.select({ phone: users.phone, id: users.id }).from(users).where(sql`${users.phone} is not null`),
      tx.select({ externalId: users.externalId, id: users.id }).from(users).where(sql`${users.externalId} is not null`),
      tx.select({ name: positions.name }).from(positions),
      tx.select({ code: roles.code, name: roles.name }).from(roles),
      tx.select({ name: cities.name }).from(cities),
      tx.select({ name: positionLevels.name }).from(positionLevels),
      tx.select({ name: orgUnits.name }).from(orgUnits),
      tx.select({ name: locations.name }).from(locations),
    ])
    const phoneMap = new Map(existingPhones.map(r => [r.phone!, r.id]))
    const externalMap = new Map(existingExternal.map(r => [r.externalId!, r.id]))
    const known = {
      positions: new Set(positionRows.map(r => r.name.toLowerCase())),
      cities: new Set(cityRows.map(r => r.name.toLowerCase())),
      levels: new Set(levelRows.map(r => r.name.toLowerCase())),
      orgUnits: new Set(unitRows.map(r => r.name.toLowerCase())),
      locations: new Set(locRows.map(r => r.name.toLowerCase())),
    }
    const knownRoles = new Map(roleRows.flatMap(r => [[r.code.toLowerCase(), r.code], [r.name.toLowerCase(), r.code]] as [string, string][]))

    const seenPhones = new Map<string, number>()
    const seenExternal = new Map<string, number>()

    const rows: ImportRow[] = raw.map((src, idx) => {
      const rec = remap(src, mapping)
      const line = idx + 2 // строка в файле, после заголовка
      const errors: string[] = []
      const warnings: string[] = []

      const lastName = rec['Прізвище'] ?? ''
      const firstName = rec['Імʼя'] ?? ''
      const middleName = rec['По батькові'] ?? ''
      const fullName = rec['ПІБ'] || [lastName, firstName, middleName].filter(Boolean).join(' ')
      if (fullName.length < 2) errors.push('ПІБ: обовʼязкове')

      const externalId = rec['Зовнішній ID'] ?? ''
      let phone = rec['Телефон'] ?? ''
      if (!phone) {
        // Без телефона, но с external_id — принимается, статус invited без входа (docs/16 §12)
        if (externalId) warnings.push('Телефон: порожній — людина не зможе увійти, поки не вкажете номер')
        else errors.push('Телефон: обовʼязковий')
      }
      else {
        const parsed = phoneSchema.safeParse(phone)
        if (!parsed.success) errors.push('Телефон: невірний формат')
        else phone = parsed.data
      }

      const position = rec['Посада'] ?? ''
      if (!position) errors.push('Посада: обовʼязкова')
      const orgUnit = rec['Підрозділ'] ?? ''
      if (!orgUnit) errors.push('Підрозділ: обовʼязковий')
      const location = rec['Точка'] ?? ''
      if (!location) errors.push('Точка: обовʼязкова')

      if (!options.createRefs) {
        if (position && !known.positions.has(position.toLowerCase())) errors.push(`Посада: невідома «${position}»`)
        if (orgUnit && !known.orgUnits.has(orgUnit.toLowerCase())) errors.push(`Підрозділ: невідомий «${orgUnit}»`)
        if (location && !known.locations.has(location.toLowerCase())) errors.push(`Точка: невідома «${location}»`)
        const city = rec['Місто'] ?? ''
        if (city && !known.cities.has(city.toLowerCase())) errors.push(`Місто: невідоме «${city}»`)
        const level = rec['Рівень посади'] ?? ''
        if (level && !known.levels.has(level.toLowerCase())) errors.push(`Рівень посади: невідомий «${level}»`)
      }

      const role = rec['Роль'] ?? ''
      if (role && !knownRoles.has(role.toLowerCase())) errors.push(`Роль: невідома «${role}»`)

      const hiredAt = rec['Дата найму'] ?? ''
      if (hiredAt && !/^\d{4}-\d{2}-\d{2}$/.test(hiredAt)) errors.push('Дата найму: у форматі РРРР-ММ-ДД')
      const birthDate = rec['Дата народження'] ?? ''
      if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) errors.push('Дата народження: у форматі РРРР-ММ-ДД')

      const email = rec['Email'] ?? ''
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Email: невірний')

      // Дубликаты внутри файла
      if (phone && seenPhones.has(phone)) errors.push(`Телефон: дубль (рядок ${seenPhones.get(phone)})`)
      else if (phone) seenPhones.set(phone, line)
      if (externalId && seenExternal.has(externalId)) errors.push(`Зовнішній ID: дубль (рядок ${seenExternal.get(externalId)})`)
      else if (externalId) seenExternal.set(externalId, line)

      // Идентификация существующего: по external_id, иначе по телефону (docs/06-infra.md §6.5.6)
      const existingId = (externalId && externalMap.get(externalId)) || (phone && phoneMap.get(phone)) || null

      return {
        line,
        fullName,
        phone,
        email,
        position,
        positionLevel: rec['Рівень посади'] ?? '',
        city: rec['Місто'] ?? '',
        orgUnit,
        location,
        role,
        tags: (rec['Мітки'] ?? '').split(/[,;]/).map(s => s.trim()).filter(Boolean),
        hiredAt,
        externalId,
        lastName, firstName, middleName, birthDate,
        action: errors.length > 0 ? 'skip' : existingId ? 'update' : 'create',
        errors,
        warnings,
        raw: src,
      } satisfies ImportRow
    })

    const stats = {
      total: rows.length,
      create: rows.filter(r => r.action === 'create').length,
      update: rows.filter(r => r.action === 'update').length,
      skip: rows.filter(r => r.action === 'skip').length,
      errors: rows.filter(r => r.errors.length > 0).length,
      warnings: rows.filter(r => r.warnings?.length).length,
      newPositions: [...new Set(rows.filter(r => r.errors.length === 0 && r.position && !known.positions.has(r.position.toLowerCase())).map(r => r.position))],
      unmapped: (IMPORT_COLUMNS as readonly string[]).filter(c => ['ПІБ', 'Телефон', 'Посада', 'Підрозділ', 'Точка'].includes(c) && !Object.values(mapping).includes(c) && !(c === 'ПІБ' && Object.values(mapping).includes('Прізвище'))),
    }

    const values = { fileName, status: 'ready' as const, rows, stats, mapping, options, updatedAt: new Date() }
    let jobId = input.jobId
    if (jobId) {
      const [j] = await tx.update(importJobs).set(values).where(and(eq(importJobs.id, jobId), inArray(importJobs.status, ['ready', 'validating']))).returning({ id: importJobs.id })
      if (!j) throw new Error('import job is not editable')
    }
    else {
      const [job] = await tx.insert(importJobs).values({ tenantId: ctx.tenantId, kind: 'users', source: 'csv', createdBy: ctx.actorId, requestContext: currentRequestContext(), ...values }).returning({ id: importJobs.id })
      jobId = job!.id
    }
    return { jobId, stats, rows, headers, mapping, options }
  })
}

/** Пересопоставление колонок и/или опций (POST /people/import/:id/mapping): повторная валидация тех же строк. */
export async function remapImport(ctx: Ctx, jobId: string, input: { mapping?: Record<string, string>, options?: ImportOptions, presetName?: string }) {
  const job = await getImportJob(ctx, jobId)
  if (!job || job.status !== 'ready') return null
  const raw = (job.rows as ImportRow[]).map(r => r.raw ?? {})
  const mapping = input.mapping ?? (job.mapping as Record<string, string> | null) ?? undefined
  const options = { ...(job.options as ImportOptions), ...input.options }
  const result = await validateImport(ctx, job.fileName, raw, { mapping, options, jobId })
  if (mapping) await saveMappingPreset(ctx, input.presetName ?? 'default', mapping)
  return result
}

/** Пресеты сопоставления — в tenants.settings.importPresets (docs/16 §5.4 шаг 2). */
export async function saveMappingPreset(ctx: Ctx, name: string, mapping: Record<string, string>) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`
    update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{importPresets}', coalesce(settings->'importPresets', '{}'::jsonb) || jsonb_build_object(${name}::text, ${JSON.stringify(mapping)}::jsonb))
    where id = ${ctx.tenantId}::uuid
  `))
}
export async function listMappingPresets(ctx: Ctx): Promise<Record<string, Record<string, string>>> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [r] = await tx.execute(sql`select coalesce(settings->'importPresets', '{}'::jsonb) as p from tenants where id = ${ctx.tenantId}::uuid`) as unknown as { p: Record<string, Record<string, string>> }[]
    return r?.p ?? {}
  })
}

/** История загрузок (docs/16 §5.5 «Импорт»). */
export async function listImportJobs(ctx: Ctx) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => tx.execute(sql`
    select j.id, j.file_name, j.source, j.status, j.stats, j.created_at, j.started_at, j.finished_at, u.full_name as created_by_name
    from import_jobs j left join users u on u.id = j.created_by where j.kind = 'users' order by j.created_at desc limit 100
  `) as unknown as Promise<Record<string, unknown>[]>)
}

export async function getImportJob(ctx: Ctx, jobId: string) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [job] = await tx.select().from(importJobs).where(eq(importJobs.id, jobId))
    return job ?? null
  })
}

/** Применение батчами по 200: корректные строки применяются, ошибочные — в отчёт. */
export async function applyImport(ctx: Ctx, jobId: string) {
  const job = await getImportJob(ctx, jobId)
  if (!job || job.status !== 'ready') return null
  const options = job.options as ImportOptions
  const baseStats = job.stats as Record<string, unknown>
  const rows = job.rows as ImportRow[]
  const applicable = rows.filter(r => r.action !== 'skip')
  let created = 0
  let updated = 0
  const touched: string[] = []
  const createdIds: string[] = []

  await withTenant(ctx.tenantId, ctx.actorId, tx => tx.update(importJobs).set({ status: 'applying', startedAt: new Date(), updatedAt: new Date() }).where(eq(importJobs.id, jobId)))
  try {
    await applyBatches()
  }
  catch (err) {
    await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
      await tx.update(importJobs).set({ status: 'failed', finishedAt: new Date(), stats: { ...(job.stats as Record<string, unknown>), created, updated, error: String((err as Error).message ?? err) }, updatedAt: new Date() }).where(eq(importJobs.id, jobId))
      if (job.createdBy) await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: job.createdBy, code: 'import_failed', payload: { file: job.fileName, error: String((err as Error).message ?? err) }, dedupKey: `import_failed:${jobId}`, urgent: true })
    })
    throw err
  }

  async function applyBatches() {
  for (let offset = 0; offset < applicable.length; offset += 200) {
    const batch = applicable.slice(offset, offset + 200)

    await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
      // Справочники батча: автосоздание отсутствующих
      const wanted = {
        cities: [...new Set(batch.map(r => r.city).filter(Boolean))],
        levels: [...new Set(batch.map(r => r.positionLevel).filter(Boolean))],
        positions: [...new Set(batch.map(r => r.position).filter(Boolean))],
        orgUnits: [...new Set(batch.map(r => r.orgUnit).filter(Boolean))],
        locations: [...new Set(batch.map(r => r.location).filter(Boolean))],
      }

      if (wanted.cities.length) {
        await tx.insert(cities)
          .values(wanted.cities.map(name => ({ tenantId: ctx.tenantId, name })))
          .onConflictDoNothing()
      }
      if (wanted.levels.length) {
        await tx.insert(positionLevels)
          .values(wanted.levels.map(name => ({ tenantId: ctx.tenantId, name })))
          .onConflictDoNothing()
      }
      if (wanted.orgUnits.length) {
        // Уникальность org_units — по path, а не по имени: не плодим «Каппі» с кириллическим путём рядом с «kappi»
        const existingUnits = new Set((await tx.select({ name: orgUnits.name }).from(orgUnits)).map(u => u.name.toLowerCase()))
        wanted.orgUnits = wanted.orgUnits.filter(name => !existingUnits.has(name.toLowerCase()))
      }
      if (wanted.orgUnits.length) {
        await tx.insert(orgUnits)
          .values(wanted.orgUnits.map(name => ({
            tenantId: ctx.tenantId,
            name,
            path: name.toLowerCase().replace(/[^a-z0-9а-яіїєґ]+/gi, '_').slice(0, 60),
          })))
          .onConflictDoNothing()
      }

      const levelRows = await tx.select().from(positionLevels)
      const levelByName = new Map(levelRows.map(r => [r.name.toLowerCase(), r.id]))

      if (wanted.positions.length) {
        await tx.insert(positions)
          .values(wanted.positions.map(name => ({ tenantId: ctx.tenantId, name })))
          .onConflictDoNothing()
      }

      const orgUnitRows = await tx.select().from(orgUnits)
      const orgUnitByName = new Map(orgUnitRows.map(r => [r.name.toLowerCase(), r.id]))

      if (wanted.locations.length) {
        const fallbackOrgUnit = orgUnitRows[0]!.id
        await tx.insert(locations)
          .values(batch.filter(r => r.location).reduce<{ tenantId: string, name: string, orgUnitId: string }[]>((acc, r) => {
            if (!acc.some(x => x.name === r.location)) {
              acc.push({
                tenantId: ctx.tenantId,
                name: r.location,
                orgUnitId: orgUnitByName.get(r.orgUnit.toLowerCase()) ?? fallbackOrgUnit,
              })
            }
            return acc
          }, []))
          .onConflictDoNothing()
      }

      const [cityRows, positionRows2, locationRows, roleRows] = await Promise.all([
        tx.select().from(cities),
        tx.select().from(positions),
        tx.select().from(locations),
        tx.select().from(roles),
      ])
      const cityByName = new Map(cityRows.map(r => [r.name.toLowerCase(), r.id]))
      const positionByName = new Map(positionRows2.map(r => [r.name.toLowerCase(), r.id]))
      const locationByName = new Map(locationRows.map(r => [r.name.toLowerCase(), r.id]))
      const roleByKey = new Map(roleRows.flatMap(r => [[r.code.toLowerCase(), r], [r.name.toLowerCase(), r]] as [string, typeof r][]))

      // Проставить уровни позициям, где заданы
      for (const r of batch) {
        if (r.positionLevel && r.position) {
          const levelId = levelByName.get(r.positionLevel.toLowerCase())
          const posId = positionByName.get(r.position.toLowerCase())
          if (levelId && posId) {
            await tx.update(positions).set({ levelId }).where(and(eq(positions.id, posId), isNull(positions.levelId)))
          }
        }
      }

      const phones = batch.map(r => r.phone).filter(Boolean)
      const externals = batch.map(r => r.externalId).filter(Boolean)
      const lookupConds = [
        ...(phones.length ? [inArray(users.phone, phones)] : []),
        ...(externals.length ? [inArray(users.externalId, externals)] : []),
      ]
      const existing = lookupConds.length
        ? await tx.select({ id: users.id, phone: users.phone, externalId: users.externalId })
            .from(users)
            .where(or(...lookupConds))
        : []
      const byPhone = new Map(existing.filter(r => r.phone).map(r => [r.phone, r.id]))
      const byExternal = new Map(existing.filter(r => r.externalId).map(r => [r.externalId, r.id]))

      for (const row of batch) {
        const userId = (row.externalId && byExternal.get(row.externalId)) || (row.phone && byPhone.get(row.phone)) || null
        const name = splitName({ fullName: row.fullName, lastName: row.lastName || undefined, firstName: row.firstName || undefined, middleName: row.middleName || undefined })
        const base = {
          fullName: name.fullName,
          lastName: name.lastName,
          firstName: name.firstName,
          middleName: name.middleName,
          email: row.email || null,
          cityId: row.city ? cityByName.get(row.city.toLowerCase()) ?? null : null,
          tags: row.tags,
          hiredAt: row.hiredAt || null,
          birthDate: row.birthDate || null,
          externalId: row.externalId || null,
        }

        let id: string
        if (userId) {
          await tx.update(users).set({ ...base, updatedAt: new Date() }).where(eq(users.id, userId))
          id = userId
          updated++
        }
        else {
          // Без телефона — invited без возможности входа (docs/16 §12)
          const [inserted] = await tx.insert(users).values({
            tenantId: ctx.tenantId,
            phone: row.phone || null,
            status: 'invited',
            ...base,
          }).returning({ id: users.id })
          id = inserted!.id
          created++
          createdIds.push(id)
        }
        touched.push(id)

        const locationId = locationByName.get(row.location.toLowerCase())
        const positionId = positionByName.get(row.position.toLowerCase())
        if (locationId && positionId) {
          const current = await tx.select({ id: userPlacements.id })
            .from(userPlacements)
            .where(and(
              eq(userPlacements.userId, id),
              eq(userPlacements.locationId, locationId),
              eq(userPlacements.positionId, positionId),
              isNull(userPlacements.endedAt),
            ))
          if (current.length === 0) {
            await tx.update(userPlacements)
              .set({ endedAt: sql`current_date` })
              .where(and(eq(userPlacements.userId, id), eq(userPlacements.isPrimary, true), isNull(userPlacements.endedAt)))
            await tx.insert(userPlacements).values({
              tenantId: ctx.tenantId,
              userId: id,
              locationId,
              positionId,
              isPrimary: true,
            })
            // docs/01 §1.9.3: правило «должность → роль» применяется при импорте
            await applyPositionRoles(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId }, id)
          }
        }

        const role = row.role ? roleByKey.get(row.role.toLowerCase()) : roleByKey.get('employee')
        if (role) {
          await tx.insert(userRoles).values({
            tenantId: ctx.tenantId,
            userId: id,
            roleId: role.id,
            scopeType: 'location',
            scopeId: locationId ?? null,
          }).onConflictDoNothing()
        }
      }
      // Прогресс для UI (docs/16 §5.4 шаг 5)
      await tx.update(importJobs).set({ stats: { ...baseStats, processed: Math.min(offset + 200, applicable.length), created, updated }, updatedAt: new Date() }).where(eq(importJobs.id, jobId))
    })
  }
  }

  // Приглашения созданным (options.sendInvites) — только тем, у кого есть телефон
  if (options.sendInvites) {
    const { createInvitation } = await import('./people')
    for (const id of createdIds) await createInvitation(ctx, id).catch(() => null)
  }

  // Людей не из файла — в архив (options.archiveMissing); администраторов не трогаем
  let archived = 0
  if (options.archiveMissing) {
    archived = await withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
      const rows = await tx.execute(sql`
        update users u set status = 'archived', archived_at = now(), updated_at = now()
        where u.status in ('active','invited') and not u.is_hidden
          and u.id <> ${ctx.actorId}::uuid
          ${touched.length ? sql`and u.id not in ${touched}` : sql``}
          and not exists (select 1 from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = u.id and r.code = 'admin')
        returning u.id
      `) as unknown as { id: string }[]
      if (rows.length) {
        const ids = rows.map(r => r.id)
        await tx.update(userPlacements).set({ endedAt: sql`current_date` }).where(and(inArray(userPlacements.userId, ids), isNull(userPlacements.endedAt)))
        await tx.execute(sql`update sessions set revoked_at = now() where user_id in ${ids} and revoked_at is null`)
        await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'import.archive_missing', entity: 'import_job', entityId: jobId, after: { archived: ids.length } })
      }
      return rows.length
    })
  }

  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const finalStats = { ...(job.stats as Record<string, unknown>), processed: applicable.length, created, updated, archived }
    const [saved] = await tx.update(importJobs)
      .set({ status: 'applied', stats: finalStats, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(importJobs.id, jobId))
      .returning({ id: importJobs.id, stats: importJobs.stats })

    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      action: 'import.apply',
      entity: 'import_job',
      entityId: jobId,
      after: finalStats,
    })
    if (job.createdBy) {
      await enqueueNotification(tx, { tenantId: ctx.tenantId, userId: job.createdBy, code: 'import_finished', payload: { file: job.fileName, created, updated, errors: (job.stats as { errors?: number }).errors ?? 0, url: `/admin/import?job=${jobId}` }, dedupKey: `import_finished:${jobId}` })
    }
    return saved!
  }).then(async (saved) => {
    const { syncAssignments } = await import('./assignments')
    syncAssignments(ctx.tenantId).catch(err => console.error('syncAssignments after import', err))
    return saved
  })
}

/** Отчёт xlsx с построчным итогом (docs/06-infra.md §6.5.5). */
export async function buildImportReport(ctx: Ctx, jobId: string): Promise<Buffer | null> {
  const job = await getImportJob(ctx, jobId)
  if (!job) return null

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Звіт')
  ws.addRow(['Рядок', 'ПІБ', 'Телефон', 'Дія', 'Помилки', 'Попередження'])
  for (const row of job.rows as ImportRow[]) {
    ws.addRow([
      row.line,
      row.fullName,
      row.phone,
      row.action === 'skip' ? 'пропущено' : row.action === 'create' ? 'створено' : 'оновлено',
      row.errors.join('; '),
      (row.warnings ?? []).join('; '),
    ])
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** Шаблон файла импорта. */
export async function buildImportTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Імпорт')
  ws.addRow([...IMPORT_COLUMNS])
  ws.addRow(['Іваненко Іван', '+380671234567', 'ivan@example.com', 'Бариста', 'базовий', 'Одеса', 'Каппі', 'Лазарева', 'employee', 'новачок', '2026-09-01', 'EXT-001'])
  return Buffer.from(await wb.xlsx.writeBuffer())
}
