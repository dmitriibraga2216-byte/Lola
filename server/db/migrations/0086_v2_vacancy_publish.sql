-- docs/v2/45-plan.md PR-17 · docs/v2/29-vacancies.md §3.7–§3.10, §7.9–§7.18 ·
-- docs/v2/44-decisions.md §8 (обходной путь: реальные аккаунты площадок не заводятся).
--
-- Снимок drizzle не пересобирается начиная с `0056` (см. `docs/28-implementation-notes.md`
-- §28.14): миграция написана руками и меняет только `_journal.json` — тем же порядком, что
-- и весь пакет `docs/v2` с этой точки.
--
-- Три таблицы. `job_board_accounts` и `vacancy_publications` — по DDL `29` §3.7–§3.8 буквально,
-- `vacancy_publications.state` — с добавленным восьмым значением `manual` (пометка-исправление
-- в `docs/v2/29-vacancies.md` §3.8 и `shared/enums.ts`). Реальные аккаунты площадок в этой
-- миграции не появляются — секрет, на который ссылается `secret_ref`, несёт токен
-- детерминированной заглушки-адаптера (`server/services/jobBoardAdapter.ts`), а не вендора.

-- ── 1. Аккаунты внешних площадок (`29` §3.7) ────────────────────────────────────────────
CREATE TABLE "job_board_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_user_id" uuid,
	"label" text,
	"status" text DEFAULT 'not_connected' NOT NULL,
	"secret_ref" uuid,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"connected_by" uuid,
	"connected_at" timestamp with time zone,
	CONSTRAINT "job_board_accounts_provider_chk" CHECK ("provider" in ('work_ua', 'robota_ua', 'telegram')),
	CONSTRAINT "job_board_accounts_owner_chk" CHECK ("owner_type" in ('company', 'personal', 'recruiter')),
	CONSTRAINT "job_board_accounts_coherence_chk" CHECK (("owner_type" = 'company' and "owner_user_id" is null) or ("owner_type" <> 'company' and "owner_user_id" is not null)),
	CONSTRAINT "job_board_accounts_status_chk" CHECK ("status" in ('not_connected', 'connecting', 'active', 'failing', 'revoked', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "job_board_accounts" ADD CONSTRAINT "job_board_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_board_accounts" ADD CONSTRAINT "job_board_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_board_accounts" ADD CONSTRAINT "job_board_accounts_secret_ref_tenant_secrets_id_fk" FOREIGN KEY ("secret_ref") REFERENCES "public"."tenant_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_board_accounts" ADD CONSTRAINT "job_board_accounts_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_job_board_accounts_owner" ON "job_board_accounts" USING btree ("tenant_id","provider","owner_type",coalesce("owner_user_id",'00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "idx_job_board_accounts_tenant" ON "job_board_accounts" USING btree ("tenant_id","provider","status");--> statement-breakpoint
ALTER TABLE job_board_accounts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE job_board_accounts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON job_board_accounts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 2. Журнал публикаций (`29` §3.8) ────────────────────────────────────────────────────
-- `state` несёт восьмое значение `manual` сверх документа (пометка-исправление §3.8):
-- обходной путь `44` §8 — рекрутер публикует руками и вставляет ссылку, без вызова адаптера.
CREATE TABLE "vacancy_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vacancy_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"external_id" text,
	"external_url" text,
	"payload_hash" text,
	"published_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error" text,
	"requested_by" uuid NOT NULL,
	CONSTRAINT "vacancy_publications_state_chk" CHECK ("state" in ('queued', 'publishing', 'active', 'failed', 'removed', 'expired', 'conflict', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "vacancy_publications" ADD CONSTRAINT "vacancy_publications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_publications" ADD CONSTRAINT "vacancy_publications_vacancy_id_vacancies_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_publications" ADD CONSTRAINT "vacancy_publications_account_id_job_board_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."job_board_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_publications" ADD CONSTRAINT "vacancy_publications_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_vacancy_publications_active" ON "vacancy_publications" USING btree ("tenant_id","vacancy_id","account_id") WHERE "vacancy_publications"."state" in ('queued', 'publishing', 'active', 'conflict', 'manual');--> statement-breakpoint
CREATE INDEX "idx_vacancy_publications_tenant" ON "vacancy_publications" USING btree ("tenant_id","vacancy_id","state");--> statement-breakpoint
ALTER TABLE vacancy_publications ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE vacancy_publications FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON vacancy_publications
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 3. Журнал ИИ-генераций (`29` §3.10) ─────────────────────────────────────────────────
CREATE TABLE "vacancy_ai_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vacancy_id" uuid,
	"target" text NOT NULL,
	"input" jsonb NOT NULL,
	"output_chars" integer,
	"model" text,
	"ops_charged" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"error_code" text,
	"author_id" uuid NOT NULL,
	CONSTRAINT "vacancy_ai_generations_target_chk" CHECK ("target" in ('description', 'requirements', 'duties', 'extra', 'criteria')),
	CONSTRAINT "vacancy_ai_generations_status_chk" CHECK ("status" in ('ok', 'failed', 'limited'))
);
--> statement-breakpoint
ALTER TABLE "vacancy_ai_generations" ADD CONSTRAINT "vacancy_ai_generations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_ai_generations" ADD CONSTRAINT "vacancy_ai_generations_vacancy_id_vacancies_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_ai_generations" ADD CONSTRAINT "vacancy_ai_generations_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vacancy_ai_generations_tenant" ON "vacancy_ai_generations" USING btree ("tenant_id","created_at" DESC);--> statement-breakpoint
ALTER TABLE vacancy_ai_generations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE vacancy_ai_generations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON vacancy_ai_generations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 4. Всплеск блокировок публичной формы (`29` §7.8) ───────────────────────────────────
-- Момент, до которого частотные лимиты §7.4 удвоены для этой вакансии. Не выводится из
-- public_apply_attempts на лету: шестичасовое окно должно помнить момент обнаружения всплеска.
ALTER TABLE "vacancies" ADD COLUMN "spam_hardened_until" timestamp with time zone;--> statement-breakpoint

-- vacancy_public_lookup() (0074_v2_vacancy_apply) отдаёт ещё и это поле: rateVerdict()
-- публичного контура узнаёт про хардненинг без второго обращения к БД внутри тенанта.
-- Postgres не даёт CREATE OR REPLACE поменять состав RETURNS TABLE — функция дропается
-- и создаётся заново. DROP уничтожает и права, которые 0079 навесила на прежнюю версию
-- (REVOKE … FROM public, GRANT … TO app_user) — оба выставляются заново следующими двумя
-- строками, тем же порядком, что и три двери в 0079 (иначе новая функция создаётся с правом
-- EXECUTE у PUBLIC по умолчанию Postgres — сквозная проверка `rls.spec.ts` «двери» это ловит).
DROP FUNCTION IF EXISTS vacancy_public_lookup(text);--> statement-breakpoint
CREATE FUNCTION vacancy_public_lookup(p_token text)
RETURNS TABLE (id uuid, tenant_id uuid, state text, public_enabled boolean, owner_id uuid, spam_hardened_until timestamptz)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT id, tenant_id, state, public_enabled, coalesce(recruiter_id, created_by), spam_hardened_until
    FROM vacancies WHERE public_token = p_token
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION vacancy_public_lookup(text) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION vacancy_public_lookup(text) TO app_user;
