import type { OrgAssignmentRole, OrgNodeType } from '../enums'
import { ORG_MAX_DEPTH, ORG_MAX_ROOTS, layoutTree } from './orgLayout'

/**
 * Импорт оргструктуры из CSV — правила в чистом виде (docs/v2/32-org-structure.md §6.2, §7 п. 7,
 * §9, §12 п. 3; PR-31 плана `docs/v2/45-plan.md`).
 *
 * Модуль не знает о базе. Сервис (`server/services/orgImport.ts`) загружает текущее дерево,
 * справочники и людей, отдаёт их сюда вместе со строками файла и получает **план**: какие узлы
 * создать, какие обновить, у кого какой будет путь, кого привязать, что заархивировать и какие
 * строки отклонить с какой причиной. Тот же план считается дважды — на предпросмотре и в момент
 * применения (дерево между ними могло измениться), — поэтому экран и запись никогда не
 * расходятся в том, что считают ошибкой.
 *
 * **Главное условие выхода PR-31: кривой файл не ломает инвариант дерева.** Петли, висячие
 * узлы, тринадцатый уровень и одиннадцатый корень отклоняются здесь построчно и уходят в
 * `org_conflicts`, а не в дерево; итоговая раскладка строится `layoutTree()` — той же, что
 * у отката, — и в неё не попадает ни один узел, путь которого не выводится из родителя.
 */

/**
 * Колонки файла — формат экспорта «Оргструктура» (`32` §9), он же формат импорта.
 * `assignment_is_primary` — четырнадцатая колонка сверх списка документа: без неё
 * совместительство не переживает «экспорт → импорт» (`32` §9, решение PR-31).
 */
export const ORG_IMPORT_COLUMNS = [
  'external_key', 'parent_external_key', 'type', 'title', 'position_name', 'org_unit_name',
  'location_name', 'headcount_planned', 'is_manager_point', 'employee_external_id',
  'assignment_role', 'assignment_started_at', 'sort', 'assignment_is_primary',
] as const
export type OrgImportColumn = typeof ORG_IMPORT_COLUMNS[number]

/** Колонки узла: у нескольких строк одного ключа (несколько держателей) они обязаны совпадать. */
const NODE_COLUMNS = [
  'parent_external_key', 'type', 'title', 'position_name', 'org_unit_name', 'location_name',
  'headcount_planned', 'is_manager_point', 'sort',
] as const satisfies readonly OrgImportColumn[]

/** Без ключа узла строку не к чему привязать; остальное имеет значения по умолчанию. */
export const ORG_IMPORT_REQUIRED_COLUMNS: readonly OrgImportColumn[] = ['external_key']

export const ORG_IMPORT_LIMITS = {
  /** Столько же, сколько у импорта людей (`docs/16` §5.4). */
  maxRows: 5000,
  maxBytes: 5 * 1024 * 1024,
  /** «Зробити знімок перед імпортом» — при большем числе строк снять нельзя (`32` §6.2). */
  forcedSnapshotRows: 50,
  /** `external_key ≤ 64` (`32` §3.2). */
  keyMax: 64,
} as const

// ── Разбор CSV ───────────────────────────────────────────────────────────────────────────

/**
 * CSV по RFC 4180: кавычки, удвоенная кавычка внутри, перевод строки внутри кавычек, BOM,
 * CRLF. Разделитель берётся из строки заголовка: `;` (формат экспорта, `32` §9), если он там
 * есть вне кавычек, иначе `,`. Одна колонка — один разделитель: разбор по «любому из двух»
 * резал бы название «Кухарі, зміна 1» на две ячейки.
 */
export function parseCsv(input: string): { headers: string[], rows: string[][] } {
  const text = input.replace(/^\uFEFF/, '')
  const delimiter = detectDelimiter(text)
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let quoted = false
  let i = 0
  const pushField = () => { record.push(field); field = '' }
  const pushRecord = () => {
    pushField()
    if (record.some(v => v.trim() !== '')) records.push(record)
    record = []
  }
  while (i < text.length) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue }
    if (ch === delimiter) { pushField(); i++; continue }
    if (ch === '\r' || ch === '\n') {
      pushRecord()
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    i++
  }
  if (field !== '' || record.length) pushRecord()
  const [headers = [], ...rows] = records
  return { headers: headers.map(h => h.trim()), rows }
}

function detectDelimiter(text: string): ';' | ',' {
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted && ch === ';') return ';'
  }
  return text.split(/\r?\n/, 1)[0]?.includes(',') ? ',' : ';'
}

/**
 * Защита от формул при открытии выгрузки в табличном редакторе: значение, начинающееся с
 * `=`, `+`, `-`, `@`, пишется с ведущим апострофом. Импорт этот апостроф снимает — иначе
 * «экспорт → импорт» переименовал бы узел «-Склад» в «'-Склад», а телефон `+380…` не нашёлся бы.
 */
