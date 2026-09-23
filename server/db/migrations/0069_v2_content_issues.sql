-- docs/v2/45-plan.md PR-23 · docs/v2/36-content-feedback.md §3.2 (DDL), §7.2 (склейка),
-- §7.7 (жалоба во время попытки), §7.10 (частота), §7.11 (поток пустых жалоб) ·
-- docs/v2/39-patches.md П-12.1 (тип «Лінійна шкала») · docs/v2/40-data-model-delta.md §4
-- (реестр origin) · docs/v2/44-decisions.md В-6 (единая редакция перечня origin).
--
-- Жалоба на материал — «минимум трения для заявителя, максимум контекста для автора»
-- (`36` §1). Поэтому таблиц две с половиной, а не одна: `content_issues` — **дефект**
-- (один на материал+тип+версию, сколько бы людей ни пожаловалось), `content_reports` —
-- **обращение** конкретного человека, `content_issue_events` — журнал карточки,
-- `content_reporter_stats` — репутация заявителя. Склейка живёт не в коде, а в уникальном
-- индексе по `dedupe_key`: сорок жалоб на одно битое видео за десять минут обязаны дать
-- одну карточку с `reports_count = 40`, а не сорок строк в очереди автора (`36` §12).
--
-- ── Что здесь есть сверх плана и почему ────────────────────────────────────────────────
-- `content_issue_events` план относит к PR-24 («Разбор жалобы»), но критерий приёмки 2
-- (`36` §13) закреплён за PR-23 и требует дословно: «в журнале событие `merged`». Событие
-- склейки рождается в момент подачи, а не разбора; §7.7 (б) тем же журналом фиксирует факт
-- компенсации времени попытки. Таблица без журнала означала бы, что PR-23 закрывает свой
-- критерий «на словах». `[решение]` Журнал заводится здесь; PR-24 добавляет к нему
-- `content_issue_routing_rules` и переходы статусов.
--
-- `content_issue_routing_rules` здесь НЕ создаётся: маршрутизация (`36` §7.5) — предмет
-- PR-24 целиком, а её отсутствие подачу жалобы не ломает (ответственный проставляется
-- разбором, `assignee_id` остаётся null).

-- ── 1. Реестр `media_assets.origin`: шестнадцатое значение (`40` §4, правило 19) ────────
-- Скриншот к жалобе — обычный файл хранилища, а не вложение с собственной жизнью:
-- он считается в квоту тенанта, чистится общей уборкой медиа и обязан иметь свой `origin`,
-- иначе попадёт в `other` и разбивка хранилища соврёт (`34` §3.2). Значения `issue_screenshot`
-- в перечне `40` §4.1 не было — пакет собрал реестр из трёх документов (`34`, `30`, `38`)
-- и `36` §3.2 в сводку не попал, хотя ссылку на `media_assets` в DDL имеет. Расхождение
-- закрыто правкой `40` §4 (пометка «исправлено»), а не обходом реестра.
--
-- Правило 19 требует ровно этого: перечень меняется **через `40` §4** и **одной миграцией**,
-- целиком пересоздающей констрейнт. Двух независимых `check` по `origin` не бывает — они
-- дают неразрешимую ошибку вставки (`38` §3.2, Р-1 в `40` §9).
ALTER TABLE "media_assets" DROP CONSTRAINT IF EXISTS "media_assets_origin_chk";--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_origin_chk" CHECK ("origin" IN (
	'content_cover',
	'lesson_attachment',
	'workshop_submission',
	'video_answer',
	'candidate_cv',
	'certificate',
	'import',
	'checklist_photo',
	'avatar',
	'brand_asset',
	'ai_artifact',
	'report_export',
	'interview_answer',
	'person_document',
	'issue_screenshot',
	'other'
));--> statement-breakpoint
COMMENT ON COLUMN "media_assets"."origin" IS 'Происхождение файла, 16 значений docs/v2/40 §4.2 (shared/enums.ts MEDIA_ORIGINS). Задаётся при выдаче presigned URL, не вычисляется потом.';--> statement-breakpoint

