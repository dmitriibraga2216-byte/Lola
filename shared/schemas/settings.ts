import { z } from 'zod'
import { SCOPES } from '../domain/roles'

/**
 * Настройки тенанта (docs/24 §3, `tenants.settings jsonb`) — единая zod-схема с дефолтами.
 * Все разрозненные ключи, появившиеся раньше (`security`, `knowledge`, `contacts`, `guestPage`,
 * `birthdays`, `development`, `learning`, `quietHours`, `importPresets`), сведены сюда: чтение через
 * `tenantSettingsSchema.parse(raw)` всегда даёт полный объект, запись — patch поверх него.
 */

// ── Модули (docs/24 §3.2; docs/32 §В.2: wiki остаётся в коде, по умолчанию выключена) ──
export const MODULES = [
  'workshops', 'programs', 'trajectories', 'meetups', 'webinars', 'complexTests', 'development',
  'assessment', 'knowledge', 'news', 'notices', 'events', 'wiki', 'forum', 'chat', 'bonuses', 'workTasks',
] as const
export type ModuleCode = typeof MODULES[number]
/** Отклонённые в docs/30 модули (форум, wiki, рабочие задачи) и R3 (бонусы, чат) выключены по умолчанию. */
const MODULE_DEFAULT_OFF: ModuleCode[] = ['wiki', 'forum', 'chat', 'bonuses', 'workTasks']
export const modulesSchema = z.object(
  Object.fromEntries(MODULES.map(m => [m, z.boolean().default(!MODULE_DEFAULT_OFF.includes(m))])) as Record<ModuleCode, z.ZodDefault<z.ZodBoolean>>,
)

// ── Акцент бренда (docs/24 §3.1, docs/29 Б.14: только палитра бренд-бука, не произвольный HEX) ──
export const ACCENT_TOKENS = ['sun', 'teal', 'coral', 'ink'] as const
export type AccentToken = typeof ACCENT_TOKENS[number]
export const accentSchema = z.enum(ACCENT_TOKENS)

/** Slug тенанта (docs/24 §4.3, §6). */
export const SLUG_RE = /^[a-z0-9-]{3,30}$/
export const slugSchema = z.string().regex(SLUG_RE)

// ── Политики: десять групп эталона (docs/24 §3.4.1) + наши сессии/OTP (docs/24 §3.4) ──
const policiesSchema = z.object({
  /** «Аутентифікація» */
  auth: z.object({
    tempPasswordLogin: z.boolean().default(false), // «Ввімкнути авторизацію за допомогою тимчасового пароля»
    hideLoginForm: z.boolean().default(false), // «Приховати форму входу»
    limitLoginAttempts: z.boolean().default(true), // «Встановити обмеження кількості спроб»
    loginAttempts: z.number().int().min(3).max(10).default(5), // «Кількість спроб входу перед блокуванням» (docs/24 §3.4: 3–10)
  }).default({}),
  /** «Ролі» */
  roles: z.object({
    defaultRoleCode: z.string().regex(/^[a-z_]{3,40}$/).default('employee'), // «Роль за замовчуванням» — для новых людей (docs/28 «Паритет 4»)
    noGlobalRoles: z.boolean().default(false), // «Не використовувати глобальні ролі»
    assignmentMode: z.enum(['position_map', 'import']).default('position_map'), // «Режим призначення ролей»
  }).default({}),
  /** «Підлеглі» */
  subordinates: z.object({
    mode: z.enum(['position_map', 'import']).default('position_map'),
    includeNestedUnits: z.boolean().default(false), // «Призначати підлеглими всіх користувачів у вкладених папках»
  }).default({}),
  /** «Оргструктура» */
  orgStructure: z.object({
    mode: z.enum(['user_groups', 'import', 'hybrid']).default('user_groups'),
    allowMultipleUnits: z.boolean().default(false), // только при import | hybrid
    allowMultipleImports: z.boolean().default(false), // «Дозволити імпорт декількох оргструктур»
  }).default({}),
  /** «Паролі» (docs/24 §3.4: вход по паролю выкл, длина 8–32, по умолчанию 12) */
  passwords: z.object({
    loginEnabled: z.boolean().default(false),
    disableRecovery: z.boolean().default(false),
    allowPhoneRecovery: z.boolean().default(false),
    maxAgeDays: z.number().int().min(1).max(365).nullable().default(null), // «Обмежити максимальний термін дії пароля»
    minLength: z.number().int().min(8).max(32).default(12),
    forbidWeak: z.boolean().default(true),
    changeAfterFirstLogin: z.boolean().default(false),
    adminTwoFactor: z.boolean().default(false), // «Двухфакторность для админов» [решение]
  }).default({}),
  /** «Телефони» — «Дозволені телефонні коди країн» */
  phones: z.object({
    allowedCountryCodes: z.array(z.string().regex(/^\d{1,4}$/)).max(50).default(['380']),
  }).default({}),
  /** «Сповіщення» — «Домени віртуальної пошти»: на такие адреса письма не уходят */
  notifications: z.object({
    virtualEmailDomains: z.array(z.string().regex(/^[a-z0-9.-]{1,60}$/)).max(50).default([]),
  }).default({}),
  /** «Завдання» */
  tasks: z.object({
    allowSelfAssignDevelopmentSets: z.boolean().default(false),
    showArchivedTasks: z.boolean().default(false),
  }).default({}),
  /** «Користувачі» — «Не перезаписувати під час імпорту» с выбором полей */
  users: z.object({
    showBlockedInReports: z.boolean().default(false),
    importKeepFields: z.array(z.enum(['tags', 'fullName', 'email', 'phone', 'position', 'location', 'orgUnit'])).default([]),
  }).default({}),
  /** «Захист даних» (Spec 11: `disablePrint` уже читается печатью ресурса) */
  dataProtection: z.object({
    disablePrint: z.boolean().default(false),
    disableCopy: z.boolean().default(false),
  }).default({}),
  /** Наши политики входа по телефону и коду (docs/24 §3.4, «чего в эталоне нет, а у нас есть») */
  session: z.object({
    lengthDays: z.number().int().min(1).max(90).default(30),
    maxConcurrent: z.number().int().min(1).max(10).default(5),
    idleTimeoutMinutes: z.number().int().min(15).max(30 * 24 * 60).default(7 * 24 * 60),
    otpLength: z.number().int().min(4).max(8).default(6),
    otpTtlMinutes: z.number().int().min(1).max(15).default(5),
    otpAttempts: z.number().int().min(3).max(10).default(5),
    otpSendsPer15Min: z.number().int().min(1).max(5).default(3),
    blockMinutes: z.number().int().min(5).max(120).default(30),
    allowedCountries: z.array(z.string().length(2)).max(250).default([]), // пусто — все
  }).default({}),
})