const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)
  if (typeof v === 'string' && FORMULA_START.test(s)) s = `'${s}`
  if (/[";\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

/** UTF-8 с BOM, разделитель `;`, строки через CRLF — формат `32` §9. */
export function toCsv(rows: readonly (readonly (string | number | boolean | null | undefined)[])[]): string {
  return `\uFEFF${rows.map(r => r.map(csvCell).join(';')).join('\r\n')}\r\n`
}

function unguard(s: string): string {
  return s.length > 1 && s[0] === '\'' && FORMULA_START.test(s.slice(1)) ? s.slice(1) : s
}

/** Значение ячейки так, как его читает план: без пробелов по краям и без апострофа-защиты от формул. */
export function normalizeCell(v: string): string {
  return unguard(v.trim())
}

// ── Сопоставление колонок ────────────────────────────────────────────────────────────────

/** Синонимы заголовков для автосопоставления (шаг «сопоставление колонок», `docs/16` §5.4). */
const ALIASES: Record<OrgImportColumn, string[]> = {
  external_key: ['external key', 'key', 'node key', 'ключ', 'ключ вузла', 'код вузла', 'зовнішній ключ', 'ключ узла'],
  parent_external_key: ['parent external key', 'parent key', 'parent', 'батьківський ключ', 'ключ батька', 'батьківський вузол', 'родительский ключ'],
  type: ['type', 'node type', 'kind', 'вид', 'вид вузла', 'тип', 'тип вузла', 'вид узла'],
  title: ['title', 'name', 'node title', 'назва', 'назва вузла', 'название', 'название узла'],
  position_name: ['position name', 'position', 'посада', 'назва посади', 'должность'],
  org_unit_name: ['org unit name', 'org unit', 'unit', 'department', 'підрозділ', 'відділ', 'подразделение'],
  location_name: ['location name', 'location', 'branch', 'філія', 'точка', 'заклад', 'филиал'],
  headcount_planned: ['headcount planned', 'headcount', 'plan', 'планова кількість', 'план', 'штат', 'плановое количество'],
  is_manager_point: ['is manager point', 'manager point', 'керівна точка', 'керівний вузол', 'руководящая точка'],
  employee_external_id: ['employee external id', 'employee', 'employee id', 'співробітник', 'зовнішній id', 'зовнішній №', 'табельний', 'сотрудник'],
  assignment_role: ['assignment role', 'role', 'роль', 'роль у вузлі', 'роль в узле'],
  assignment_started_at: ['assignment started at', 'started at', 'start date', 'дата початку', 'з дати', 'дата начала'],
  sort: ['sort', 'order', 'порядок', 'сортування'],
  assignment_is_primary: ['assignment is primary', 'is primary', 'primary', 'основне підпорядкування', 'основне', 'основное подчинение'],
}

const norm = (s: string) => s.toLowerCase().replace(/[ʼ'’`]/g, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim()

/** Угадать сопоставление «заголовок файла → колонка формата». Выгрузка сопоставляется целиком. */
export function guessOrgMapping(headers: readonly string[]): Record<string, OrgImportColumn> {
  const out: Record<string, OrgImportColumn> = {}
  const used = new Set<OrgImportColumn>()
  for (const h of headers) {
    const n = norm(h)
    if (!n) continue
    const exact = ORG_IMPORT_COLUMNS.find(c => norm(c) === n)
    const hit = exact ?? (Object.entries(ALIASES) as [OrgImportColumn, string[]][]).find(([, al]) => al.some(a => norm(a) === n))?.[0]
    if (hit && !used.has(hit)) {
      out[h] = hit
      used.add(hit)
    }
  }
  return out
}

/** Колонки формата, которые сопоставлением не покрыты, но обязательны. */
export function unmappedRequired(mapping: Readonly<Record<string, string>>): OrgImportColumn[] {
  const mapped = new Set(Object.values(mapping))
  return ORG_IMPORT_REQUIRED_COLUMNS.filter(c => !mapped.has(c))
}

/** Строка файла → значения колонок формата по сопоставлению. Несопоставленные заголовки не читаются. */
export function applyOrgMapping(raw: Readonly<Record<string, string>>, mapping: Readonly<Record<string, string>>): Partial<Record<OrgImportColumn, string>> {
  const out: Partial<Record<OrgImportColumn, string>> = {}
  for (const [header, col] of Object.entries(mapping)) {
    if ((ORG_IMPORT_COLUMNS as readonly string[]).includes(col) && raw[header] !== undefined) out[col as OrgImportColumn] = raw[header]
  }
  return out
}

// ── Проблемы строк ───────────────────────────────────────────────────────────────────────

/** Ошибки: строка не применяется. Тексты — на экране через i18n (`orgImport.err.*`). */
export const ORG_IMPORT_ERRORS = [
  'key_required', 'key_too_long', 'key_duplicate', 'type_invalid', 'title_invalid',
  'headcount_invalid', 'headcount_named', 'named_has_holders', 'flag_invalid', 'sort_invalid',
  'role_invalid', 'date_invalid', 'position_not_found', 'position_inactive', 'unit_not_found',
  'location_not_found', 'location_inactive', 'row_conflict', 'node_rejected', 'parent_not_found',
  'parent_archived', 'parent_rejected', 'self_parent', 'cycle', 'depth_exceeded', 'too_many_roots',
] as const
export type OrgImportError = typeof ORG_IMPORT_ERRORS[number]

/** Предупреждения: строка применяется, но не целиком (обычно — без привязки человека). */
export const ORG_IMPORT_WARNINGS = [
  'position_created', 'employee_not_found', 'employee_archived', 'named_second_holder',
  'assignment_duplicate', 'primary_twice', 'secondary_assignment',
] as const
export type OrgImportWarning = typeof ORG_IMPORT_WARNINGS[number]

export interface OrgImportIssue<C extends string = OrgImportError | OrgImportWarning> {
  code: C
  params?: Record<string, string | number>
}

/**
 * Какая ошибка строки — конфликт оргструктуры (`org_conflicts`, `source='import'`) и какой
 * вид из общего перечня В-7. Петля — `manager_cycle` («Кільце керівників»), узел, подчинённый
 * сам себе, — `manager_self`, висячий узел (родителя нет, он в архиве или сам отклонён) —
 * `unit_missing` («шматок структури з імпорту відсутній»), тринадцатый уровень —
 * `depth_exceeded`. Ошибки полей (пустой ключ, битая дата) конфликтом структуры не являются:
 * это опечатка в файле, она видна в предпросмотре и в отчёте импорта.
 */
export const ORG_IMPORT_CONFLICT_OF: Partial<Record<OrgImportError, { kind: 'manager_self' | 'manager_cycle' | 'unit_missing' | 'depth_exceeded', severity: 'warning' | 'critical' }>> = {
  self_parent: { kind: 'manager_self', severity: 'critical' },
  cycle: { kind: 'manager_cycle', severity: 'critical' },
  parent_not_found: { kind: 'unit_missing', severity: 'warning' },
  parent_archived: { kind: 'unit_missing', severity: 'warning' },
  parent_rejected: { kind: 'unit_missing', severity: 'warning' },
  depth_exceeded: { kind: 'depth_exceeded', severity: 'critical' },
}

// ── Вход и выход плана ───────────────────────────────────────────────────────────────────

export interface OrgImportOptions {
  /** «Створювати відсутні посади» (`32` §6.2). */
  createPositions: boolean
  /** «Архівувати вузли, яких немає у файлі» (`32` §6.2). */
  archiveMissing: boolean
  /** «Зробити знімок перед імпортом»; при числе строк больше порога — всегда. */
  snapshot: boolean
}

export const DEFAULT_ORG_IMPORT_OPTIONS: OrgImportOptions = { createPositions: false, archiveMissing: false, snapshot: true }

/** Снимок включён обязательно, если строк больше порога (`32` §6.2: «при >50 строках снять нельзя»). */
export function snapshotForced(rowCount: number): boolean {
  return rowCount > ORG_IMPORT_LIMITS.forcedSnapshotRows
}

export interface OrgImportExistingNode {
  id: string
  externalKey: string | null
  parentId: string | null
  path: string
  archived: boolean
  type: OrgNodeType
  title: string
  positionId: string | null
  orgUnitId: string | null
  locationId: string | null
  headcountPlanned: number
  isManagerPoint: boolean
  sort: number
  /** Активных держателей сейчас — именной узел не может остаться с двумя. */
  activeHolders: number
}

export interface OrgImportRefs {
  /** Нижний регистр названия → id действующей записи справочника. */
  positions: ReadonlyMap<string, string>
  /** Нижний регистр названия деактивированных посад — ссылаться на них нельзя (`32` §3.2). */
  inactivePositions: ReadonlySet<string>
  orgUnits: ReadonlyMap<string, string>
  locations: ReadonlyMap<string, string>
  inactiveLocations: ReadonlySet<string>
}

export interface OrgImportPerson { id: string, archived: boolean }

export interface OrgImportInput {
  rows: readonly { line: number, values: Partial<Record<OrgImportColumn, string>> }[]
  existing: readonly OrgImportExistingNode[]
  refs: OrgImportRefs
  /** Человек по значению `employee_external_id`: зовнішній №, иначе телефон (`docs/06` §6.5.6). */
  person: (ref: string) => OrgImportPerson | null
  options: Pick<OrgImportOptions, 'createPositions' | 'archiveMissing'>
  /** Идентификатор нового узла по ключу. Сервис даёт `crypto.randomUUID()`, тесты — предсказуемый. */
  newId: (key: string) => string
}

export type OrgImportAction = 'create' | 'update' | 'same' | 'error'

export interface OrgImportRowResult {
  line: number
  key: string
  parentKey: string
  title: string
  employee: string
  action: OrgImportAction
  errors: OrgImportIssue<OrgImportError>[]
  warnings: OrgImportIssue<OrgImportWarning>[]
}

export interface OrgImportPlannedNode {
  id: string
  key: string
  line: number
  isNew: boolean
  /** Узел был в архиве и файл его возвращает. */
  restore: boolean
  externalKey: string | null
  parentId: string | null
  path: string
  depth: number
  type: OrgNodeType
  title: string
  positionId: string | null
  /** Посады нет в справочнике — сервис заведёт её до записи узла («Створювати відсутні посади»). */
  newPositionName: string | null
  orgUnitId: string | null
  locationId: string | null
  headcountPlanned: number
  isManagerPoint: boolean
  sort: number
  action: 'create' | 'update' | 'same'
  /** Изменённые поля существующего узла — в `audit_log` (`32` §7 п. 3). */
  changed: string[]
}

export interface OrgImportPlannedAssignment {
  nodeId: string
  key: string
  line: number
  userId: string
  role: OrgAssignmentRole
  isPrimary: boolean
  startedAt: string | null
}

export interface OrgImportPlannedConflict {
  kind: 'manager_self' | 'manager_cycle' | 'unit_missing' | 'depth_exceeded'
  severity: 'warning' | 'critical'
  line: number
  key: string
  details: Record<string, unknown>
}

export interface OrgImportStats {
  total: number
  create: number
  update: number
  same: number
  errors: number
  warnings: number
  assignments: number
  archive: number
  /** Узлы вне файла, которые архивировать нельзя: под ними остаются живые узлы из файла. */
  archiveBlocked: number
}

export interface OrgImportPlan {
  rows: OrgImportRowResult[]
  /** Узлы из файла, родители раньше детей. */
  nodes: OrgImportPlannedNode[]
  /** Узлы вне файла, у которых меняется путь: под ними переехал предок. */
  relaid: { id: string, path: string, depth: number }[]
  /** Узлы вне файла к архивации («Архівувати вузли, яких немає у файлі»), дети раньше родителей. */
  archive: string[]
  assignments: OrgImportPlannedAssignment[]
  positionsToCreate: string[]
  conflicts: OrgImportPlannedConflict[]
  stats: OrgImportStats
}

// ── Разбор значений ──────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const TYPE_ALIASES: Record<OrgNodeType, string[]> = {
  position: ['position', 'посада', 'позиція', 'должность'],
  employee: ['employee', 'співробітник', 'іменний', 'сотрудник', 'person'],
}
const ROLE_ALIASES: Record<OrgAssignmentRole, string[]> = {
  holder: ['holder', 'тримач', 'тримач посади', 'держатель'],
  acting: ['acting', 'в.о.', 'во', 'виконувач обовʼязків', 'виконувач обов\'язків', 'врио', 'и.о.', 'ио'],
  deputy: ['deputy', 'заступник', 'заместитель'],
}
const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', 'так', 'т', 'да', 'д', '+', 'x', 'х', '✓'])
const FALSE_WORDS = new Set(['false', '0', 'no', 'n', 'ні', 'н', 'нет', '-'])

/** Логическое значение ячейки: пусто — `null` (не задано), непонятное — `undefined` (ошибка). */
export function parseFlag(v: string): boolean | null | undefined {
  const s = v.trim().toLowerCase()
  if (s === '') return null
  if (TRUE_WORDS.has(s)) return true
  if (FALSE_WORDS.has(s)) return false
  return undefined
}

function parseEnum<T extends string>(v: string, aliases: Record<T, string[]>): T | null {
  const s = v.trim().toLowerCase()
  for (const [value, words] of Object.entries(aliases) as [T, string[]][]) if (words.includes(s)) return value
  return null
}

function validDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

function parseIntCell(v: string): number | null {
  return /^-?\d{1,9}$/.test(v) ? Number(v) : null
}

interface NodeCols {
  parentKey: string
  type: OrgNodeType
  title: string
  positionName: string
  orgUnitName: string
  locationName: string
  headcountPlanned: number
  isManagerPoint: boolean
  sort: number
}

interface AssignCols {
  employee: string
  role: OrgAssignmentRole
  startedAt: string | null
  isPrimary: boolean | null
}

interface ParsedRow {
  line: number
  key: string
  values: Partial<Record<OrgImportColumn, string>>
  node: NodeCols
  /** Колонки узла, заданные в строке непусто — по ним сверяются строки одного ключа. */
  present: Set<OrgImportColumn>
  /**
   * Ошибки полей до того, как известно, описывает строка узел или только его держателя:
   * у строки-держателя пустые колонки узла ошибкой не считаются, проверяются только заданные.
   */
  pending: {
    keyErrors: OrgImportIssue<OrgImportError>[]
    nodeErrors: { col: OrgImportColumn, issue: OrgImportIssue<OrgImportError> }[]
    assignErrors: OrgImportIssue<OrgImportError>[]
  }
  assign: AssignCols
  result: OrgImportRowResult
}

function cellOf(values: Partial<Record<OrgImportColumn, string>>, col: OrgImportColumn): string {
  return normalizeCell(values[col] ?? '')
}

function parseRow(line: number, values: Partial<Record<OrgImportColumn, string>>): ParsedRow {
  const keyErrors: OrgImportIssue<OrgImportError>[] = []
  const nodeErrors: { col: OrgImportColumn, issue: OrgImportIssue<OrgImportError> }[] = []
  const assignErrors: OrgImportIssue<OrgImportError>[] = []
  const cell = (c: OrgImportColumn) => cellOf(values, c)
  const key = cell('external_key')
  if (!key) keyErrors.push({ code: 'key_required' })
  else if (key.length > ORG_IMPORT_LIMITS.keyMax) keyErrors.push({ code: 'key_too_long', params: { max: ORG_IMPORT_LIMITS.keyMax } })

  const typeRaw = cell('type')
  const type = typeRaw ? parseEnum(typeRaw, TYPE_ALIASES) : 'position'
  if (!type) nodeErrors.push({ col: 'type', issue: { code: 'type_invalid', params: { value: typeRaw } } })

  const positionName = cell('position_name')
  const title = cell('title') || positionName
  if (title.length < 2 || title.length > 120 || /[<>]/.test(title)) nodeErrors.push({ col: 'title', issue: { code: 'title_invalid' } })

  const headcountRaw = cell('headcount_planned')
  let headcountPlanned = 1
  if (headcountRaw) {
    const n = parseIntCell(headcountRaw)
    if (n === null || n < 1 || n > 999) nodeErrors.push({ col: 'headcount_planned', issue: { code: 'headcount_invalid' } })
    else headcountPlanned = n
  }
  if (type === 'employee' && headcountPlanned !== 1) nodeErrors.push({ col: 'headcount_planned', issue: { code: 'headcount_named' } })

  const managerFlag = parseFlag(cell('is_manager_point'))
  if (managerFlag === undefined) nodeErrors.push({ col: 'is_manager_point', issue: { code: 'flag_invalid', params: { column: 'is_manager_point' } } })

  const sortRaw = cell('sort')
  const sort = sortRaw ? parseIntCell(sortRaw) : 0
  if (sort === null) nodeErrors.push({ col: 'sort', issue: { code: 'sort_invalid' } })

  const employee = cell('employee_external_id')
  const roleRaw = cell('assignment_role')
  const role = roleRaw ? parseEnum(roleRaw, ROLE_ALIASES) : 'holder'
  const startedRaw = cell('assignment_started_at')
  const primaryFlag = parseFlag(cell('assignment_is_primary'))
  if (employee) {
    if (!role) assignErrors.push({ code: 'role_invalid', params: { value: roleRaw } })
    if (startedRaw && !validDate(startedRaw)) assignErrors.push({ code: 'date_invalid' })
    if (primaryFlag === undefined) assignErrors.push({ code: 'flag_invalid', params: { column: 'assignment_is_primary' } })
  }

  const present = new Set<OrgImportColumn>(NODE_COLUMNS.filter(c => cell(c) !== ''))
  return {
    line,
    key,
    values,
    node: {
      parentKey: cell('parent_external_key'),
      type: type ?? 'position',
      title,
      positionName,
      orgUnitName: cell('org_unit_name'),
      locationName: cell('location_name'),
      headcountPlanned,
      isManagerPoint: managerFlag === true,
      sort: sort ?? 0,
    },
    present,
    pending: { keyErrors, nodeErrors, assignErrors },
    assign: {
      employee,
      role: role ?? 'holder',
      startedAt: startedRaw && validDate(startedRaw) ? startedRaw : null,
      isPrimary: primaryFlag ?? null,
    },
    result: { line, key, parentKey: cell('parent_external_key'), title, employee, action: 'error', errors: [], warnings: [] },
  }
}

/** Значение колонки узла в том виде, в каком его сравнивают строки одного ключа. */
function nodeValue(p: ParsedRow, col: typeof NODE_COLUMNS[number]): string {
  switch (col) {
    case 'parent_external_key': return p.node.parentKey
    case 'type': return p.node.type
    case 'title': return p.node.title
    case 'position_name': return p.node.positionName.toLowerCase()
    case 'org_unit_name': return p.node.orgUnitName.toLowerCase()
    case 'location_name': return p.node.locationName.toLowerCase()
    case 'headcount_planned': return String(p.node.headcountPlanned)
    case 'is_manager_point': return String(p.node.isManagerPoint)
    case 'sort': return String(p.node.sort)
  }
}

// ── План ─────────────────────────────────────────────────────────────────────────────────

/**
 * План импорта. Порядок проверок:
 *
 *  1. поля строки (ключ, вид, подпись, план, флаги, дата);
 *  2. строки одного ключа — это держатели одного узла: колонки узла у них совпадают;
 *  3. справочники: посада (или создать), підрозділ, філія;
 *  4. **структура** — по итоговому дереву «текущее + файл», а не по файлу отдельно: файл может
 *     переподчинить существующий узел его же потомку, которого в файле нет. Отклонение строки
 *     возвращает узел туда, где он стоит сейчас (или убирает новый), и проверка повторяется,
 *     пока дерево не станет корректным: висячие → петли → глубина → корни;
 *  5. архивация отсутствующих — только узлы, под которыми не остаётся живых;
 *  6. привязки людей: именной узел — один человек, основное подчинение — одно на человека.
 */
export function planOrgImport(input: OrgImportInput): OrgImportPlan {
  const parsed = input.rows.map(r => parseRow(r.line, r.values))
  const existingById = new Map(input.existing.map(e => [e.id, e]))
  const existingByKey = new Map(input.existing.filter(e => e.externalKey).map(e => [e.externalKey!, e]))
  /** Существующий узел по ключу файла: сначала `external_key`, затем id (так выгружаются узлы без ключа). */
  const existingOf = (key: string): OrgImportExistingNode | null =>
    existingByKey.get(key) ?? (UUID_RE.test(key) ? existingById.get(key.toLowerCase()) ?? null : null)

  // 2. Первая строка ключа описывает узел, следующие — его держателей.
  const defining = new Map<string, ParsedRow>()
  const extras: ParsedRow[] = []
  for (const p of parsed) {
    const extra = !!p.key && defining.has(p.key)
    if (extra) extras.push(p)
    else if (p.key) defining.set(p.key, p)
    const { keyErrors, nodeErrors, assignErrors } = p.pending
    p.result.errors.push(...keyErrors, ...nodeErrors.filter(e => !extra || p.present.has(e.col)).map(e => e.issue), ...assignErrors)
  }

  // Два ключа файла, указывающие на один существующий узел (ключ и его id), — второй отклоняется.
  const claimed = new Map<string, string>()
  for (const [key, p] of defining) {
    const ex = existingOf(key)
    if (!ex) continue
    const other = claimed.get(ex.id)
    if (other) p.result.errors.push({ code: 'key_duplicate', params: { key: other } })
    else claimed.set(ex.id, key)
  }

  // 3. Справочники.
  const newPositions = new Map<string, string>() // нижний регистр → написание из файла
  const resolved = new Map<string, { positionId: string | null, newPositionName: string | null, orgUnitId: string | null, locationId: string | null }>()
  for (const [key, p] of defining) {
    const errors = p.result.errors
    let positionId: string | null = null
    let newPositionName: string | null = null
    const pos = p.node.positionName
    if (pos) {
      const lower = pos.toLowerCase()
      positionId = input.refs.positions.get(lower) ?? null
      if (!positionId) {
        if (input.refs.inactivePositions.has(lower)) errors.push({ code: 'position_inactive', params: { name: pos } })
        else if (!input.options.createPositions) errors.push({ code: 'position_not_found', params: { name: pos } })
        else newPositionName = newPositions.get(lower) ?? pos
      }
    }
    let orgUnitId: string | null = null
    if (p.node.orgUnitName) {
      orgUnitId = input.refs.orgUnits.get(p.node.orgUnitName.toLowerCase()) ?? null
      if (!orgUnitId) errors.push({ code: 'unit_not_found', params: { name: p.node.orgUnitName } })
    }
    let locationId: string | null = null
    if (p.node.locationName) {
      const lower = p.node.locationName.toLowerCase()
      locationId = input.refs.locations.get(lower) ?? null
      if (!locationId) errors.push({ code: input.refs.inactiveLocations.has(lower) ? 'location_inactive' : 'location_not_found', params: { name: p.node.locationName } })
    }
    // Именной узел не может остаться с двумя держателями, если файл не называет его человека.
    const ex = existingOf(key)
    if (ex && p.node.type === 'employee' && ex.activeHolders > 1 && !parsed.some(q => q.key === key && q.assign.employee)) {
      errors.push({ code: 'named_has_holders', params: { n: ex.activeHolders } })
    }
    if (!errors.length && newPositionName) newPositions.set(newPositionName.toLowerCase(), newPositionName)
    resolved.set(key, { positionId, newPositionName, orgUnitId, locationId })
  }

  // 4. Структура.
  const valid = new Set([...defining].filter(([, p]) => !p.result.errors.length).map(([k]) => k))
  const newIds = new Map<string, string>()
  const idOfKey = (key: string): string => {
    const ex = existingOf(key)
    if (ex) return ex.id
    let id = newIds.get(key)
    if (!id) {
      id = input.newId(key)
      newIds.set(key, id)
    }
    return id
  }
  const keyOfId = new Map<string, string>()
  for (const key of defining.keys()) keyOfId.set(idOfKey(key), key)
  /** Подпись узла в тексте петли: ключ из файла, иначе ключ или id существующего. */
  const nameOf = (id: string) => keyOfId.get(id) ?? existingById.get(id)?.externalKey ?? id

  const reject = (key: string, issue: OrgImportIssue<OrgImportError>) => {
    valid.delete(key)
    defining.get(key)!.result.errors.push(issue)
  }

  const parentOfRow = (p: ParsedRow): { id: string | null } | { error: OrgImportIssue<OrgImportError> } => {
    const pk = p.node.parentKey
    if (!pk) return { id: null }
    if (pk === p.key) return { error: { code: 'self_parent' } }
    if (defining.has(pk)) {
      if (valid.has(pk)) return { id: idOfKey(pk) }
      // Строка родителя отклонена, но сам узел в дереве есть — ребёнок встаёт под него как есть.
      const ex = existingOf(pk)
      if (ex && !ex.archived) return { id: ex.id }
      return { error: { code: 'parent_rejected', params: { key: pk } } }
    }
    const ex = existingOf(pk)
    if (!ex) return { error: { code: 'parent_not_found', params: { key: pk } } }
    if (ex.archived) return { error: { code: 'parent_archived', params: { key: pk } } }
    return { id: ex.id }
  }

  const isLive = (id: string) => {
    const key = keyOfId.get(id)
    if (key && valid.has(key)) return true
    const ex = existingById.get(id)
    return !!ex && !ex.archived
  }

  // Узлы, упомянутые файлом хоть как-то (ключом или как родитель, в том числе в строке с
  // ошибкой), не архивируются: строка с опечаткой — не повод удалить узел из структуры.
  const mentioned = new Set<string>()
  for (const p of parsed) {
    for (const k of [p.key, p.node.parentKey]) {
      const ex = k ? existingOf(k) : null
      if (ex) mentioned.add(ex.id)
    }
  }

  let parentOf = new Map<string, string | null>()
  let layout = new Map<string, { path: string, depth: number }>()
  let archive: string[] = []
  let archiveBlocked = 0

  for (let guard = 0; guard < defining.size + 2; guard++) {
    let changed = false
    parentOf = new Map(input.existing.map(e => [e.id, e.parentId]))
    for (const [key, p] of defining) {
      if (!valid.has(key)) continue
      const r = parentOfRow(p)
      if ('error' in r) {
        reject(key, r.error)
        changed = true
        continue
      }
      parentOf.set(idOfKey(key), r.id)
    }
    if (changed) continue

    const lay = layoutTree([...parentOf].map(([id, parentId]) => ({ id, parentId })), ORG_MAX_DEPTH)
    if (!lay.ok) {
      const tooDeep = new Set<string>()
      for (const prob of lay.problems) {
        if (prob.kind === 'cycle') {
          const ring = prob.ids.map(nameOf).join(' → ')
          for (const id of prob.ids) {
            const key = keyOfId.get(id)
            if (!key || !valid.has(key)) continue
            reject(key, prob.ids.length === 1 ? { code: 'self_parent' } : { code: 'cycle', params: { keys: `${ring} → ${nameOf(prob.ids[0]!)}` } })
            changed = true
          }
        }
        else if (prob.kind === 'depth_exceeded') {
          // Виноват ближайший узел файла на пути вверх: новый узел на 13-м уровне или
          // перенос существующей ветки, после которого её листья опустились ниже 12-го.
          // Если над ним тоже узлы файла ниже 12-го уровня — виноват самый верхний из них:
          // цепочка из 14 новых уровней отклоняется на 13-м, а 14-й становится висячим.
          const isFile = (id: string | null): id is string => id !== null && keyOfId.has(id) && valid.has(keyOfId.get(id)!)
          let cur: string | null = prob.id
          while (cur !== null && !isFile(cur)) cur = parentOf.get(cur) ?? null
          if (cur === null) continue
          let up: string | null = parentOf.get(cur) ?? null
          while (isFile(up) && (lay.layout.get(up)?.depth ?? 0) > ORG_MAX_DEPTH) {
            cur = up
            up = parentOf.get(up) ?? null
          }
          tooDeep.add(keyOfId.get(cur)!)
        }
      }
      for (const key of tooDeep) {
        reject(key, { code: 'depth_exceeded', params: { max: ORG_MAX_DEPTH } })
        changed = true
      }
      if (changed) continue
      // Проблема есть, но ни одна строка файла в ней не виновата — текущее дерево уже нарушено.
      // Сюда не попасть: его держат триггер `org_nodes_guard` и констрейнт глубины.
      throw new Error('org import: current tree violates its own invariant')
    }
    layout = lay.layout

    // 5. Архивация отсутствующих — снизу вверх: узел уходит в архив, только если все его
    // дети в итоговом дереве тоже в архиве (`32` §4: архивируется узел без живых детей).
    archive = []
    archiveBlocked = 0
    if (input.options.archiveMissing) {
      const children = new Map<string, string[]>()
      for (const [id, parent] of parentOf) if (parent) children.set(parent, [...(children.get(parent) ?? []), id])
      const candidates = input.existing
        .filter(e => !e.archived && !mentioned.has(e.id) && !(keyOfId.has(e.id) && valid.has(keyOfId.get(e.id)!)))
        .sort((a, b) => layout.get(b.id)!.depth - layout.get(a.id)!.depth)
      const goes = new Set<string>()
      for (const c of candidates) {
        const kids = children.get(c.id) ?? []
        if (kids.every(k => goes.has(k) || !isLive(k))) goes.add(c.id)
        else archiveBlocked++
      }
      archive = candidates.filter(c => goes.has(c.id)).map(c => c.id)
    }

    // Корни: не больше десяти живых. Лишние — новые корни из файла, по порядку строк с конца.
    const archived = new Set(archive)
    const roots = [...parentOf].filter(([id, parent]) => parent === null && isLive(id) && !archived.has(id)).map(([id]) => id)
    if (roots.length > ORG_MAX_ROOTS) {
      const wasRoot = (id: string) => { const ex = existingById.get(id); return !!ex && !ex.archived && ex.parentId === null }
      const offenders = roots
        .filter(id => keyOfId.has(id) && valid.has(keyOfId.get(id)!) && !wasRoot(id))
        .map(id => keyOfId.get(id)!)
        .sort((a, b) => defining.get(a)!.line - defining.get(b)!.line)
      for (const key of offenders.slice(-(roots.length - ORG_MAX_ROOTS))) {
        reject(key, { code: 'too_many_roots', params: { max: ORG_MAX_ROOTS } })
        changed = true
      }
    }
    if (!changed) break
  }

  // Строки-держатели: узел отклонён — отклонены и они; колонки узла расходятся — ошибка строки.
  for (const p of extras) {
    const d = defining.get(p.key)!
    if (p.result.errors.length) continue
    if (!valid.has(p.key)) {
      p.result.errors.push({ code: 'node_rejected', params: { line: d.line } })
      continue
    }
    const col = NODE_COLUMNS.find(c => p.present.has(c) && nodeValue(p, c) !== nodeValue(d, c))
    if (col) p.result.errors.push({ code: 'row_conflict', params: { column: col, line: d.line } })
  }

  // Узлы плана: родители раньше детей.
  const nodes: OrgImportPlannedNode[] = []
  for (const [key, p] of defining) {
    if (!valid.has(key)) continue
    const id = idOfKey(key)
    const ex = existingOf(key)
    const r = resolved.get(key)!
    const lay = layout.get(id)!
    const parentId = parentOf.get(id) ?? null
    const changed: string[] = []
    if (ex) {
      if (ex.archived) changed.push('state')
      if (ex.parentId !== parentId) changed.push('parent')
      if (ex.type !== p.node.type) changed.push('type')
      if (ex.title !== p.node.title) changed.push('title')
      if (ex.positionId !== r.positionId || r.newPositionName) changed.push('position')
      if (ex.orgUnitId !== r.orgUnitId) changed.push('orgUnit')
      if (ex.locationId !== r.locationId) changed.push('location')
      if (ex.headcountPlanned !== p.node.headcountPlanned) changed.push('headcount')
      if (ex.isManagerPoint !== p.node.isManagerPoint) changed.push('managerPoint')
      if (ex.sort !== p.node.sort) changed.push('sort')
    }
    const action = !ex ? 'create' : changed.length ? 'update' : 'same'
    p.result.action = action
    nodes.push({
      id,
      key,
      line: p.line,
      isNew: !ex,
      restore: !!ex?.archived,
      externalKey: ex ? ex.externalKey : key,
      parentId,
      path: lay.path,
      depth: lay.depth,
      type: p.node.type,
      title: p.node.title,
      positionId: r.positionId,
      newPositionName: r.newPositionName,
      orgUnitId: r.orgUnitId,
      locationId: r.locationId,
      headcountPlanned: p.node.headcountPlanned,
      isManagerPoint: p.node.isManagerPoint,
      sort: p.node.sort,
      action,
      changed,
    })
    if (r.newPositionName) p.result.warnings.push({ code: 'position_created', params: { name: r.newPositionName } })
  }
  nodes.sort((a, b) => a.depth - b.depth || a.line - b.line)
  for (const p of extras) if (!p.result.errors.length) p.result.action = defining.get(p.key)!.result.action

  const fileIds = new Set(nodes.map(n => n.id))
  const relaid = input.existing
    .filter(e => !fileIds.has(e.id) && layout.get(e.id) && layout.get(e.id)!.path !== e.path)
    .map(e => ({ id: e.id, path: layout.get(e.id)!.path, depth: layout.get(e.id)!.depth }))

  // 6. Привязки людей.
  const assignments = planAssignments(parsed, defining, valid, idOfKey, input.person)

  const conflicts: OrgImportPlannedConflict[] = []
  for (const p of parsed) {
    for (const e of p.result.errors) {
      const c = ORG_IMPORT_CONFLICT_OF[e.code]
      if (!c) continue
      conflicts.push({ ...c, line: p.line, key: p.key, details: { line: p.line, externalKey: p.key, parentExternalKey: p.node.parentKey, reason: e.code, ...(e.params ?? {}) } })
    }
  }

  const rows = parsed.map(p => p.result)
  return {
    rows,
    nodes,
    relaid,
    archive,
    assignments,
    positionsToCreate: [...newPositions.values()].filter(name => nodes.some(n => n.newPositionName?.toLowerCase() === name.toLowerCase())),
    conflicts,
    stats: {
      total: rows.length,
      create: nodes.filter(n => n.action === 'create').length,
      update: nodes.filter(n => n.action === 'update').length,
      same: nodes.filter(n => n.action === 'same').length,
      errors: rows.filter(r => r.errors.length).length,
      warnings: rows.filter(r => r.warnings.length).length,
      assignments: assignments.length,
      archive: archive.length,
      archiveBlocked,
    },
  }
}

/**
 * Привязки людей из файла. Строка без человека — просто узел. Импорт **добавляет и уточняет**
 * привязки, но не снимает тех, кого в файле нет: файл «только дерево, без людей» не должен
 * опустошить структуру (снять человека — действие конструктора). Исключение — именной узел:
 * человек из файла заменяет прежнего держателя, иначе узел остался бы с двумя.
 *
 * Основное подчинение одно на человека (`32` §7 п. 4): явное `assignment_is_primary=true`
 * побеждает; если его нет — основным становится первое упоминание человека, остальные —
 * совместительством с предупреждением.
 */
function planAssignments(
  parsed: ParsedRow[],
  defining: Map<string, ParsedRow>,
  valid: Set<string>,
  idOfKey: (key: string) => string,
  person: (ref: string) => OrgImportPerson | null,
): OrgImportPlannedAssignment[] {
  interface Cand { p: ParsedRow, userId: string }
  const cands: Cand[] = []
  const namedHolder = new Map<string, string>()
  const seen = new Set<string>()
  for (const p of parsed) {
    if (!p.key || !valid.has(p.key) || p.result.errors.length || !p.assign.employee) continue
    const who = person(p.assign.employee)
    if (!who) {
      p.result.warnings.push({ code: 'employee_not_found', params: { ref: p.assign.employee } })
      continue
    }
    if (who.archived) {
      p.result.warnings.push({ code: 'employee_archived', params: { ref: p.assign.employee } })
      continue
    }
    const node = defining.get(p.key)!
    if (node.node.type === 'employee') {
      const holder = namedHolder.get(p.key)
      if (holder && holder !== who.id) {
        p.result.warnings.push({ code: 'named_second_holder', params: { line: node.line } })
        continue
      }
      namedHolder.set(p.key, who.id)
    }
    const pair = `${p.key}\u0000${who.id}`
    if (seen.has(pair)) {
      p.result.warnings.push({ code: 'assignment_duplicate' })
      continue
    }
    seen.add(pair)
    cands.push({ p, userId: who.id })
  }

  const byPerson = new Map<string, Cand[]>()
  for (const c of cands) byPerson.set(c.userId, [...(byPerson.get(c.userId) ?? []), c])
  const out: OrgImportPlannedAssignment[] = []
  for (const list of byPerson.values()) {
    const explicit = list.filter(c => c.p.assign.isPrimary === true)
    const kept = list.filter((c) => {
      if (c.p.assign.isPrimary !== true || c === explicit[0]) return true
      c.p.result.warnings.push({ code: 'primary_twice', params: { line: explicit[0]!.p.line } })
      return false
    })
    const primary = explicit[0] ?? kept.find(c => c.p.assign.isPrimary !== false)
    for (const c of kept) {
      const isPrimary = c === primary
      if (!isPrimary && c.p.assign.isPrimary === null && primary) c.p.result.warnings.push({ code: 'secondary_assignment', params: { line: primary.p.line } })
      out.push({ nodeId: idOfKey(c.p.key), key: c.p.key, line: c.p.line, userId: c.userId, role: c.p.assign.role, isPrimary, startedAt: c.p.assign.startedAt })
    }
  }
  return out.sort((a, b) => a.line - b.line)
}
