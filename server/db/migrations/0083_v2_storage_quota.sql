-- docs/v2/45-plan.md PR-36 · docs/v2/34-storage.md §3.3, §4, §7.2–§7.5, §11, §13 (к. 1, 3, 4, 7) ·
-- docs/v2/44-decisions.md В-10 (ключи разбивки = коды этапов), В-17 (единственный вход загрузки),
-- §8 (срок корзины живёт строкой политики; purge не удаляет объект в S3) · docs/v2/40 Р-6
--
-- Пять таблиц хранилища: агрегаты (`storage_usage_counters`, `storage_usage_daily`), правила
-- (`storage_retention_policies`) и операционные (`storage_deletion_requests`,
-- `storage_pending_uploads`). Реестр файлов остаётся один — `media_assets` (`34` §3.1).
--
-- Отдельной таблицы докупленного объёма нет и не появляется (Р-6, сквозная проверка 23
-- `42` §5): эффективную квоту считает только `effectiveLimits()` из
-- `server/services/tenantLimits.ts` — тариф + переопределение оператора + `tenant_addons`
-- с `storage_pack`. Здесь заводится только **факт** — сколько байт занято, — а не лимит.
--
-- Отступления от DDL `34` §3.3 (каждое записано пометкой `[исправлено]` в самом документе):
--   * `category_id → course_categories` заменён на `stage_code` (решение В-10): ключ разбивки —
--     код этапа, восемь кодов + девятый `other` (= null), тот же, что у `media_assets.stage_code`;
--   * `storage_retention_policies.trash_days` — срок корзины (`44` §8: «30 дней живут строкой
--     storage_retention_policies, а не константой в коде»);
--   * `storage_deletion_requests.reason` — причина массового удаления (форма `34` §6.1 её
--     требует, а DDL хранил только фразу подтверждения);
--   * `storage_pending_uploads.media_id` — связь отложенной загрузки с файлом, который под неё
--     заведён при появлении места: без неё подтверждение загрузки не находит, чью сдачу закрыть;
--   * FK на `users` у `requested_by` / `updated_by` — `on delete set null`, а не блокирующий:
--     стирание персональных данных человека (`34` §7.6 п. 2) не должно упираться в его заявки.
--
-- `origin` в новых таблицах **не** закрыт check-ом: перечень один, на `media_assets.origin`
-- (инвариант 19, решение В-6, контрактный тест №4). Счётчики получают значение только из
-- `media_assets` триггером, политики — через zod-схему по `MEDIA_ORIGINS`.

-- ── 0. Домиграционные строки: мягко удалённое не считается в квоту ──────────────────────
-- До PR-11 `deleted_at` никто не выставлял (`44` В-17), но если такая строка есть, она
-- обязана быть в корзине, а не `active`: иначе триггер ниже засчитал бы её в квоту.
UPDATE "media_assets"
   SET "lifecycle" = 'pending_delete',
       "purge_after" = coalesce("purge_after", "deleted_at" + interval '30 days')
 WHERE "deleted_at" IS NOT NULL AND "lifecycle" IN ('active', 'orphaned');--> statement-breakpoint

