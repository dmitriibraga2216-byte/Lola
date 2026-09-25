-- docs/v2/45-plan.md PR-28 · docs/v2/30-ai-interview.md §3.1, §3.3–§3.5, §3.7, §4, §7.1–§7.9 ·
-- docs/v2/44-decisions.md В-12 (`quizzes.kind = 'interview'`, колонка `mode` отменена).
--
-- Снимок drizzle не пересобирается начиная с `0056` (см. `docs/28-implementation-notes.md`
-- §28.14): миграция написана руками и меняет только `_journal.json`.
--
-- Шесть таблиц по DDL `30` §3.3–§3.5 с правками PR-28 (пометки-исправления в самом `30`):
--   * `interview_scenarios.alternative_path` без значения по умолчанию и nullable у черновика —
--     иначе критерий `30` §13 к. 3 («сценарий без alternative_path не публикуется») был бы
--     невыполним: колонка с `default 'human_interview'` пустой не бывает. Публикация без
--     альтернативы запрещена CHECK'ом `interview_scenarios_alt_published_chk` и мимо сервиса;
--   * `interview_scenarios.published_at`, один опубликованный сценарий на тест (частичный
--     уникальный индекс), CHECK'и формы `30` §6.1; `record_video` — только `false` (видео — не PR-28);
--   * `interview_consents.request_context` (журнал, CLAUDE.md п. 14), отказ без альтернативы и
--     отзыв без `withdrawn_at` — CHECK'ами;
--   * `interview_sessions.ai_stub` — явный признак вывода профиля-заглушки (Р-28.4),
--     `redacted_at` — записи стёрты отзывом согласия или обезличиванием (`30` §7.6, §7.9),
--     `degraded_reason` + `unexplained` («оценка без обоснования», `30` §4);
--   * `interview_criterion_scores.rationale` nullable **только** у стёртой строки: обоснование и
--     цитата обязательны CHECK'ами для любой живой строки, а вставить стёртую нельзя (триггер);
--   * индексы `idx_interview_turns_tenant` и `idx_interview_criterion_scores_tenant` из DDL не
--     заводятся: они повторяют ведущие колонки уникальных ограничений тех же таблиц.
-- Плюс `quizzes_kind_chk` (В-12) и `candidate_scores.ai_stub` (Р-28.4).
--
-- `attempt_answers.input_mode` из `30` §3.7 уже заведён миграцией `0078_v2_learning_time` (PR-21).

-- ── 1. Вид теста: третье значение `interview` (В-12) ─────────────────────────────────────
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_kind_chk" CHECK ("kind" in ('quiz', 'certification', 'interview'));--> statement-breakpoint

-- ── 2. Явный признак оценки заглушки (Р-28.4) ───────────────────────────────────────────
ALTER TABLE "candidate_scores" ADD COLUMN "ai_stub" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_scores" ADD CONSTRAINT "candidate_scores_ai_stub_chk" CHECK (not "ai_stub" or "kind" = 'ai');--> statement-breakpoint

