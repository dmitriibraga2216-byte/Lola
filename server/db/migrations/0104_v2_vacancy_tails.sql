-- vacancies-tails · docs/v2/29 §5.6, §7.7, §9.1, §9.4, §10 (`/j/:token/subscribe`), §11
-- (`vacancy.subscriber_notify`, `vacancy.stats_rollup`). Решения — docs/v2/44 §20 Р-VT.1…Р-VT.5.
--
-- Написана руками: снимок drizzle не пересобирается начиная с `0056` (см. `0098`).
--
-- Три таблицы, без которых три строки ТЗ неисполнимы. Ни одного нового перечисления: у
-- подписки и у чёрного списка нет состояний, у свёртки — только счётчики.

-- ── 1. Подписка на возобновление набора (`29` §5.6, §10 `POST /j/:token/subscribe`) ──────
-- Кнопка «Повідомити, коли відкриється» на странице 410. Адрес живёт ровно до письма
-- `vacancy_subscriber_reopened` или до закрытия вакансии (Р-VT.2): подписка одноразовая,
-- а закрытая вакансия переоткрывается с новым токеном и другими условиями (`29` §4).
CREATE TABLE "vacancy_subscribers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "vacancy_id" uuid NOT NULL REFERENCES "vacancies"("id") ON DELETE cascade,
  "email" text NOT NULL,
  -- Язык письма = язык страницы, с которой подписались (`29` §7.20), `null` — язык пространства.
  "locale" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "vacancy_subscribers_email_chk" CHECK (length("email") BETWEEN 3 AND 200 AND position('@' in "email") > 1)
);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_vacancy_subscribers_email" ON "vacancy_subscribers" USING btree ("tenant_id", "vacancy_id", lower("email"));--> statement-breakpoint
ALTER TABLE vacancy_subscribers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE vacancy_subscribers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON vacancy_subscribers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 2. Суточная свёртка публичной страницы (`29` §9.1, §9.4, §11 `vacancy.stats_rollup`) ──
-- `public_apply_attempts` живёт 30 дней (`vacancy.attempts_gc`), а отчёты §9.1 («просмотров»)
-- и §9.4 («заблокировано», «топ-5 причин») смотрят дальше. Свёртка пересчитывает только дни,
-- целиком лежащие в журнале, поэтому уборка журнала её не уменьшает (Р-VT.3). Без IP.
CREATE TABLE "vacancy_stats_daily" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "vacancy_id" uuid NOT NULL REFERENCES "vacancies"("id") ON DELETE cascade,
  "day" date NOT NULL,
  "views" integer DEFAULT 0 NOT NULL,
  "submits" integer DEFAULT 0 NOT NULL,
  "blocked" integer DEFAULT 0 NOT NULL,
  -- {причина: число} по `public_apply_attempts.reason` строк `submit_blocked` за сутки
  "block_reasons" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "vacancy_stats_daily_pk" PRIMARY KEY ("tenant_id", "vacancy_id", "day"),
  CONSTRAINT "vacancy_stats_daily_nonneg_chk" CHECK ("views" >= 0 AND "submits" >= 0 AND "blocked" >= 0)
);--> statement-breakpoint
CREATE INDEX "idx_vacancy_stats_daily_tenant" ON "vacancy_stats_daily" USING btree ("tenant_id", "day");--> statement-breakpoint
ALTER TABLE vacancy_stats_daily ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE vacancy_stats_daily FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON vacancy_stats_daily
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 3. Чёрный список контактов тенанта (`29` §7.7, слагаемое 100) ────────────────────────
-- Контакт хранится HMAC-хэшем с посолью тенанта (как `ip_hash`, `29` §3.9) плюс маской для
-- экрана: списку нужен ответ «тот же ли это номер», а не сам номер (Р-VT.4). Вид контакта
-- (телефон / почта) не хранится — он виден по маске и перечисления не требует.
CREATE TABLE "contact_blocklist" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "contact_hash" text NOT NULL,
  "contact_masked" text NOT NULL,
  "reason" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "contact_blocklist_reason_chk" CHECK ("reason" IS NULL OR length("reason") <= 500)
);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_contact_blocklist_hash" ON "contact_blocklist" USING btree ("tenant_id", "contact_hash");--> statement-breakpoint
CREATE INDEX "idx_contact_blocklist_tenant" ON "contact_blocklist" USING btree ("tenant_id", "created_at" DESC);--> statement-breakpoint
ALTER TABLE contact_blocklist ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contact_blocklist FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON contact_blocklist
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