/**
 * Тихие часы (docs/24 §6; docs/23 §13.2.1 «Обмежити період відправлення повідомлень»):
 * начало < конца, окно ≥ 4 часов; `enabled` — сам переключатель обмеження (по умолчанию увімкнено,
 * як в еталоні), вимкнений — уведомления не переносятся на утро.
 */
const quietHoursSchema = z.object({
  enabled: z.boolean().default(true),
  from: z.number().int().min(0).max(23).default(9),
  to: z.number().int().min(1).max(24).default(20),
})
  .refine(q => q.to - q.from >= 4, { message: 'Вікно має бути не меншим за 4 години' })

/** Час доби HH:MM (docs/23 §13.2.1: свій час на кожен клас подій). */
const clockSchema = z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) })

/**
 * Час відправлення повідомлень по класах подій (docs/23 §13.2.1, знято з еталона `/notifications/settings`):
 * не одне вікно тиші на все, а свій час на клас + «Надіслати додаткове нагадування за N днів» — для днів
 * народження вже є `birthdays.reminderDays`. Значення за замовчуванням — як у знятій установці.
 */
const notificationScheduleShape = z.object({
  birthdays: clockSchema.default({ hour: 9, minute: 0 }),
  anniversaries: clockSchema.default({ hour: 9, minute: 0 }), // «Річниці» — довг: подія ще не реалізована (docs/28 «Spec 23»)
  autoClosedTasks: clockSchema.default({ hour: 0, minute: 0 }), // «Автоматично завершені завдання» — службова розсилка вночі
  managerDigest: clockSchema.default({ hour: 9, minute: 0 }), // дайджест керівнику
  dueTasks: clockSchema.default({ hour: 9, minute: 0 }), // термін виконання закінчується
  programReminder: clockSchema.default({ hour: 9, minute: 0 }), // нагадування за день до старту елемента програми — довг
})
export const notificationScheduleSchema = notificationScheduleShape.default({})
export type NotificationSchedule = z.infer<typeof notificationScheduleSchema>
export const notificationSchedulePatchSchema = z.object(
  Object.fromEntries(Object.keys(notificationScheduleShape.shape).map(k => [k, clockSchema.partial().optional()])),
).strict()

