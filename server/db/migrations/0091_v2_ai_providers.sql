-- docs/v2/45-plan.md PR-27 · docs/v2/30-ai-interview.md §3.2, §7.7, §7.12, §7.16, §7.18 ·
-- docs/v2/35-billing-limits.md §7.1, §7.7 · docs/v2/44-decisions.md §8 (обходной путь: провайдер-заглушка).
--
-- Снимок drizzle не пересобирается начиная с `0056` (см. `docs/28-implementation-notes.md`
-- §28.14): миграция написана руками и меняет только `_journal.json`.
--
-- Две таблицы по DDL `30` §3.2 с правками PR-27 (пометки-исправления в самом `30` §3.2):
--   * `purpose` + `generate`, `embed` — генерация вакансии (PR-17) и эмбеддинги (PR-25) тоже
--     вызовы модели и идут через тот же профиль, журнал и ось потребления;
--   * `driver` + `stub` — детерминированная заглушка как строка профиля (`44` §8);
--   * `secret_ref uuid references tenant_secrets` вместо `text` — как `job_board_accounts` (PR-17);
--   * `ai_providers_transcribe_retention_chk` — сквозная проверка 18 (`42` §5): профиль
--     расшифровки с неизвестным сроком хранения у поставщика не сохраняется даже мимо сервиса;
--   * `ref_kind` + `vacancy_generation`, `library_module`, `knowledge_article`, `search_query`;
--   * `ai_calls.request_context` — журнал (CLAUDE.md п. 14).
--
-- Строк-профилей миграция не вставляет: тенант получает по профилю-заглушке на роль из
-- `ensureAiProviders()` (`server/db/tenantDefaults.ts`) — при посеве и при первом обращении к
-- ИИ. `INSERT … FROM tenants` здесь на чистой БД ничего бы не вставил (миграции идут до сида).

-- ── 1. Профили поставщиков (`30` §3.2) ──────────────────────────────────────────────────
CREATE TABLE "ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"driver" text NOT NULL,
	"endpoint_url" text,
	"secret_ref" uuid,
	"model_name" text NOT NULL,
	"model_version" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data_region" text DEFAULT 'eu' NOT NULL,
	"provider_retention" text DEFAULT 'unknown' NOT NULL,
	"max_latency_ms" integer DEFAULT 30000 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"fallback_provider_id" uuid,
	"updated_by" uuid,
	CONSTRAINT "uq_ai_providers_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "ai_providers_purpose_chk" CHECK ("purpose" in ('transcribe', 'interview_score', 'review_hint', 'summary', 'generate', 'embed')),
	CONSTRAINT "ai_providers_driver_chk" CHECK ("driver" in ('openai_compatible', 'http_custom', 'self_hosted', 'stub')),
	CONSTRAINT "ai_providers_retention_chk" CHECK ("provider_retention" in ('none', 'ephemeral', 'unknown')),
	CONSTRAINT "ai_providers_region_chk" CHECK ("data_region" in ('eu', 'other')),
	-- Сквозная проверка 18 (`42` §5, `30` §7.7): голос не уходит туда, где неизвестен срок хранения
	CONSTRAINT "ai_providers_transcribe_retention_chk" CHECK ("purpose" <> 'transcribe' or "provider_retention" <> 'unknown'),
	CONSTRAINT "ai_providers_fallback_self_chk" CHECK ("fallback_provider_id" is null or "fallback_provider_id" <> "id"),
	CONSTRAINT "ai_providers_endpoint_chk" CHECK ("driver" = 'stub' or "endpoint_url" is not null),
	CONSTRAINT "ai_providers_latency_chk" CHECK ("max_latency_ms" between 1000 and 300000)
);
--> statement-breakpoint
ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_secret_ref_tenant_secrets_id_fk" FOREIGN KEY ("secret_ref") REFERENCES "public"."tenant_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_fallback_provider_id_ai_providers_id_fk" FOREIGN KEY ("fallback_provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Частичный индекс выбора профиля роли (`30` §3.2); полный tenant-first — uq_ai_providers_code (`40` §7.1)
CREATE INDEX "idx_ai_providers_tenant" ON "ai_providers" USING btree ("tenant_id","purpose","priority") WHERE "ai_providers"."is_active";--> statement-breakpoint
ALTER TABLE ai_providers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_providers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON ai_providers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 2. Журнал вызовов модели (`30` §3.2, §7.16) ─────────────────────────────────────────
CREATE TABLE "ai_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider_id" uuid,
	"purpose" text NOT NULL,
	"prompt_key" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text,
	"ref_kind" text NOT NULL,
	"ref_id" uuid,
	"subject_user_id" uuid,
	"actor_user_id" uuid,
	"input_ref" text,
	"input_digest" text NOT NULL,
	"output" jsonb,
	"output_digest" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"http_status" integer,
	"latency_ms" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_minor" integer DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"usage_axis" text,
	"billed" boolean DEFAULT false NOT NULL,
	"try_no" integer DEFAULT 1 NOT NULL,
	"request_context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ai_calls_status_chk" CHECK ("status" in ('queued', 'running', 'ok', 'failed', 'timeout', 'refused', 'degraded')),
	CONSTRAINT "ai_calls_ref_chk" CHECK ("ref_kind" in ('interview_session', 'interview_turn', 'review_hint', 'summary', 'vacancy_generation', 'library_module', 'knowledge_article', 'search_query')),
	CONSTRAINT "ai_calls_axis_chk" CHECK ("usage_axis" is null or "usage_axis" in ('ai_interview_ops', 'ai_review_ops', 'ai_generate_ops')),
	CONSTRAINT "ai_calls_purpose_chk" CHECK ("purpose" in ('transcribe', 'interview_score', 'review_hint', 'summary', 'generate', 'embed')),
	CONSTRAINT "ai_calls_prompt_version_chk" CHECK (char_length("prompt_version") between 1 and 40),
	CONSTRAINT "ai_calls_digest_chk" CHECK ("input_digest" ~ '^[0-9a-f]{64}$'),
	-- Списание — только у успешного вызова с осью: упавший по вине провайдера не тарифицируется (`35` §12)
	CONSTRAINT "ai_calls_billed_chk" CHECK (not "billed" or ("usage_axis" is not null and "status" = 'ok')),
	CONSTRAINT "ai_calls_try_chk" CHECK ("try_no" >= 1)
);
--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_calls_tenant" ON "ai_calls" USING btree ("tenant_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_ai_calls_tenant_ref" ON "ai_calls" USING btree ("tenant_id","ref_kind","ref_id");--> statement-breakpoint
CREATE INDEX "idx_ai_calls_tenant_status" ON "ai_calls" USING btree ("tenant_id","status","created_at" DESC) WHERE "ai_calls"."status" <> 'ok';--> statement-breakpoint
-- «5 неудач подряд» по профилю (`30` §8 `ai.provider_down`)
CREATE INDEX "idx_ai_calls_tenant_provider" ON "ai_calls" USING btree ("tenant_id","provider_id","created_at" DESC);--> statement-breakpoint
ALTER TABLE ai_calls ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_calls FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON ai_calls
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
