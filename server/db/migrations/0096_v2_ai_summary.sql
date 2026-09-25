-- docs/v2/45-plan.md PR-29 · docs/v2/30-ai-interview.md §3.5, §3.6, §4, §5.4, §5.5, §6.4, §6.5,
-- §7.3, §7.7, §7.13–§7.16, §13 к. 6, 10, 11, 13, 14 · docs/v2/42-stages-delta.md §5 проверка 18.
--
-- Снимок drizzle не пересобирается начиная с `0056` (см. `docs/28-implementation-notes.md`
-- §28.14): миграция написана руками и меняет только `_journal.json`. Номер и `when` назначены
-- координатором волны (в `main` последняя — `0095_v2_interview`).
--
-- Три таблицы по DDL `30` §3.5–§3.6 с правками PR-29 (пометки-исправления в самом `30`):
--   * `candidate_summaries` — строка «Документ сформовано автоматично» держится CHECK'ом
--     `candidate_summaries_disclaimer_chk`: без неё Підсумок не сохраняется ни сервисом, ни
--     правкой текста, ни прямой записью, и никакая настройка тенанта её не снимет (`30` §7.14,
--     §13 к. 14). Исключение — строка, стёртая отзывом согласия или обезличиванием (`redacted_at`,
--     тело пусто), и отправленной такая строка быть не может. Сверх DDL: `auto_send_cancelled_at`
--     / `_by` (отмена авто-отправки до срока, §13 к. 13), `redacted_at`, `updated_at`; `share_token`
--     уникален глобально — по нему публичный контур выводит тенанта (функция в §4 ниже).
--     Индекс `idx_candidate_summaries_tenant (tenant_id, candidate_id, version desc)` из DDL не
--     заводится: он повторяет ведущие колонки уникального `(tenant_id, candidate_id, version)`;
--   * `ai_review_hints` — **без полей вердикта** (`is_correct`, `score`, `verdict`, `passed`,
--     `30` §3.6 [решение]); сверх DDL `ai_stub` (Р-28.4), `reason` (§5.5 «причина видна админу»),
--     `updated_at`; решение ментора и `agreement` пишутся только вместе;
--   * `ai_quality_reviews` — `sampled_by` получает перечень (`auto | override`), вердикт и момент
--     проверки пишутся только вместе.
--
-- Плюс: `ai.review.use` системной роли «Наставник» (`30` §2: «Пользоваться подсказкой ИИ при
-- проверке — Ментор ✓»; администратор получает скоуп и так), и узкая «дверь» публичного контура
-- `candidate_summary_public_lookup` (решение `44` В-9 и `41` §8.3.2: запрос без сессии выводит
-- тенанта из токена одной функцией `SECURITY DEFINER`, данные читаются уже в `withTenant()`).
--
-- Голос (`42` §5 проверка 18) схемы не требует: срок `purge_after` у `media_assets` есть с PR-11,
-- стирание делает задача `interview.media_purge` (сервис `server/services/interview/mediaPurge.ts`).