-- ── 0б. storage.classify_backfill (`34` §7.1, §11) — однократно при миграции ──────────────
-- С PR-12 `origin` задаётся на единственном входе загрузки; файлы, загруженные до него,
-- лежат с умолчанием `other` — ровно та болезнь эталона, где «Інше» — 90 % объёма.
-- Происхождение выводится обратным поиском по ссылкам: кто на файл ссылается, тот и
-- определяет, что это за файл. Ссылки в продукте двух видов — id файла (uuid или текст)
-- и ключ объекта в S3, — поэтому сверяются оба. Если файл найден в нескольких местах,
-- побеждает ссылка с меньшим приоритетом (работа человека важнее обложки). Что не нашлось —
-- остаётся `other` и видно на экране строкой «Не вдалося класифікувати: {n} файлів».
-- Функция, а не разовый запрос: её можно повторить (оператором или тестом), а вызов под ролью
-- приложения классифицирует только файлы своего тенанта — RLS действует на все таблицы ссылок.
CREATE OR REPLACE FUNCTION storage_classify_backfill() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  WITH refs ("ref", "origin", "prio") AS (
      -- работа сотрудника: сдачи практикумов (`workshop_submissions.files[].mediaId`)
      SELECT r #>> '{}', 'workshop_submission', 1 FROM "workshop_submissions" s, jsonb_path_query(s."files", 'lax $[*].mediaId') r
      UNION ALL
      -- фото и подпись прогона чек-листа
      SELECT r #>> '{}', 'checklist_photo', 2 FROM "checklist_runs" c, jsonb_path_query(c."answers", 'lax $[*].photoMediaIds[*]') r
      UNION ALL
      SELECT "signature_media_id"::text, 'checklist_photo', 2 FROM "checklist_runs" WHERE "signature_media_id" IS NOT NULL
      UNION ALL
      -- скриншот к жалобе на материал
      SELECT "screenshot_media_id"::text, 'issue_screenshot', 2 FROM "content_reports" WHERE "screenshot_media_id" IS NOT NULL
      UNION ALL
      -- вложения контента: файл и блоки ресурса (рабочая редакция и опубликованные снимки),
      -- вложения объявлений и статей базы знаний, инструкция практикума
      SELECT "media_id"::text, 'lesson_attachment', 3 FROM "resources" WHERE "media_id" IS NOT NULL
      UNION ALL
      SELECT r #>> '{}', 'lesson_attachment', 3 FROM "resources" x, jsonb_path_query(x."body", 'lax $[*].mediaId') r
      UNION ALL
      SELECT "media_id"::text, 'lesson_attachment', 3 FROM "resource_versions" WHERE "media_id" IS NOT NULL
      UNION ALL
      SELECT r #>> '{}', 'lesson_attachment', 3 FROM "resource_versions" x, jsonb_path_query(x."body", 'lax $[*].mediaId') r
      UNION ALL
      SELECT r #>> '{}', 'lesson_attachment', 3 FROM "notices" x, jsonb_path_query(x."attachments", 'lax $[*].mediaId') r
      UNION ALL
      SELECT r #>> '{}', 'lesson_attachment', 3 FROM "knowledge_articles" x, jsonb_path_query(x."attachments", 'lax $[*].mediaId') r
      UNION ALL
      SELECT unnest("instruction_media")::text, 'lesson_attachment', 3 FROM "workshops"
      UNION ALL
      -- обложки и иконки контента
      SELECT v, 'content_cover', 4 FROM "resources", unnest(ARRAY["cover_key", "card_image_key"]) v WHERE v IS NOT NULL
      UNION ALL
      SELECT v, 'content_cover', 4 FROM "courses", unnest(ARRAY["cover_key", "icon_key"]) v WHERE v IS NOT NULL
      UNION ALL
      SELECT v, 'content_cover', 4 FROM "programs", unnest(ARRAY["cover_key", "icon_key"]) v WHERE v IS NOT NULL
      UNION ALL
      SELECT "cover_key", 'content_cover', 4 FROM "news" WHERE "cover_key" IS NOT NULL
      UNION ALL
      SELECT "cover_key", 'content_cover', 4 FROM "quizzes" WHERE "cover_key" IS NOT NULL
      UNION ALL
      SELECT "cover_key", 'content_cover', 4 FROM "trajectories" WHERE "cover_key" IS NOT NULL
      UNION ALL
      SELECT "cover_key", 'content_cover', 4 FROM "meetups" WHERE "cover_key" IS NOT NULL
      UNION ALL
      -- аватар человека
      SELECT "avatar_key", 'avatar', 5 FROM "users" WHERE "avatar_key" IS NOT NULL
  ), best AS (
    SELECT DISTINCT ON ("ref") "ref", "origin" FROM refs WHERE "ref" IS NOT NULL ORDER BY "ref", "prio"
  )
  UPDATE "media_assets" m SET "origin" = best."origin", "updated_at" = now()
    FROM best
   WHERE m."origin" = 'other' AND (m."id"::text = best."ref" OR m."key" = best."ref");
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;--> statement-breakpoint
SELECT storage_classify_backfill();--> statement-breakpoint