-- ── 2. Восьмой тип вопроса: «Лінійна шкала» (П-12.1) ────────────────────────────────────
-- Числовой диапазон с настраиваемыми границами и подписями концов, снято со второго
-- эталона. Констрейнт пересоздаётся целиком — как это уже делала 0055 для `cloze`.
ALTER TABLE "questions" DROP CONSTRAINT IF EXISTS "questions_kind_check";--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_kind_check" CHECK ("kind" IN (
	'single', 'multi', 'free', 'ordering', 'classification', 'comparison', 'answer_by_map',
	'number', 'text_short', 'file', 'cloze', 'scale'));--> statement-breakpoint

-- ── 3. Карточка дефекта (`36` §3.2) ─────────────────────────────────────────────────────
-- Правил прохождения здесь нет (CLAUDE.md п. 11): `due_at` — срок починки по SLA автора
-- (`36` §7.6), а не срок прохождения материала, и таблица в списке контента
-- `tests/integration/schema-parity.spec.ts` не числится и числиться не будет.
CREATE TABLE "content_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	-- text, а не uuid: идентификатор блока внутри `resources.body` — короткая строка
	-- редактора (`shared/schemas/content.ts` blockBase), а не uuid (`36` §3.1 исправлен)
	"block_id" text,
	"content_version" integer DEFAULT 1 NOT NULL,
	"issue_type" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"resolution" text,
	"resolution_comment" text,
	"reports_count" integer DEFAULT 1 NOT NULL,
	"first_reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assignee_id" uuid,
	"assigned_at" timestamp with time zone,
	"severity" text DEFAULT 'normal' NOT NULL,
	"affects_scoring" boolean DEFAULT false NOT NULL,
	"rescore_state" text DEFAULT 'none' NOT NULL,
	"rescored_attempts" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text NOT NULL,
	"course_ids" uuid[] DEFAULT '{}' NOT NULL,
	"due_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "content_issues_target_type_chk" CHECK ("target_type" IN ('resource', 'lesson', 'block', 'quiz', 'question', 'workshop', 'survey', 'knowledge_article', 'media')),
	CONSTRAINT "content_issues_issue_type_chk" CHECK ("issue_type" IN ('typo', 'wrong_fact', 'outdated', 'unclear', 'broken_media', 'broken_link', 'broken_file', 'bad_question', 'wrong_key', 'tech', 'other')),
	CONSTRAINT "content_issues_status_chk" CHECK ("status" IN ('new', 'in_progress', 'fixed', 'rejected', 'deferred', 'closed')),
	CONSTRAINT "content_issues_resolution_chk" CHECK ("resolution" IS NULL OR "resolution" IN ('fixed', 'question_fixed', 'question_void', 'not_an_error', 'duplicate', 'wont_fix', 'spam')),
	CONSTRAINT "content_issues_severity_chk" CHECK ("severity" IN ('blocking', 'normal', 'cosmetic')),
	CONSTRAINT "content_issues_rescore_state_chk" CHECK ("rescore_state" IN ('none', 'needed', 'in_progress', 'done', 'skipped')),
	CONSTRAINT "content_issues_content_version_chk" CHECK ("content_version" >= 1),
	CONSTRAINT "content_issues_reports_count_chk" CHECK ("reports_count" >= 1),
	CONSTRAINT "content_issues_title_chk" CHECK (char_length("title") BETWEEN 3 AND 200),
	CONSTRAINT "content_issues_resolution_comment_chk" CHECK ("resolution_comment" IS NULL OR char_length("resolution_comment") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "content_issues" ADD CONSTRAINT "content_issues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_issues" ADD CONSTRAINT "content_issues_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_content_issues_tenant" ON "content_issues" USING btree ("tenant_id");--> statement-breakpoint
-- Склейка дубликатов — индексом, а не проверкой в коде (`36` §7.2). Частичный по
-- `status <> 'closed'`: после закрытия карточки новая жалоба заводит **новую** карточку,
-- чтобы история «чинили трижды» не терялась (`36` §4). Полный индекс по `tenant_id` — выше.
CREATE UNIQUE INDEX "uq_content_issues_open_dedupe" ON "content_issues" USING btree ("tenant_id","dedupe_key") WHERE status <> 'closed';--> statement-breakpoint
CREATE INDEX "idx_content_issues_queue" ON "content_issues" USING btree ("tenant_id","status","last_reported_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_content_issues_target" ON "content_issues" USING btree ("tenant_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "idx_content_issues_rescore" ON "content_issues" USING btree ("tenant_id","rescore_state") WHERE rescore_state = 'needed';--> statement-breakpoint
ALTER TABLE content_issues ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE content_issues FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON content_issues
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 4. Обращение человека (`36` §3.2, §7.1) ─────────────────────────────────────────────
-- `context` собирается системой и не показывается формой: человек не описывает словами
-- то, что сервер и так знает (`36` §7.1). Технический контекст (ip, geo, user_agent)
-- кладётся туда же ключом `request_context` — правило 14 соблюдено без отдельной колонки,
-- потому что сам ТЗ-документ уже определил `context` как единственное место контекста
-- обращения; журналом с собственным `request_context` здесь является `content_issue_events`.
CREATE TABLE "content_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"comment" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"screenshot_media_id" uuid,
	"enrollment_id" uuid,
	"lesson_id" uuid,
	"attempt_id" uuid,
	"question_version" integer,
	"source" text DEFAULT 'lesson' NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "content_reports_source_chk" CHECK ("source" IN ('lesson', 'attempt', 'workshop', 'catalog', 'knowledge', 'review')),
	CONSTRAINT "content_reports_comment_chk" CHECK ("comment" IS NULL OR char_length("comment") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_issue_id_content_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."content_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_screenshot_media_id_media_assets_id_fk" FOREIGN KEY ("screenshot_media_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reports" ADD CONSTRAINT "content_reports_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_content_reports_tenant" ON "content_reports" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_content_reports_issue" ON "content_reports" USING btree ("tenant_id","issue_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_content_reports_attempt" ON "content_reports" USING btree ("tenant_id","attempt_id") WHERE attempt_id IS NOT NULL;--> statement-breakpoint
-- Один человек — один голос за карточку (`36` §7.2): повторная жалоба того же человека на
-- тот же ключ отвечает 409 и счётчик не растёт.
CREATE UNIQUE INDEX "uq_content_reports_once" ON "content_reports" USING btree ("tenant_id","issue_id","user_id");--> statement-breakpoint
-- Суточный и месячный лимиты (`36` §7.10) считаются по одному человеку за окно — индекс
-- под этот счёт, полный по `tenant_id` уже есть выше.
CREATE INDEX "idx_content_reports_user_created" ON "content_reports" USING btree ("tenant_id","user_id","created_at" DESC);--> statement-breakpoint
ALTER TABLE content_reports ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE content_reports FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON content_reports
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 5. Журнал карточки (`36` §3, §7.7 б) ────────────────────────────────────────────────
-- `is_internal` — заметка, заявителю не видная. `request_context` — по правилу 14
-- (CLAUDE.md): все журналы пишут технический контекст одинаково, тем же решением, что
-- `usage_events` (PR-09) и `candidate_status_history` (PR-13); в DDL документа колонки нет,
-- правило сильнее краткости документа.
CREATE TABLE "content_issue_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"actor_id" uuid,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"comment" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"request_context" jsonb,
	CONSTRAINT "content_issue_events_kind_chk" CHECK ("kind" IN ('created', 'merged', 'status_changed', 'assigned', 'commented', 'rescored', 'reopened')),
	CONSTRAINT "content_issue_events_comment_chk" CHECK ("comment" IS NULL OR char_length("comment") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "content_issue_events" ADD CONSTRAINT "content_issue_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_issue_events" ADD CONSTRAINT "content_issue_events_issue_id_content_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."content_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_issue_events" ADD CONSTRAINT "content_issue_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_content_issue_events_tenant" ON "content_issue_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_content_issue_events_issue" ON "content_issue_events" USING btree ("tenant_id","issue_id","created_at");--> statement-breakpoint
ALTER TABLE content_issue_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE content_issue_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON content_issue_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 6. Репутация заявителя (`36` §3.2, §7.11) ───────────────────────────────────────────
-- Строка на человека, а не журнал: счётчики и `muted_until` читаются формой жалобы на
-- каждой подаче, и лишний агрегат по `content_reports` в этом месте стоил бы дороже.
CREATE TABLE "content_reporter_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reports_total" integer DEFAULT 0 NOT NULL,
	"confirmed_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"spam_count" integer DEFAULT 0 NOT NULL,
	"consecutive_spam" integer DEFAULT 0 NOT NULL,
	"muted_until" timestamp with time zone,
	"muted_by" uuid,
	"mute_reason" text,
	"last_report_at" timestamp with time zone,
	CONSTRAINT "content_reporter_stats_tenant_id_user_id_unique" UNIQUE("tenant_id","user_id"),
	CONSTRAINT "content_reporter_stats_mute_reason_chk" CHECK ("mute_reason" IS NULL OR char_length("mute_reason") <= 300)
);
--> statement-breakpoint
ALTER TABLE "content_reporter_stats" ADD CONSTRAINT "content_reporter_stats_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reporter_stats" ADD CONSTRAINT "content_reporter_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_reporter_stats" ADD CONSTRAINT "content_reporter_stats_muted_by_users_id_fk" FOREIGN KEY ("muted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_content_reporter_stats_tenant" ON "content_reporter_stats" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE content_reporter_stats ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE content_reporter_stats FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON content_reporter_stats
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

COMMENT ON COLUMN "content_issues"."dedupe_key" IS 'target_type:target_id:block_id|-:issue_type:content_version (docs/v2/36 §7.2). Уникален среди незакрытых карточек тенанта.';--> statement-breakpoint
COMMENT ON COLUMN "content_issues"."due_at" IS 'Срок починки по SLA автора (docs/v2/36 §7.6): 2 рабочих дня blocking, 7 normal, 30 cosmetic. К правилам прохождения материала отношения не имеет.';--> statement-breakpoint
COMMENT ON COLUMN "content_reports"."context" IS 'Контекст обращения, собранный системой (docs/v2/36 §7.1): урок, версия, попытка, позиция плеера, плюс request_context сервера.';
--> statement-breakpoint

-- ── 7. Скоупы модуля уже заведённым тенантам (`36` §2) ──────────────────────────────────
-- Кнопка «Повідомити про помилку» есть у всех ролей (`36` §2, строка «Подать жалобу из
-- экрана прохождения»), поэтому догоняющая выдача `content_issue.report` — всем системным
-- ролям; очередь и разбор (`view`, `triage`, `assign`, `rescore`, `mute`) остаются у
-- администратора и приходят к остальным вместе с PR-24. Новые тенанты получают набор из
-- SYSTEM_ROLES (`shared/domain/roles.ts`), здесь — догоняющая вставка тем же составом.
UPDATE roles SET scopes = array_cat(scopes, ARRAY['content_issue.report'])
	WHERE is_system AND code IN ('employee', 'mentor', 'manager', 'author') AND NOT scopes @> ARRAY['content_issue.report'];--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['content_issue.view'])
	WHERE is_system AND code = 'author' AND NOT scopes @> ARRAY['content_issue.view'];--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['content_issue.report', 'content_issue.view', 'content_issue.triage', 'content_issue.assign', 'content_issue.rescore', 'content_issue.mute'])
	WHERE is_system AND code = 'admin' AND NOT scopes @> ARRAY['content_issue.report'];
