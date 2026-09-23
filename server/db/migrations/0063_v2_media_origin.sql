-- docs/v2/45-plan.md PR-12 · docs/v2/40-data-model-delta.md §4.2 (перечень origin) и §3.3 ·
-- docs/v2/34-storage.md §3.2, §4, §7.1 · docs/v2/44-decisions.md В-6 (редакция перечня),
-- В-10 (ключи разбивки хранилища), В-17 (мягкое удаление)
--
-- Одна миграция на весь перечень `origin` — это инвариант пакета, а не стиль оформления.
-- Три документа описывают перечень по-разному: `34` §3.2 — 13 значений, `30` §3.7 патчем
-- добавляет `interview_answer`, `38` §3.2 **пересоздаёт констрейнт целиком** и значения из
-- `30` в его версии нет. Если исполнить их по очереди, `interview_answer` молча исчезнет и
-- запись авто-собеседования станет невставляемой (Р-1 в `40` §9). Поэтому констрейнт
-- собирается один раз, в редакции `40` §4.2, и по колонке `origin` его ровно один —
-- два независимых `check` по одной колонке дают неразрешимую ошибку вставки.
-- Обе стороны сверяет контрактный тест `tests/integration/v2-contract-04-media-origin.spec.ts`,
-- который с этой миграции становится содержательным.
--
-- Ось разбивки — `stage_code`, а не `category_id` (В-10). Категория трека — свойство *курса*,
-- а не *файла*: на эталоне разбивка по ней даёт 90 % в «Інше». Коды этапов — платформенный
-- перечень (`33` §3.2, `shared/enums.ts` LIFECYCLE_STAGE_CODES), поэтому девять ключей
-- (восемь этапов + `other`) сравнимы между тенантами и во времени; свободный справочник
-- `course_categories` такого не даёт. Фильтр «Категорія» на экране `/storage` остаётся и
-- работает join-ом `course_id → courses.category_id` — разовому запросу join по карману.

-- ── 1. Классификация файла (`34` §3.2, `40` §3.3) ───────────────────────────────────────
-- `origin` обязателен и задаётся клиентом при выдаче presigned URL, а не вычисляется потом
-- (`34` §7.1); единственный вход загрузки — `POST /media/upload-url` (В-17), он отвечает
-- `400 origin_required` без него. Умолчание `'other'` существует только ради уже
-- загруженных файлов: классификация задним числом — задача `storage.classify_backfill`
-- (`34` §11, PR-36).
ALTER TABLE "media_assets" ADD COLUMN "origin" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "course_id" uuid;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "stage_code" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "enrollment_id" uuid;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "source_entity" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "source_id" uuid;--> statement-breakpoint

-- ── 2. Положение в хранилище и доказательства (`34` §3.1, §4, §7.1) ─────────────────────
-- `status` и `lifecycle` — разные оси: `status` (uploading | processing | ready | failed) —
-- техническая готовность объекта, `lifecycle` — положение в хранилище. Файл бывает
-- `status='ready'` и `lifecycle='orphaned'` одновременно (`34` §3.1).
ALTER TABLE "media_assets" ADD COLUMN "lifecycle" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "is_evidence" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "retention_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "orphaned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "last_accessed_at" timestamp with time zone;--> statement-breakpoint

-- Внешние ключи — `on delete set null`: удаление курса или записи на курс не уносит файл
-- и не блокируется им (`34` §3.2). `source_entity`/`source_id` — мягкая полиморфная ссылка
-- без FK (решение В-11): целевые таблицы разные, а проверка целостности живёт в коде.
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_course_id_courses_id_fk"
  FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_enrollment_id_enrollments_id_fk"
  FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint

-- ── 3. Перечень origin — 15 значений, ровно один check (В-6, `40` §4.2) ─────────────────
-- Порядок и состав — дословно `40` §4.2. Значение добавляется только правкой `40` §4
-- и новой миграцией: перечень зарегистрирован ещё в `shared/enums.ts` (MEDIA_ORIGINS) и в
-- `docs/02-data-model.md` «Перечисления, снятые с эталона», расхождение любой из трёх копий
-- валит CI (schema-parity + контрактный тест №4). `drop constraint if exists` — не
-- перестраховка, а то самое «констрейнт всегда один и всегда пересоздаётся целиком».
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
	'other'
));--> statement-breakpoint

-- Состояния файла (`34` §4): active → orphaned → pending_delete → purged; `purged`
-- терминально, строка `media_assets` не удаляется никогда — на неё ссылаются `audit_log`
-- и `workshop_submissions.files`.
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_lifecycle_chk" CHECK ("lifecycle" IN (
	'active', 'orphaned', 'pending_delete', 'purged'));--> statement-breakpoint

-- Корзина без даты возврата — не корзина: в `pending_delete` обязаны стоять обе даты
-- (`34` §3.2 дословно).
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_purge_chk" CHECK (
	"lifecycle" <> 'pending_delete' OR ("deleted_at" IS NOT NULL AND "purge_after" IS NOT NULL));--> statement-breakpoint

-- Ключи разбивки хранилища (В-10): восемь кодов этапов + `other` = девять. Перечень
-- платформенный (`33` §3.2), поэтому повторён здесь так же, как в `lifecycle_stages_code_check`:
-- `stage_code` — денормализованный снимок `courses.lifecycle_stage_id → code` на момент
-- создания файла, он не пересчитывается при смене этапа у курса и ссылкой на тенантную
-- `lifecycle_stages` быть не может — разбивка обязана быть стабильной во времени.
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_stage_code_chk" CHECK (
	"stage_code" IS NULL OR "stage_code" IN (
	'recruiting', 'onboarding', 'integration', 'training',
	'attestation', 'psychological', 'knowledge', 'offboarding'));--> statement-breakpoint

-- ── 4. Индексы `34` §3.2 ────────────────────────────────────────────────────────────────
-- Два индекса по переименованным колонкам поставила 0062; остальные — здесь, по колонкам,
-- которых до этой миграции не было.
CREATE INDEX "idx_media_assets_tenant" ON "media_assets" USING btree ("tenant_id","lifecycle","origin");--> statement-breakpoint
CREATE INDEX "idx_media_assets_tenant_created" ON "media_assets" USING btree ("tenant_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_media_assets_tenant_course" ON "media_assets" USING btree ("tenant_id","course_id");--> statement-breakpoint
CREATE INDEX "idx_media_assets_tenant_stage" ON "media_assets" USING btree ("tenant_id","stage_code");--> statement-breakpoint
CREATE INDEX "idx_media_assets_tenant_retention" ON "media_assets" USING btree ("tenant_id","retention_until") WHERE "lifecycle" = 'active';--> statement-breakpoint
CREATE INDEX "idx_media_assets_tenant_purge" ON "media_assets" USING btree ("tenant_id","purge_after") WHERE "lifecycle" = 'pending_delete';--> statement-breakpoint

COMMENT ON COLUMN "media_assets"."origin" IS 'Происхождение файла, 15 значений docs/v2/40 §4.2 (shared/enums.ts MEDIA_ORIGINS). Задаётся при выдаче presigned URL, не вычисляется потом.';--> statement-breakpoint
COMMENT ON COLUMN "media_assets"."stage_code" IS 'Ключ разбивки хранилища = код этапа жизненного цикла (docs/v2/44 В-10). Снимок на момент создания файла, при смене этапа у курса не пересчитывается.';--> statement-breakpoint
COMMENT ON COLUMN "media_assets"."is_evidence" IS 'Файл, на который опирается кадровое решение (docs/v2/34 §7.1): удаление — только с подтверждением, скачивание пишется в audit_log (В-19).';