-- ── 1. Підсумок кандидата (`30` §3.5, §5.4, §7.14, §7.15) ──────────────────────────────
CREATE TABLE "candidate_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"vacancy_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"completeness" text DEFAULT 'partial' NOT NULL,
	"body" jsonb NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lang" text DEFAULT 'uk' NOT NULL,
	"generated_by" text DEFAULT 'ai' NOT NULL,
	"ai_call_id" bigint,
	"edited_by" uuid,
	"edited_at" timestamp with time zone,
	"media_id" uuid,
	"share_token" text,
	"share_expires_at" timestamp with time zone,
	"auto_send_rule" jsonb,
	"auto_send_due_at" timestamp with time zone,
	"auto_send_cancelled_at" timestamp with time zone,
	"auto_send_cancelled_by" uuid,
	"sent_at" timestamp with time zone,
	"sent_channel" text,
	"sent_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "uq_candidate_summaries_version" UNIQUE("tenant_id","candidate_id","version"),
	CONSTRAINT "uq_candidate_summaries_share_token" UNIQUE("share_token"),
	CONSTRAINT "candidate_summaries_state_chk" CHECK ("state" in ('draft', 'ready', 'sent', 'revoked', 'expired')),
	CONSTRAINT "candidate_summaries_compl_chk" CHECK ("completeness" in ('full', 'partial')),
	CONSTRAINT "candidate_summaries_gen_chk" CHECK ("generated_by" in ('ai', 'ai_edited', 'manual')),
	CONSTRAINT "candidate_summaries_lang_chk" CHECK ("lang" in ('uk', 'en', 'ru')),
	CONSTRAINT "candidate_summaries_channel_chk" CHECK ("sent_channel" is null or "sent_channel" in ('email', 'link')),
	CONSTRAINT "candidate_summaries_version_chk" CHECK ("version" >= 1),
	CONSTRAINT "candidate_summaries_sections_chk" CHECK (jsonb_typeof("sections") = 'array'),
	-- Отправленный документ — всегда со ссылкой и её сроком (`30` §7.15: «Ссылка живёт 30 дней»)
	CONSTRAINT "candidate_summaries_sent_chk" CHECK ("state" not in ('sent', 'expired') or ("share_token" is not null and "sent_at" is not null and "share_expires_at" is not null)),
	CONSTRAINT "candidate_summaries_revoked_chk" CHECK ("state" <> 'revoked' or "revoked_at" is not null),
	-- `30` §7.14, §13 к. 14: подпись входит в документ и не отключается настройкой тенанта. Текст —
	-- из `shared/domain/candidateSummary.ts` (`SUMMARY_DISCLAIMER`), по языку документа
	-- `coalesce(…, false)`: без подписи выражение даёт NULL, а NULL в CHECK — «проходит»
	CONSTRAINT "candidate_summaries_disclaimer_chk" CHECK ("redacted_at" is not null or coalesce(jsonb_typeof("body" -> 'disclaimer') = 'object' and ("body" -> 'disclaimer' ->> 'text') ~ '^(Документ сформовано автоматично|The document was generated automatically|Документ сформирован автоматически)', false)),
	-- `30` §7.9: у стёртого Підсумка тело пусто, и по ссылке он не открывается
	CONSTRAINT "candidate_summaries_redacted_chk" CHECK ("redacted_at" is null or ("body" = '{}'::jsonb and "state" <> 'sent'))
);
--> statement-breakpoint
ALTER TABLE "candidate_summaries" ADD CONSTRAINT "candidate_summaries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_summaries" ADD CONSTRAINT "candidate_summaries_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_summaries" ADD CONSTRAINT "candidate_summaries_ai_call_id_ai_calls_id_fk" FOREIGN KEY ("ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_summaries" ADD CONSTRAINT "candidate_summaries_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_summaries" ADD CONSTRAINT "candidate_summaries_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_summaries" ADD CONSTRAINT "candidate_summaries_auto_send_cancelled_by_users_id_fk" FOREIGN KEY ("auto_send_cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_summaries" ADD CONSTRAINT "candidate_summaries_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_candidate_summaries_tenant_state" ON "candidate_summaries" USING btree ("tenant_id","state","created_at" DESC);--> statement-breakpoint
-- Авто-отправка по сроку (`30` §3.5, §11 `summary.auto_send`); полный tenant-first — выше (`40` §7.1)
CREATE INDEX "idx_candidate_summaries_tenant_due" ON "candidate_summaries" USING btree ("tenant_id","auto_send_due_at") WHERE state = 'ready';--> statement-breakpoint
ALTER TABLE candidate_summaries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE candidate_summaries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON candidate_summaries
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 2. Подсказка проверяющему (`30` §3.6, §5.5, §7.13) ─────────────────────────────────
CREATE TABLE "ai_review_hints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reviewer_id" uuid,
	"key_source" jsonb NOT NULL,
	"matched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contradictions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coverage" numeric(4, 3),
	"confidence" numeric(4, 3),
	"ai_call_id" bigint,
	"ai_stub" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"shown_at" timestamp with time zone,
	"reviewer_decision" jsonb,
	"reviewer_decided_at" timestamp with time zone,
	"agreement" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "uq_ai_review_hints_target" UNIQUE("tenant_id","target_kind","target_id"),
	CONSTRAINT "ai_review_hints_target_chk" CHECK ("target_kind" in ('attempt_answer', 'workshop_submission')),
	CONSTRAINT "ai_review_hints_state_chk" CHECK ("state" in ('queued', 'ready', 'failed', 'skipped', 'degraded')),
	CONSTRAINT "ai_review_hints_agree_chk" CHECK ("agreement" in ('pending', 'match', 'minor', 'major', 'not_shown')),
	CONSTRAINT "ai_review_hints_lists_chk" CHECK (jsonb_typeof("matched") = 'array' and jsonb_typeof("missing") = 'array' and jsonb_typeof("contradictions") = 'array'),
	CONSTRAINT "ai_review_hints_ratio_chk" CHECK (("coverage" is null or "coverage" between 0 and 1) and ("confidence" is null or "confidence" between 0 and 1)),
	CONSTRAINT "ai_review_hints_decided_chk" CHECK (("reviewer_decided_at" is null) = ("reviewer_decision" is null) and ("agreement" = 'pending' or "reviewer_decided_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "ai_review_hints" ADD CONSTRAINT "ai_review_hints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_hints" ADD CONSTRAINT "ai_review_hints_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_hints" ADD CONSTRAINT "ai_review_hints_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_hints" ADD CONSTRAINT "ai_review_hints_ai_call_id_ai_calls_id_fk" FOREIGN KEY ("ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_review_hints_tenant" ON "ai_review_hints" USING btree ("tenant_id","state","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_ai_review_hints_tenant_agr" ON "ai_review_hints" USING btree ("tenant_id","agreement","created_at" DESC);--> statement-breakpoint
ALTER TABLE ai_review_hints ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_review_hints FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON ai_review_hints
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 3. Выборочная перепроверка качества (`30` §3.6, §6.4, §7.16) ────────────────────────
CREATE TABLE "ai_quality_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ref_kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"sampled_by" text DEFAULT 'auto' NOT NULL,
	"sample_reason" text,
	"auditor_id" uuid,
	"verdict" text,
	"notes" text,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "uq_ai_quality_reviews_ref" UNIQUE("tenant_id","ref_kind","ref_id"),
	CONSTRAINT "aqr_ref_chk" CHECK ("ref_kind" in ('interview_criterion_score', 'review_hint', 'summary')),
	CONSTRAINT "aqr_verdict_chk" CHECK ("verdict" is null or "verdict" in ('correct', 'minor_error', 'major_error', 'harmful')),
	CONSTRAINT "aqr_sampled_by_chk" CHECK ("sampled_by" in ('auto', 'override')),
	CONSTRAINT "aqr_reviewed_chk" CHECK (("verdict" is null) = ("reviewed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "ai_quality_reviews" ADD CONSTRAINT "ai_quality_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_quality_reviews" ADD CONSTRAINT "ai_quality_reviews_auditor_id_users_id_fk" FOREIGN KEY ("auditor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_quality_reviews_tenant" ON "ai_quality_reviews" USING btree ("tenant_id","verdict","created_at" DESC);--> statement-breakpoint
ALTER TABLE ai_quality_reviews ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ai_quality_reviews FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON ai_quality_reviews
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 4. Ссылка на Підсумок без сессии (`30` §10, `41` §8.3.2, решение `44` В-9) ─────────
-- Кандидат открывает документ по ссылке из письма, без входа: `app.tenant_id` не выставлен, и
-- SELECT под RLS вернёт ноль строк. Та же «дверь», что у вакансии и тайного покупателя: одна
-- функция отдаёт только идентификатор строки и тенанта — ни одного поля документа; всё
-- остальное читается в `withTenant()`. Токен уникален глобально — строка не более одной.
CREATE OR REPLACE FUNCTION candidate_summary_public_lookup(p_token text)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT id, tenant_id FROM candidate_summaries WHERE share_token = p_token
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION candidate_summary_public_lookup(text) FROM public;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION candidate_summary_public_lookup(text) TO app_user;--> statement-breakpoint

-- ── 5. Подсказка ИИ — наставнику (`30` §2) ─────────────────────────────────────────────
UPDATE roles SET scopes = array_cat(scopes, ARRAY['ai.review.use'])
	WHERE is_system AND code IN ('mentor', 'admin') AND NOT scopes @> ARRAY['ai.review.use'];
