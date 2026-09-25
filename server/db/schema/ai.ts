import { sql } from 'drizzle-orm'
import { bigserial, boolean, char, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { tenantSecrets } from './platform'

/**
 * Профиль поставщика модели (`docs/v2/30-ai-interview.md` §3.2; план `45` PR-27, миграция
 * `0091_v2_ai_providers`). Вендор скрыт за драйвером: смена вендора — правка строки, а не кода.
 *
 * Профили платформы **копируются тенанту строками** (`30` §3.2 [решение]): `ensureAiProviders()`
 * в `server/db/tenantDefaults.ts` досевает по одному профилю-заглушке на роль при посеве тенанта
 * и при первом обращении к ИИ. Ключ тенанта — только зашифрованной строкой `tenant_secrets`
 * (`secret_ref`), без ключа — ключ платформы из окружения; в эту таблицу ключ не попадает никогда.
 *
 * **Голос не уходит туда, где неизвестен срок хранения** (`30` §7.7, сквозная проверка 18
 * `42` §5): профиль `transcribe` с `provider_retention = 'unknown'` отклоняет и сервис
 * (`422 provider.retention_unknown`), и сама таблица (`ai_providers_transcribe_retention_chk`).
 * Запасной профиль обязан иметь ту же роль — значит, через цепочку запасных голос тоже не уйдёт
 * к поставщику с неизвестным сроком.
 */
export const aiProviders = pgTable('ai_providers', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** Одно из `AI_PURPOSES`. */
  purpose: text('purpose').notNull(),
  /** Одно из `AI_DRIVERS`. */
  driver: text('driver').notNull(),
  /** Базовый адрес API (`…/v1`); путь метода добавляет драйвер. У `stub` — пусто. */
  endpointUrl: text('endpoint_url'),
  /** Свой ключ тенанта: строка `tenant_secrets` с `key = 'ai_provider:<id>'`; пусто — ключ платформы. */
  secretRef: uuid('secret_ref').references(() => tenantSecrets.id, { onDelete: 'set null' }),
  modelName: text('model_name').notNull(),
  modelVersion: text('model_version'),
  /** Температура, лимит токенов (`30` §3.2). Таймаут — отдельной колонкой `max_latency_ms`. */
  params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
  /** Одно из `AI_DATA_REGIONS`; `other` — только с комментарием админа в `audit_log`. */
  dataRegion: text('data_region').notNull().default('eu'),
  /** Одно из `AI_PROVIDER_RETENTIONS`. */
  providerRetention: text('provider_retention').notNull().default('unknown'),
  maxLatencyMs: integer('max_latency_ms').notNull().default(30000),
  isActive: boolean('is_active').notNull().default(true),
  /** Основной профиль роли — активный с наименьшим `priority`. */
  priority: integer('priority').notNull().default(100),
  /** Куда уйти при отказе: та же роль, не сам на себя, глубина цепочки ≤ 2 (`30` §3.2). */
  fallbackProviderId: uuid('fallback_provider_id').references((): AnyPgColumn => aiProviders.id, { onDelete: 'set null' }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
}, t => [
  unique('uq_ai_providers_code').on(t.tenantId, t.code),
  // Частичный индекс выбора профиля роли (`30` §3.2); полный tenant-first — уникальный выше (`40` §7.1)
  index('idx_ai_providers_tenant').on(t.tenantId, t.purpose, t.priority).where(sql`${t.isActive}`),
  check('ai_providers_purpose_chk', sql`${t.purpose} in ('transcribe', 'interview_score', 'review_hint', 'summary', 'generate', 'embed')`),
  check('ai_providers_driver_chk', sql`${t.driver} in ('openai_compatible', 'http_custom', 'self_hosted', 'stub')`),
  check('ai_providers_retention_chk', sql`${t.providerRetention} in ('none', 'ephemeral', 'unknown')`),
  check('ai_providers_region_chk', sql`${t.dataRegion} in ('eu', 'other')`),
  check('ai_providers_transcribe_retention_chk', sql`${t.purpose} <> 'transcribe' or ${t.providerRetention} <> 'unknown'`),
  check('ai_providers_fallback_self_chk', sql`${t.fallbackProviderId} is null or ${t.fallbackProviderId} <> ${t.id}`),
  check('ai_providers_endpoint_chk', sql`${t.driver} = 'stub' or ${t.endpointUrl} is not null`),
  check('ai_providers_latency_chk', sql`${t.maxLatencyMs} between 1000 and 300000`),
])

/**
 * Журнал вызовов модели (`30` §3.2, §7.16): **каждый** вызов модели в продукте — строка здесь,
 * где бы он ни случился (генерация, эмбеддинг, оценка). Пишет только шлюз
 * `server/services/ai/gateway.ts`.
 *
 * Полный вход в БД не хранится (`30` §3.2 [решение]): `input_digest` — sha256 канонического
 * JSON входа, `input_ref` — ключ объекта в S3 для вызовов, которым он нужен для разбора.
 * Ссылка `ref_kind`/`ref_id` мягкая (`44` В-11), снимка названия нет намеренно: название
 * сессии или вакансии — второй экземпляр ПД, который пережил бы обезличивание (`30` §7.9).
 *
 * `request_context` — сверх DDL документа: журнал пишет технический контекст как все журналы
 * (CLAUDE.md п. 14); у фоновых задач он `null`.
 */
export const aiCalls = pgTable('ai_calls', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  providerId: uuid('provider_id').references(() => aiProviders.id, { onDelete: 'set null' }),
  purpose: text('purpose').notNull(),
  promptKey: text('prompt_key').notNull(),
  promptVersion: text('prompt_version').notNull(),
  modelName: text('model_name').notNull(),
  modelVersion: text('model_version'),
  /** Одно из `AI_CALL_REF_KINDS`. */
  refKind: text('ref_kind').notNull(),
  refId: uuid('ref_id'),
  /** О ком вызов (кандидат, автор ответа) — для обезличивания; у генерации и эмбеддинга пусто. */
  subjectUserId: uuid('subject_user_id').references(() => users.id, { onDelete: 'set null' }),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  inputRef: text('input_ref'),
  inputDigest: text('input_digest').notNull(),
  output: jsonb('output'),
  outputDigest: text('output_digest'),
  /** Одно из `AI_CALL_STATUSES`. */
  status: text('status').notNull().default('queued'),
  errorCode: text('error_code'),
  httpStatus: integer('http_status'),
  latencyMs: integer('latency_ms'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  costMinor: integer('cost_minor').notNull().default(0),
  currency: char('currency', { length: 3 }).notNull().default('EUR'),
  /** Одна из `AI_USAGE_AXES` — к какой оси тарифа относится вызов; пусто — вне тарифа (эмбеддинг). */
  usageAxis: text('usage_axis'),
  /** Списал ли этот вызов операцию оси (`usage_events` с `meta.aiCallId`). */
  billed: boolean('billed').notNull().default(false),
  tryNo: integer('try_no').notNull().default(1),
  requestContext: jsonb('request_context'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, t => [
  index('idx_ai_calls_tenant').on(t.tenantId, t.createdAt.desc()),
  index('idx_ai_calls_tenant_ref').on(t.tenantId, t.refKind, t.refId),
  index('idx_ai_calls_tenant_status').on(t.tenantId, t.status, t.createdAt.desc()).where(sql`${t.status} <> 'ok'`),
  // «5 неудач подряд» по профилю (`30` §8 `ai.provider_down`) — последние вызовы одного профиля
  index('idx_ai_calls_tenant_provider').on(t.tenantId, t.providerId, t.createdAt.desc()),
  check('ai_calls_status_chk', sql`${t.status} in ('queued', 'running', 'ok', 'failed', 'timeout', 'refused', 'degraded')`),
  check('ai_calls_ref_chk', sql`${t.refKind} in ('interview_session', 'interview_turn', 'review_hint', 'summary', 'vacancy_generation', 'library_module', 'knowledge_article', 'search_query')`),
  check('ai_calls_axis_chk', sql`${t.usageAxis} is null or ${t.usageAxis} in ('ai_interview_ops', 'ai_review_ops', 'ai_generate_ops')`),
  check('ai_calls_purpose_chk', sql`${t.purpose} in ('transcribe', 'interview_score', 'review_hint', 'summary', 'generate', 'embed')`),
  check('ai_calls_prompt_version_chk', sql`char_length(${t.promptVersion}) between 1 and 40`),
  check('ai_calls_digest_chk', sql`${t.inputDigest} ~ '^[0-9a-f]{64}$'`),
  check('ai_calls_billed_chk', sql`not ${t.billed} or (${t.usageAxis} is not null and ${t.status} = 'ok')`),
  check('ai_calls_try_chk', sql`${t.tryNo} >= 1`),
])
