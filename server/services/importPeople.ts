import ExcelJS from 'exceljs'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import {
  cities, importJobs, locations, orgUnits, positionLevels, positions, roles,
  userPlacements, userRoles, users,
} from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { recordAudit } from './audit'
import { phoneSchema } from '../../shared/schemas/auth'

/**
 * Импорт людей (docs/06-infra.md §6.5): разбор файла → построчная валидация →
 * предпросмотр → применение батчами по 200 → отчёт.
 */

export const IMPORT_COLUMNS = [
  'ПІБ', 'Телефон', 'Email', 'Посада', 'Рівень посади', 'Місто',
  'Підрозділ', 'Точка', 'Роль', 'Мітки', 'Дата найму', 'Зовнішній ID',
] as const

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
  action: 'create' | 'update' | 'skip'
  errors: string[]
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

/** Построчная валидация + определение create/update. Пишет import_job со строками. */
export async function validateImport(ctx: Ctx, fileName: string, raw: Record<string, string>[]) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [existingPhones, existingExternal, positionRows, roleRows] = await Promise.all([
      tx.select({ phone: users.phone, id: users.id }).from(users).where(sql`${users.phone} is not null`),
      tx.select({ externalId: users.externalId, id: users.id }).from(users).where(sql`${users.externalId} is not null`),
      tx.select({ name: positions.name }).from(positions),
      tx.select({ code: roles.code, name: roles.name }).from(roles),
    ])
    const phoneMap = new Map(existingPhones.map(r => [r.phone!, r.id]))
    const externalMap = new Map(existingExternal.map(r => [r.externalId!, r.id]))
    const knownPositions = new Set(positionRows.map(r => r.name.toLowerCase()))
    const knownRoles = new Map(roleRows.flatMap(r => [[r.code.toLowerCase(), r.code], [r.name.toLowerCase(), r.code]] as [string, string][]))

    const seenPhones = new Map<string, number>()
    const seenExternal = new Map<string, number>()

    const rows: ImportRow[] = raw.map((rec, idx) => {
      const line = idx + 2 // строка в файле, после заголовка
      const errors: string[] = []

      const fullName = rec['ПІБ'] ?? ''
      if (fullName.length < 2) errors.push('ПІБ обовʼязкове')

      let phone = rec['Телефон'] ?? ''
      if (!phone) {
        errors.push('Телефон обовʼязковий')
      }
      else {
        const parsed = phoneSchema.safeParse(phone)
        if (!parsed.success) errors.push('Невірний формат телефону')
        else phone = parsed.data
      }

      const position = rec['Посада'] ?? ''
      if (!position) errors.push('Посада обовʼязкова')

      const orgUnit = rec['Підрозділ'] ?? ''
      if (!orgUnit) errors.push('Підрозділ обовʼязковий')

      const location = rec['Точка'] ?? ''
      if (!location) errors.push('Точка обовʼязкова')

      const role = rec['Роль'] ?? ''
      if (role && !knownRoles.has(role.toLowerCase())) {
        errors.push(`Невідома роль «${role}»`)
      }

      const hiredAt = rec['Дата найму'] ?? ''
      if (hiredAt && !/^\d{4}-\d{2}-\d{2}$/.test(hiredAt)) {
        errors.push('Дата найму — у форматі РРРР-ММ-ДД')
      }

      const email = rec['Email'] ?? ''
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Невірний email')

      const externalId = rec['Зовнішній ID'] ?? ''

      // Дубликаты внутри файла
      if (phone && seenPhones.has(phone)) errors.push(`Дубль телефону (рядок ${seenPhones.get(phone)})`)
      else if (phone) seenPhones.set(phone, line)
      if (externalId && seenExternal.has(externalId)) errors.push(`Дубль зовнішнього ID (рядок ${seenExternal.get(externalId)})`)
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
        action: errors.length > 0 ? 'skip' : existingId ? 'update' : 'create',
        errors,
      } satisfies ImportRow
    })

    const stats = {
      total: rows.length,
      create: rows.filter(r => r.action === 'create').length,
      update: rows.filter(r => r.action === 'update').length,
      skip: rows.filter(r => r.action === 'skip').length,
      errors: rows.filter(r => r.errors.length > 0).length,
      newPositions: [...new Set(rows.filter(r => r.errors.length === 0 && r.position && !knownPositions.has(r.position.toLowerCase())).map(r => r.position))],
    }

    const [job] = await tx.insert(importJobs).values({
      tenantId: ctx.tenantId,
      kind: 'users',
      fileName,
      status: 'ready',
      rows,
      stats,
      createdBy: ctx.actorId,
    }).returning({ id: importJobs.id, stats: importJobs.stats, status: importJobs.status })

    return { jobId: job!.id, stats, rows }
  })
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

  const rows = job.rows as ImportRow[]
  const applicable = rows.filter(r => r.action !== 'skip')
  let created = 0
  let updated = 0

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
      const byPhone = new Map(existing.map(r => [r.phone, r.id]))
      const byExternal = new Map(existing.filter(r => r.externalId).map(r => [r.externalId, r.id]))

      for (const row of batch) {
        const userId = (row.externalId && byExternal.get(row.externalId)) || byPhone.get(row.phone) || null
        const base = {
          fullName: row.fullName,
          email: row.email || null,
          cityId: row.city ? cityByName.get(row.city.toLowerCase()) ?? null : null,
          tags: row.tags,
          hiredAt: row.hiredAt || null,
          externalId: row.externalId || null,
        }

        let id: string
        if (userId) {
          await tx.update(users).set({ ...base, updatedAt: new Date() }).where(eq(users.id, userId))
          id = userId
          updated++
        }
        else {
          const [inserted] = await tx.insert(users).values({
            tenantId: ctx.tenantId,
            phone: row.phone,
            ...base,
          }).returning({ id: users.id })
          id = inserted!.id
          created++
        }

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
    })
  }

  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const finalStats = { ...(job.stats as Record<string, unknown>), created, updated }
    const [saved] = await tx.update(importJobs)
      .set({ status: 'applied', stats: finalStats, updatedAt: new Date() })
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
    return saved!
  })
}

/** Отчёт xlsx с построчным итогом (docs/06-infra.md §6.5.5). */
export async function buildImportReport(ctx: Ctx, jobId: string): Promise<Buffer | null> {
  const job = await getImportJob(ctx, jobId)
  if (!job) return null

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Звіт')
  ws.addRow(['Рядок', 'ПІБ', 'Телефон', 'Дія', 'Помилки'])
  for (const row of job.rows as ImportRow[]) {
    ws.addRow([
      row.line,
      row.fullName,
      row.phone,
      row.action === 'skip' ? 'пропущено' : row.action === 'create' ? 'створено' : 'оновлено',
      row.errors.join('; '),
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