/** Обвʼязка листа тенанта (docs/23 §13.5 `/notifications/email-template-settings`): шапка/підвал/лого. */
const emailLayoutShape = z.object({
  headerMjml: z.string().max(20_000).default(''),
  footerMjml: z.string().max(20_000).default(''),
  logoKey: z.string().max(300).nullable().default(null),
})
export const emailLayoutSchema = emailLayoutShape.default({})
export type EmailLayout = z.infer<typeof emailLayoutSchema>
export const emailLayoutPatchSchema = emailLayoutShape.partial().strict()

export const tenantSettingsSchema = z.object({
  /** Простір (docs/24 §3.1; name/slug/locale/timezone — колонки tenants, акцент — branding) */
  space: z.object({
    localesEnabled: z.array(z.enum(['uk', 'en'])).min(1).default(['uk']),
    weekStart: z.enum(['monday', 'sunday']).default('monday'),
    supportContact: z.object({ name: z.string().max(120).optional(), phone: z.string().max(30).optional(), email: z.string().email().max(120).optional(), telegram: z.string().max(60).optional() }).default({}),
  }).default({}),
  modules: modulesSchema.default({}),
  /** Значения по умолчанию для обучения (docs/24 §3.3), их наследуют назначения */
  defaults: z.object({
    passScorePct: z.number().int().min(0).max(100).default(80),
    attempts: z.number().int().min(1).max(20).default(3),
    attemptPauseMinutes: z.number().int().min(0).max(1440).default(0),
    showAnswers: z.enum(['never', 'after_pass', 'always']).default('after_pass'),
    strictLessonOrder: z.boolean().default(true),
    dueDays: z.number().int().min(1).max(365).default(14),
    certificateValidityDays: z.number().int().min(1).max(3650).nullable().default(365),
    reviewSlaHours: z.number().int().min(1).max(720).default(48),
    notificationChannel: z.enum(['telegram', 'sms', 'email', 'push']).default('telegram'),
  }).default({}),
  policies: policiesSchema.default({}),
  quietHours: quietHoursSchema.default({}),
  // Spec 23 (docs/23 §13.2.1, §13.5)
  notificationSchedule: notificationScheduleSchema,
  emailLayout: emailLayoutSchema,
  /** Ниже — ключи, заведённые раньше отдельными спеками; сведены сюда без смены формы */
  security: z.object({ emailAlerts: z.boolean().default(false) }).default({}), // Spec 22
  knowledge: z.object({ restrictAccess: z.boolean().default(true) }).default({}), // Spec 21
  contacts: z.object({ showPersonal: z.boolean().default(false) }).default({}), // Spec 21
  birthdays: z.object({ reminderDays: z.number().int().min(0).max(30).default(3) }).default({}), // Spec 21
  learning: z.object({
    autoCloseAfterDays: z.number().int().min(1).max(365).default(14), // Паритет 2
    quizDefaults: z.record(z.unknown()).default({}), // taskParams: поверх системных
  }).default({}),
  development: z.object({
    goalsNeedApproval: z.boolean().default(false),
    externalTrainingThreshold: z.number().min(0).default(5000),
    careerAssessmentFormId: z.string().uuid().nullable().default(null),
  }).default({}),
  guestPage: z.record(z.unknown()).default({}), // форма — guestBlocksSchema (hub)
  importPresets: z.record(z.unknown()).default({}),
})
export type TenantSettings = z.infer<typeof tenantSettingsSchema>
export type TenantPolicies = TenantSettings['policies']

/** PATCH /settings/policies — пачкой, любые группы частично */
const pShape = policiesSchema.shape
export const policiesPatchSchema = z.object({
  auth: pShape.auth.removeDefault().partial().optional(),
  roles: pShape.roles.removeDefault().partial().optional(),
  subordinates: pShape.subordinates.removeDefault().partial().optional(),
  orgStructure: pShape.orgStructure.removeDefault().partial().optional(),
  passwords: pShape.passwords.removeDefault().partial().optional(),
  phones: pShape.phones.removeDefault().partial().optional(),
  notifications: pShape.notifications.removeDefault().partial().optional(),
  tasks: pShape.tasks.removeDefault().partial().optional(),
  users: pShape.users.removeDefault().partial().optional(),
  dataProtection: pShape.dataProtection.removeDefault().partial().optional(),
  session: pShape.session.removeDefault().partial().optional(),
}).strict()
export type PoliciesPatch = z.infer<typeof policiesPatchSchema>

export const modulesPatchSchema = modulesSchema.partial().strict()