-- ── 1. storage_usage_counters — оперативный счётчик (`34` §3.3, §7.4 п. 1) ───────────────
-- Экран и проверка квоты читают только его. Ключ — (тенант, происхождение, этап);
-- `unique nulls not distinct` обязателен: файлы вне курса (`stage_code is null`) должны
-- складываться в одну строку девятого ключа, а не в N неразличимых (Postgres 15+).
CREATE TABLE "storage_usage_counters" (
	"tenant_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"stage_code" text,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"files_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_usage_counters_pk" UNIQUE NULLS NOT DISTINCT ("tenant_id", "origin", "stage_code"),
	CONSTRAINT "storage_usage_counters_bytes_check" CHECK ("bytes" >= 0),
	CONSTRAINT "storage_usage_counters_files_count_check" CHECK ("files_count" >= 0),
	CONSTRAINT "storage_usage_counters_stage_code_chk" CHECK ("stage_code" IS NULL OR "stage_code" IN (
		'recruiting', 'onboarding', 'integration', 'training',
		'attestation', 'psychological', 'knowledge', 'offboarding'))
);--> statement-breakpoint
ALTER TABLE "storage_usage_counters" ADD CONSTRAINT "storage_usage_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_storage_usage_counters_tenant" ON "storage_usage_counters" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE storage_usage_counters ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE storage_usage_counters FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON storage_usage_counters
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 2. storage_usage_daily — суточный срез для биллинга и графика (`34` §3.3, §7.4 п. 2) ─
-- Пишет `storage.counter_reconcile` внутри `usage.collect`. `drift_bytes = counter − sum`:
-- дрейф означает путь записи мимо триггера, то есть дефект кода. Биллинг берёт максимум
-- срезов за период, а не значение на дату счёта (§7.4 п. 3).
CREATE TABLE "storage_usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"origin" text NOT NULL,
	"stage_code" text,
	"bytes" bigint NOT NULL,
	"files_count" integer NOT NULL,
	"counter_bytes" bigint,
	"drift_bytes" bigint DEFAULT 0 NOT NULL,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_usage_daily_uq" UNIQUE NULLS NOT DISTINCT ("tenant_id", "day", "origin", "stage_code"),
	CONSTRAINT "storage_usage_daily_stage_code_chk" CHECK ("stage_code" IS NULL OR "stage_code" IN (
		'recruiting', 'onboarding', 'integration', 'training',
		'attestation', 'psychological', 'knowledge', 'offboarding'))
);--> statement-breakpoint
ALTER TABLE "storage_usage_daily" ADD CONSTRAINT "storage_usage_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_storage_usage_daily_tenant" ON "storage_usage_daily" USING btree ("tenant_id", "day" DESC);--> statement-breakpoint
ALTER TABLE storage_usage_daily ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE storage_usage_daily FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON storage_usage_daily
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 3. storage_retention_policies — строка на происхождение (`34` §3.3, §6.2, §7.3) ───────
-- У нового тенанта выключено всё (§7.3): первое включение требует сухого прогона. Строки
-- заводит посев тенанта (`server/db/tenantDefaults.ts`), недостающие — сервис при первом
-- обращении, из той же константы: копии умолчаний в SQL нет.
-- `trash_days` — срок корзины. `44` §8: число дней — продуктовое решение, до ответа
-- владельца принято 30, и оно живёт здесь, а не константой в коде: владелец меняет без релиза.
CREATE TABLE "storage_retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"keep_months" integer,
	"anchor" text DEFAULT 'graded_at' NOT NULL,
	"action" text DEFAULT 'soft_delete' NOT NULL,
	"keep_evidence" boolean DEFAULT true NOT NULL,
	"warn_days_before" integer DEFAULT 14 NOT NULL,
	"max_batch_per_run" integer DEFAULT 500 NOT NULL,
	"trash_days" integer DEFAULT 30 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_retention_policies_tenant_id_origin_unique" UNIQUE ("tenant_id", "origin"),
	CONSTRAINT "storage_retention_policies_keep_months_check" CHECK ("keep_months" IS NULL OR "keep_months" BETWEEN 1 AND 120),
	CONSTRAINT "storage_retention_policies_anchor_check" CHECK ("anchor" IN ('created_at', 'graded_at', 'last_accessed_at')),
	CONSTRAINT "storage_retention_policies_action_check" CHECK ("action" IN ('soft_delete', 'purge', 'notify_only')),
	CONSTRAINT "storage_retention_policies_warn_days_check" CHECK ("warn_days_before" BETWEEN 0 AND 90),
	CONSTRAINT "storage_retention_policies_batch_check" CHECK ("max_batch_per_run" BETWEEN 1 AND 5000),
	CONSTRAINT "storage_retention_policies_trash_days_check" CHECK ("trash_days" BETWEEN 1 AND 365),
	-- Включённая политика с удалением обязана знать срок: «удалять через ∞» не бывает
	CONSTRAINT "storage_retention_policies_keep_required" CHECK (NOT "enabled" OR "action" = 'notify_only' OR "keep_months" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "storage_retention_policies" ADD CONSTRAINT "storage_retention_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_retention_policies" ADD CONSTRAINT "storage_retention_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_storage_retention_policies_tenant" ON "storage_retention_policies" USING btree ("tenant_id", "enabled");--> statement-breakpoint
ALTER TABLE storage_retention_policies ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE storage_retention_policies FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON storage_retention_policies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 4. storage_deletion_requests — массовое удаление только заявкой (`34` §3.3, §6.1, В-17) ─
-- Одна запись `storage.bulk_delete` в audit_log на заявку, пофайловый состав — здесь
-- (`media_ids`, `skipped`). Повтор после `failed` не переудаляет удалённое (§4).
CREATE TABLE "storage_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_by" uuid,
	"mode" text DEFAULT 'selection' NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"media_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"planned_files" integer DEFAULT 0 NOT NULL,
	"planned_bytes" bigint DEFAULT 0 NOT NULL,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"confirm_phrase" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_files" integer DEFAULT 0 NOT NULL,
	"deleted_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_deletion_requests_mode_check" CHECK ("mode" IN ('selection', 'filter', 'retention', 'orphan')),
	CONSTRAINT "storage_deletion_requests_status_check" CHECK ("status" IN ('draft', 'confirmed', 'running', 'done', 'cancelled', 'failed')),
	CONSTRAINT "storage_deletion_requests_reason_check" CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 10 AND 500)
);--> statement-breakpoint
ALTER TABLE "storage_deletion_requests" ADD CONSTRAINT "storage_deletion_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_deletion_requests" ADD CONSTRAINT "storage_deletion_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_storage_deletion_requests_tenant" ON "storage_deletion_requests" USING btree ("tenant_id", "status", "created_at" DESC);--> statement-breakpoint
ALTER TABLE storage_deletion_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE storage_deletion_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON storage_deletion_requests
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 5. storage_pending_uploads — работа, не поместившаяся в квоту (`34` §3.3, §7.5) ──────
-- Запись лежит на устройстве сотрудника (OPFS, иначе IndexedDB) под `client_ref`; строка
-- здесь — обещание дослать. `storage.pending_upload_retry` раз в 15 минут выдаёт место FIFO,
-- `media_id` — файл, заведённый под загрузку, когда место появилось.
CREATE TABLE "storage_pending_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"enrollment_id" uuid,
	"source_entity" text NOT NULL,
	"source_id" uuid,
	"origin" text NOT NULL,
	"declared_bytes" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"client_ref" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"last_error" text,
	"media_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_pending_uploads_tenant_id_user_id_client_ref_unique" UNIQUE ("tenant_id", "user_id", "client_ref"),
	CONSTRAINT "storage_pending_uploads_status_check" CHECK ("status" IN ('waiting', 'uploading', 'done', 'abandoned')),
	CONSTRAINT "storage_pending_uploads_declared_bytes_check" CHECK ("declared_bytes" > 0)
);--> statement-breakpoint
ALTER TABLE "storage_pending_uploads" ADD CONSTRAINT "storage_pending_uploads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_pending_uploads" ADD CONSTRAINT "storage_pending_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_pending_uploads" ADD CONSTRAINT "storage_pending_uploads_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_pending_uploads" ADD CONSTRAINT "storage_pending_uploads_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_storage_pending_uploads_tenant" ON "storage_pending_uploads" USING btree ("tenant_id", "status", "expires_at");--> statement-breakpoint
ALTER TABLE storage_pending_uploads ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE storage_pending_uploads FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON storage_pending_uploads
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 6. Триггер storage_counter_apply (`34` §7.4 п. 1) ────────────────────────────────────
-- В той же транзакции, что и изменение файла: `+bytes` при переходе в засчитываемое
-- положение (`active`, `orphaned`), `−bytes` при уходе из него, перенос между строками при
-- смене `origin`/`stage_code`. Триггер, а не код сервиса: путь записи в `media_assets` не
-- один (загрузка, обработка, мягкое удаление, восстановление, purge, прямые вставки посева
-- и тестов), и любой путь мимо счётчика — это дрейф, который ночной пересчёт поймает как
-- дефект. `greatest(0, …)` — счётчик никогда не роняет пользовательскую операцию, даже
-- если он уже разошёлся с фактом: выравнивает его пересчёт, а не отказ в удалении файла.
-- Функция SECURITY INVOKER: RLS действует как обычно — строка счётчика того же тенанта,
-- что и файл, под тем же `app.tenant_id`.
CREATE OR REPLACE FUNCTION storage_counter_apply() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.lifecycle IN ('active', 'orphaned') THEN
    UPDATE storage_usage_counters
       SET bytes = greatest(0, bytes - OLD.bytes),
           files_count = greatest(0, files_count - 1),
           updated_at = now()
     WHERE tenant_id = OLD.tenant_id
       AND origin = OLD.origin
       AND stage_code IS NOT DISTINCT FROM OLD.stage_code;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.lifecycle IN ('active', 'orphaned') THEN
    INSERT INTO storage_usage_counters AS c (tenant_id, origin, stage_code, bytes, files_count, updated_at)
    VALUES (NEW.tenant_id, NEW.origin, NEW.stage_code, NEW.bytes, 1, now())
    ON CONFLICT ON CONSTRAINT storage_usage_counters_pk
    DO UPDATE SET bytes = c.bytes + EXCLUDED.bytes,
                  files_count = c.files_count + 1,
                  updated_at = now();
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint

-- Счётчик заполняется из факта до того, как триггер начнёт его двигать; блокировка не даёт
-- вставке проскочить между пересчётом и появлением триггера (миграции идут одной транзакцией).
LOCK TABLE "media_assets" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
INSERT INTO "storage_usage_counters" ("tenant_id", "origin", "stage_code", "bytes", "files_count")
SELECT "tenant_id", "origin", "stage_code", sum("bytes")::bigint, count(*)::int
  FROM "media_assets"
 WHERE "lifecycle" IN ('active', 'orphaned')
 GROUP BY "tenant_id", "origin", "stage_code";--> statement-breakpoint

CREATE TRIGGER storage_counter_apply_ins_del
  AFTER INSERT OR DELETE ON "media_assets"
  FOR EACH ROW EXECUTE FUNCTION storage_counter_apply();--> statement-breakpoint
-- Обработка файла (`media.process`) обновляет статус и варианты десятки раз — счётчик
-- трогается только когда меняется то, что он считает.
CREATE TRIGGER storage_counter_apply_upd
  AFTER UPDATE OF "lifecycle", "bytes", "origin", "stage_code" ON "media_assets"
  FOR EACH ROW
  WHEN (OLD.lifecycle IS DISTINCT FROM NEW.lifecycle
     OR OLD.bytes IS DISTINCT FROM NEW.bytes
     OR OLD.origin IS DISTINCT FROM NEW.origin
     OR OLD.stage_code IS DISTINCT FROM NEW.stage_code)
  EXECUTE FUNCTION storage_counter_apply();--> statement-breakpoint

COMMENT ON TABLE "storage_usage_counters" IS 'Оперативный счётчик занятого места (docs/v2/34 §7.4 п. 1): ведёт триггер storage_counter_apply на media_assets. Засчитываются active и orphaned.';--> statement-breakpoint
COMMENT ON COLUMN "storage_usage_counters"."stage_code" IS 'Ключ разбивки = код этапа (docs/v2/44 В-10); null — девятый ключ other (файл вне курса).';--> statement-breakpoint
COMMENT ON COLUMN "storage_retention_policies"."trash_days" IS 'Срок корзины, дней (docs/v2/44 §8): предварительно 30, владелец продукта меняет строкой, без релиза.';--> statement-breakpoint
COMMENT ON COLUMN "storage_pending_uploads"."media_id" IS 'Файл, заведённый под отложенную загрузку, когда появилось место (docs/v2/34 §7.5 п. 3).';