-- ── 3. Сценарий (`30` §3.3, форма §6.1) ─────────────────────────────────────────────────
CREATE TABLE "interview_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quiz_id" uuid NOT NULL,
	"name" text NOT NULL,
	"interviewer_name" text DEFAULT 'Лола' NOT NULL,
	"intro_text" text NOT NULL,
	"outro_text" text NOT NULL,
	"answer_modes" text[] DEFAULT '{voice,text}'::text[] NOT NULL,
	"min_answer_sec" integer DEFAULT 5 NOT NULL,
	"max_answer_sec" integer DEFAULT 180 NOT NULL,
	"think_time_sec" integer DEFAULT 15 NOT NULL,
	"silence_timeout_sec" integer DEFAULT 45 NOT NULL,
	"retake_limit" integer DEFAULT 2 NOT NULL,
	"record_video" boolean DEFAULT false NOT NULL,
	"transcribe_lang" text DEFAULT 'uk' NOT NULL,
	"min_confidence" numeric(4, 3) DEFAULT '0.600' NOT NULL,
	"alternative_path" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"published_at" timestamp with time zone,
	CONSTRAINT "uq_interview_scenarios_version" UNIQUE("tenant_id","quiz_id","version"),
	CONSTRAINT "interview_scenarios_alt_chk" CHECK ("alternative_path" is null or "alternative_path" in ('human_interview', 'text_form')),
	-- `30` §7.5, §13 к. 3: сценарий, который нечем заменить, опубликовать нельзя
	CONSTRAINT "interview_scenarios_alt_published_chk" CHECK ("status" = 'draft' or "alternative_path" is not null),
	CONSTRAINT "interview_scenarios_modes_chk" CHECK (array_length("answer_modes", 1) between 1 and 2 and "answer_modes" <@ array['voice', 'text']::text[]),
	CONSTRAINT "interview_scenarios_status_chk" CHECK ("status" in ('draft', 'published', 'archived')),
	CONSTRAINT "interview_scenarios_time_chk" CHECK ("max_answer_sec" between 30 and 600 and "min_answer_sec" >= 1 and "min_answer_sec" < "max_answer_sec"),
	CONSTRAINT "interview_scenarios_think_chk" CHECK ("think_time_sec" between 0 and 120 and "silence_timeout_sec" between 5 and 600),
	CONSTRAINT "interview_scenarios_retake_chk" CHECK ("retake_limit" between 0 and 5),
	CONSTRAINT "interview_scenarios_confidence_chk" CHECK ("min_confidence" between 0.3 and 0.95),
	CONSTRAINT "interview_scenarios_lang_chk" CHECK ("transcribe_lang" in ('uk', 'en', 'ru')),
	CONSTRAINT "interview_scenarios_video_chk" CHECK (not "record_video")
);
--> statement-breakpoint
ALTER TABLE "interview_scenarios" ADD CONSTRAINT "interview_scenarios_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_scenarios" ADD CONSTRAINT "interview_scenarios_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_scenarios" ADD CONSTRAINT "interview_scenarios_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_interview_scenarios_tenant" ON "interview_scenarios" USING btree ("tenant_id","status");--> statement-breakpoint
-- Опубликованный сценарий — один на тест: правка опубликованного — новая версия (`30` §12 п. 9)
CREATE UNIQUE INDEX "uq_interview_scenarios_published" ON "interview_scenarios" USING btree ("tenant_id","quiz_id") WHERE status = 'published';--> statement-breakpoint
ALTER TABLE interview_scenarios ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE interview_scenarios FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON interview_scenarios
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 4. Критерии (`30` §3.3, форма §6.2) ─────────────────────────────────────────────────
CREATE TABLE "interview_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_uk" text NOT NULL,
	"description" text NOT NULL,
	"weight" numeric(5, 2) DEFAULT '1' NOT NULL,
	"scale_max" numeric(5, 2) DEFAULT '5' NOT NULL,
	"is_critical" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	CONSTRAINT "uq_interview_criteria_code" UNIQUE("tenant_id","scenario_id","code"),
	CONSTRAINT "interview_criteria_source_chk" CHECK ("source" in ('manual', 'ai_suggested')),
	-- `30` §3.3: определение, которое получает модель и читает человек рядом с баллом
	CONSTRAINT "interview_criteria_desc_chk" CHECK (char_length("description") between 20 and 500),
	CONSTRAINT "interview_criteria_name_chk" CHECK (char_length("name_uk") between 3 and 100),
	CONSTRAINT "interview_criteria_weight_chk" CHECK ("weight" > 0 and "scale_max" between 2 and 100)
);
--> statement-breakpoint
ALTER TABLE "interview_criteria" ADD CONSTRAINT "interview_criteria_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_criteria" ADD CONSTRAINT "interview_criteria_scenario_id_interview_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."interview_scenarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_interview_criteria_tenant" ON "interview_criteria" USING btree ("tenant_id","scenario_id","sort");--> statement-breakpoint
ALTER TABLE interview_criteria ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE interview_criteria FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON interview_criteria
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 5. Согласие на запись (`30` §3.3, §7.4–§7.6) ────────────────────────────────────────
CREATE TABLE "interview_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"scopes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"text_version" text NOT NULL,
	"text_hash" text NOT NULL,
	"lang" text DEFAULT 'uk' NOT NULL,
	"alternative_chosen" text,
	"ip" "inet",
	"user_agent" text,
	"request_context" jsonb,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "interview_consents_decision_chk" CHECK ("decision" in ('accepted', 'declined', 'withdrawn')),
	CONSTRAINT "interview_consents_alt_chk" CHECK ("alternative_chosen" is null or "alternative_chosen" in ('human_interview', 'text_form')),
	-- `30` §7.5: отказ не закрывает отбор — у отказа всегда названа альтернатива
	CONSTRAINT "interview_consents_declined_alt_chk" CHECK ("decision" <> 'declined' or "alternative_chosen" is not null),
	CONSTRAINT "interview_consents_withdrawn_chk" CHECK (("decision" = 'withdrawn') = ("withdrawn_at" is not null)),
	CONSTRAINT "interview_consents_hash_chk" CHECK ("text_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "interview_consents" ADD CONSTRAINT "interview_consents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_consents" ADD CONSTRAINT "interview_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_consents" ADD CONSTRAINT "interview_consents_scenario_id_interview_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."interview_scenarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_interview_consents_tenant" ON "interview_consents" USING btree ("tenant_id","user_id","decided_at" DESC);--> statement-breakpoint
ALTER TABLE interview_consents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE interview_consents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON interview_consents
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 6. Сессия поверх попытки (`30` §3.4, §4) ────────────────────────────────────────────
CREATE TABLE "interview_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"consent_id" uuid,
	"state" text DEFAULT 'created' NOT NULL,
	"answer_mode" text,
	"turns_total" integer DEFAULT 0 NOT NULL,
	"turns_answered" integer DEFAULT 0 NOT NULL,
	"disconnects" integer DEFAULT 0 NOT NULL,
	"resumes" integer DEFAULT 0 NOT NULL,
	"silence_events" integer DEFAULT 0 NOT NULL,
	"tab_switches" integer DEFAULT 0 NOT NULL,
	"device" text,
	"ip" "inet",
	"user_agent" text,
	"ip_changes" integer DEFAULT 0 NOT NULL,
	"ai_score" numeric(6, 2),
	"ai_confidence" numeric(4, 3),
	"ai_verdict_text" text,
	"ai_stub" boolean DEFAULT false NOT NULL,
	"candidate_score_id" uuid,
	"degraded_reason" text,
	"needs_human_reason" text,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"purge_after" timestamp with time zone,
	"started_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "uq_interview_sessions_attempt" UNIQUE("tenant_id","attempt_id"),
	CONSTRAINT "interview_sessions_state_chk" CHECK ("state" in ('created', 'consent_pending', 'in_progress', 'paused', 'submitted', 'transcribing', 'scoring', 'scored', 'needs_human', 'abandoned', 'expired', 'failed')),
	CONSTRAINT "interview_sessions_degr_chk" CHECK ("degraded_reason" is null or "degraded_reason" in ('provider_down', 'limit_exhausted', 'transcribe_failed', 'low_confidence', 'consent_withdrawn', 'timeout', 'unexplained')),
	CONSTRAINT "interview_sessions_mode_chk" CHECK ("answer_mode" is null or "answer_mode" in ('voice', 'text')),
	CONSTRAINT "interview_sessions_score_chk" CHECK (("ai_score" is null or "ai_score" between 0 and 100) and ("ai_confidence" is null or "ai_confidence" between 0 and 1)),
	CONSTRAINT "interview_sessions_flags_chk" CHECK (jsonb_typeof("flags") = 'array')
);
--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_scenario_id_interview_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."interview_scenarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_consent_id_interview_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."interview_consents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_candidate_score_id_candidate_scores_id_fk" FOREIGN KEY ("candidate_score_id") REFERENCES "public"."candidate_scores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_interview_sessions_tenant" ON "interview_sessions" USING btree ("tenant_id","state","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_interview_sessions_tenant_cand" ON "interview_sessions" USING btree ("tenant_id","candidate_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_interview_sessions_tenant_purge" ON "interview_sessions" USING btree ("tenant_id","purge_after") WHERE purge_after is not null;--> statement-breakpoint
ALTER TABLE interview_sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE interview_sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON interview_sessions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 7. Реплики (`30` §3.4) ──────────────────────────────────────────────────────────────
CREATE TABLE "interview_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"attempt_answer_id" uuid,
	"ordinal" integer NOT NULL,
	"role" text NOT NULL,
	"question_id" uuid,
	"question_version" integer,
	"prompt_text" text,
	"answer_mode" text,
	"media_id" uuid,
	"duration_ms" integer,
	"silence_ms" integer,
	"retakes" integer DEFAULT 0 NOT NULL,
	"first_sound_delay_ms" integer,
	"transcript" text,
	"transcript_lang" text,
	"transcript_confidence" numeric(4, 3),
	"transcript_engine" text,
	"transcript_version" integer DEFAULT 1 NOT NULL,
	"transcript_status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "uq_interview_turns_ordinal" UNIQUE("tenant_id","session_id","ordinal"),
	CONSTRAINT "interview_turns_role_chk" CHECK ("role" in ('interviewer', 'candidate')),
	CONSTRAINT "interview_turns_mode_chk" CHECK ("answer_mode" is null or "answer_mode" in ('voice', 'text', 'none')),
	CONSTRAINT "interview_turns_tr_chk" CHECK ("transcript_status" in ('pending', 'ok', 'low_confidence', 'failed', 'skipped', 'manual', 'not_needed')),
	CONSTRAINT "interview_turns_ordinal_chk" CHECK ("ordinal" >= 1 and "retakes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "interview_turns" ADD CONSTRAINT "interview_turns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_turns" ADD CONSTRAINT "interview_turns_session_id_interview_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_turns" ADD CONSTRAINT "interview_turns_attempt_answer_id_attempt_answers_id_fk" FOREIGN KEY ("attempt_answer_id") REFERENCES "public"."attempt_answers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_turns" ADD CONSTRAINT "interview_turns_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_interview_turns_tenant_media" ON "interview_turns" USING btree ("tenant_id","media_id") WHERE media_id is not null;--> statement-breakpoint
ALTER TABLE interview_turns ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE interview_turns FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON interview_turns
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 8. Оценка ИИ по критерию (`30` §3.5, §7.2) ──────────────────────────────────────────
CREATE TABLE "interview_criterion_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"value" numeric(5, 2),
	"confidence" numeric(4, 3) NOT NULL,
	"rationale" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_call_id" bigint,
	"human_value" numeric(5, 2),
	"human_by" uuid,
	"human_at" timestamp with time zone,
	"human_comment" text,
	"agreement" text DEFAULT 'pending' NOT NULL,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "uq_interview_criterion_scores" UNIQUE("tenant_id","session_id","criterion_id"),
	CONSTRAINT "ics_agreement_chk" CHECK ("agreement" in ('pending', 'match', 'minor', 'major')),
	CONSTRAINT "ics_confidence_chk" CHECK ("confidence" between 0 and 1),
	-- `30` §3.5, §7.2: балл без обоснования или без цитаты физически не сохраняется
	CONSTRAINT "ics_rationale_chk" CHECK ("redacted_at" is not null or ("rationale" is not null and char_length("rationale") between 20 and 2000)),
	CONSTRAINT "ics_evidence_chk" CHECK ("redacted_at" is not null or (jsonb_typeof("evidence") = 'array' and jsonb_array_length("evidence") >= 1)),
	CONSTRAINT "ics_evidence_quote_chk" CHECK ("redacted_at" is not null or not jsonb_path_exists("evidence", '$[*] ? (!exists(@.quote) || @.quote == "")')),
	-- `30` §7.9: стёртая строка — без обоснования и без цитат, а не с остатками
	CONSTRAINT "ics_redacted_chk" CHECK ("redacted_at" is null or ("rationale" is null and "evidence" = '[]'::jsonb))
);
--> statement-breakpoint
ALTER TABLE "interview_criterion_scores" ADD CONSTRAINT "interview_criterion_scores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_criterion_scores" ADD CONSTRAINT "interview_criterion_scores_session_id_interview_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."interview_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_criterion_scores" ADD CONSTRAINT "interview_criterion_scores_criterion_id_interview_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."interview_criteria"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_criterion_scores" ADD CONSTRAINT "interview_criterion_scores_ai_call_id_ai_calls_id_fk" FOREIGN KEY ("ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_criterion_scores" ADD CONSTRAINT "interview_criterion_scores_human_by_users_id_fk" FOREIGN KEY ("human_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_interview_criterion_scores_tenant_agr" ON "interview_criterion_scores" USING btree ("tenant_id","agreement") WHERE agreement <> 'pending';--> statement-breakpoint
ALTER TABLE interview_criterion_scores ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE interview_criterion_scores FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON interview_criterion_scores
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- Стёртую строку можно получить только стиранием живой: вставка с `redacted_at` — это оценка
-- без объяснения под видом стёртой, её не пропускает ни один путь записи (`30` §3.5)
CREATE OR REPLACE FUNCTION interview_criterion_scores_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.redacted_at IS NOT NULL THEN
    RAISE EXCEPTION 'interview_criterion_scores: стёртую оценку нельзя вставить, только получить стиранием'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ics_insert_guard';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER ics_insert_guard BEFORE INSERT ON interview_criterion_scores
  FOR EACH ROW EXECUTE FUNCTION interview_criterion_scores_insert_guard();