/** PATCH /settings/tenant — простір, бренд, slug (docs/24 §3.1, §6) */
export const tenantPatchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  slug: slugSchema.optional(),
  locale: z.enum(['uk', 'en']).optional(),
  timezone: z.string().min(3).max(60).optional(),
  accent: accentSchema.optional(),
  space: tenantSettingsSchema.shape.space.removeDefault().partial().optional(),
  defaults: tenantSettingsSchema.shape.defaults.removeDefault().partial().optional(),
  quietHours: quietHoursSchema.optional(),
}).strict()
export type TenantPatch = z.infer<typeof tenantPatchSchema>

// ── Роли (docs/24 §3.5, Г-24.1; docs/01 §1.2) ──
export const ROLE_CODE_RE = /^[a-z_]{3,40}$/
export const roleCreateSchema = z.object({
  code: z.string().regex(ROLE_CODE_RE),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  scopes: z.array(z.enum(SCOPES)).min(1),
  defaultScopeType: z.enum(['tenant', 'org_unit', 'location']).default('location'),
})
export const rolePatchSchema = roleCreateSchema.omit({ code: true }).partial().strict()
export type RoleCreate = z.infer<typeof roleCreateSchema>
export type RolePatch = z.infer<typeof rolePatchSchema>

// ── Шкалы (docs/24 Г-24.4; docs/02 «Геймификация и шкалы») ──
const scaleLevelSchema = z.object({
  label: z.string().trim().min(1).max(80),
  value: z.number().nullable().optional(),
  rangeFrom: z.number().min(0).max(100).nullable().optional(),
  rangeTo: z.number().min(0).max(100).nullable().optional(),
  characteristic: z.string().trim().max(300).nullable().optional(),
  showInReports: z.boolean().default(true),
})
export const scaleSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  kind: z.enum(['range', 'levels']),
  displayAs: z.enum(['label', 'value']).nullable().optional(),
  levels: z.array(scaleLevelSchema).min(2).max(20),
}).superRefine((s, ctx) => {
  if (s.kind === 'range') {
    // Диапазоны процентов: 0–100 без дыр и пересечений, по возрастанию
    let expected = 0
    for (const [i, l] of s.levels.entries()) {
      if (l.rangeFrom == null || l.rangeTo == null) { ctx.addIssue({ code: 'custom', path: ['levels', i], message: 'Вкажіть діапазон' }); return }
      if (l.rangeFrom !== expected || l.rangeTo < l.rangeFrom) { ctx.addIssue({ code: 'custom', path: ['levels', i], message: 'Діапазони мають іти підряд від 0 до 100' }); return }
      expected = l.rangeTo + 1
    }
    if (expected !== 101) ctx.addIssue({ code: 'custom', path: ['levels'], message: 'Останній діапазон має закінчуватись на 100' })
    if (s.displayAs) ctx.addIssue({ code: 'custom', path: ['displayAs'], message: 'Лише для шкали рівнів' })
  }
  else {
    for (const [i, l] of s.levels.entries()) {
      if (l.value == null) ctx.addIssue({ code: 'custom', path: ['levels', i, 'value'], message: 'Вкажіть числове значення' })
    }
  }
})
export type ScaleInput = z.infer<typeof scaleSchema>

// ── Переводы (docs/24 §3.6) ──
/**
 * Ключ перекладу: або шлях інтерфейсу (`a.b.c`), або фраза шаблону сповіщення —
 * вміст `{{#_tr}}…{{/_tr}}` (docs/23 §13.4): один шаблон, переклад по локалі отримувача
 * через цю саму таблицю (docs/28 «Spec 23» — рішення без нової таблиці).
 */
export const translationSchema = z.object({
  locale: z.enum(['uk', 'en']),
  key: z.string().trim().min(1).max(300),
  value: z.string().min(1).max(2000),
})
export const translationsImportSchema = z.object({
  locale: z.enum(['uk', 'en']),
  items: z.record(z.string().min(1).max(2000)).refine(o => Object.keys(o).length <= 5000, 'Не більше 5000 ключів за раз'),
})

// ── Категории каталога (docs/24 §3.7.1: свой порядок, без цифр в названии) ──
export const categorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().uuid().nullable().optional(),
})
export const categoryReorderSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) })

// ── Impersonation (docs/24 §4.5, docs/29 Б.13) ──
export const IMPERSONATION_MINUTES = 60
export const impersonateSchema = z.object({ userId: z.string().uuid(), reason: z.string().trim().min(10).max(500) })
