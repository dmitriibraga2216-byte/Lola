import { z } from 'zod'
import { CONTENT_TYPES, ENROLLMENT_STATUSES, SECURITY_SEVERITIES } from '../enums'
import { KEYSETS } from '../domain/keyset'
import { keysetCursorSchema } from './keyset'

/**
 * Контракты отчётов и журналов (docs/22 §13.3–13.4, Г-22.1; docs/04 §4.14).
 * Каркас — одна и та же левая часть у всех отчётов «по предмету», сквозных отчётов и журналов:
 * ПІБ · Посада · Місто · Підрозділ · Мітки · Дата призначення · Дата завершення · Поточний статус · Результат.
 */

/** Колонки каркаса в том порядке, в котором они идут первыми в таблице и в выгрузке. */
export const FRAME_COLUMNS = ['full_name', 'position', 'city', 'unit', 'tags', 'assigned_at', 'completed_at', 'status', 'result'] as const
export type FrameColumn = typeof FRAME_COLUMNS[number]

export const reportFrameSchema = z.object({
  user_id: z.string().uuid(),
  full_name: z.string(),
  user_status: z.string().nullable().optional(),
  position: z.string().nullable(),
  city: z.string().nullable(),
  unit: z.string().nullable(),
  location: z.string().nullable().optional(),
  tags: z.array(z.string()),
  assigned_at: z.union([z.string(), z.date()]).nullable(),
  completed_at: z.union([z.string(), z.date()]).nullable(),
  status: z.enum(ENROLLMENT_STATUSES).nullable(),
  result: z.number().nullable(),
})
export type ReportFrame = z.infer<typeof reportFrameSchema>

/** «Контекст проходження» (Г-22.1): вместо «Поза курсами»/«Поза програмами» — одно поле с четырьмя значениями. */
export const PASS_CONTEXTS = ['any', 'standalone', 'in_course', 'in_program'] as const
export const passContextSchema = z.enum(PASS_CONTEXTS)
export type PassContext = z.infer<typeof passContextSchema>

const uuidList = z.union([z.string().uuid(), z.array(z.string().uuid())]).transform(v => Array.isArray(v) ? v : [v]).optional()
const strList = z.union([z.string().min(1), z.array(z.string().min(1))]).transform(v => Array.isArray(v) ? v : [v]).optional()

/** Общие фильтры отчётов (docs/04 §4.14): период, точка, посада, метки, контекст проходження. */
export const reportFilterSchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  locationId: z.string().uuid().optional(),
  positionIds: uuidList,
  orgUnitId: z.string().uuid().optional(),
  tags: strList,
  status: z.enum(ENROLLMENT_STATUSES).optional(),
  context: passContextSchema.default('any'),
  contextId: z.string().uuid().optional(), // конкретный курс или программа при in_course | in_program
  includeArchived: z.coerce.boolean().optional(),
  q: z.string().max(120).optional(),
})
export type ReportFilter = Partial<z.infer<typeof reportFilterSchema>>

/** Отчёт по типу контента (docs/22 §13.2, §13.7): один экран, предмет или назначение — фильтром. */
export const taskReportQuerySchema = reportFilterSchema.extend({
  subjectId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  format: z.enum(['json', 'xlsx']).default('json'),
})
export type TaskReportQuery = Partial<z.infer<typeof taskReportQuerySchema>>
export const taskReportContentTypeSchema = z.enum(CONTENT_TYPES)

/** Журналы: фильтры одинаковы для всех видов; severity — только у безпеки. */
export const logFilterSchema = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  userId: z.string().uuid().optional(),
  type: z.string().max(80).optional(),
  severity: z.enum(SECURITY_SEVERITIES).optional(),
  orgUnitId: z.string().uuid().optional(), // мокап SecurityLog: фильтр «Підрозділ» (с потомками)
  state: z.enum(['open', 'resolved', 'all']).optional(), // протокол конфликтов: «Не вирішено» / «Вирішено»
  contentType: z.enum(CONTENT_TYPES).optional(),
  contentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: keysetCursorSchema(KEYSETS.logs).optional(), // выдаёт сервер в ответе журнала, не момент времени
  format: z.enum(['json', 'xlsx']).default('json'),
})
export type LogFilter = Partial<z.infer<typeof logFilterSchema>>

/** Сводный отчёт — мастер (docs/22 §13.1): Користувачі → Завдання → Конфігурація → Результат. */
export const summaryUserFilterSchema = z.object({
  q: z.string().max(120).optional(),
  locationIds: z.array(z.string().uuid()).max(200).optional(),
  positionIds: z.array(z.string().uuid()).max(200).optional(),
  orgUnitIds: z.array(z.string().uuid()).max(200).optional(),
  tags: z.array(z.string().min(1)).max(50).optional(),
  userIds: z.array(z.string().uuid()).max(5000).optional(),
  includeArchived: z.boolean().optional(),
})
export const summaryTaskFilterSchema = z.object({
  q: z.string().max(120).optional(),
  contentTypes: z.array(z.enum(CONTENT_TYPES)).optional(),
  assignmentIds: z.array(z.string().uuid()).max(500).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
})
export const SUMMARY_COLUMNS = ['status', 'result', 'assigned_at', 'completed_at', 'due_at', 'attempts'] as const
export const SUMMARY_GROUP_BY = ['none', 'location', 'position', 'unit', 'task'] as const
export const summaryReportSchema = z.object({
  step: z.enum(['users', 'tasks', 'result']).default('result'),
  userFilter: summaryUserFilterSchema.default({}),
  taskFilter: summaryTaskFilterSchema.default({}),
  columns: z.array(z.enum(SUMMARY_COLUMNS)).default(['status', 'result']),
  groupBy: z.enum(SUMMARY_GROUP_BY).default('none'),
  limit: z.number().int().min(1).max(5000).optional(),
})
export type SummaryReportInput = z.infer<typeof summaryReportSchema>

/** Настройка «Повідомляти про зміни на E-mail» журнала безпеки (docs/22 §13.4): письмо администраторам при warning и critical. */
export const securitySettingsSchema = z.object({
  emailAlerts: z.boolean(),
})
export type SecuritySettings = z.infer<typeof securitySettingsSchema>
