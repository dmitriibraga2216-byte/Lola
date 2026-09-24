-- docs/v2/45-plan.md PR-25 · docs/v2/31-module-library.md §3 (DDL), §4, §7 · docs/v2/39-patches.md
-- П-11 (`lessons.module_id` nullable) · docs/v2/40-data-model-delta.md §5 «цикл lessons ↔
-- library_modules» (порядок шагов) · docs/v2/44-decisions.md В-11 (снимки названий мягких ссылок).
--
-- Библиотека переиспользуемых модулей: модуль, созданный один раз, вставляется **ссылкой с
-- закреплённой версией** в несколько треков и курсов (Р-31.2). Третьей сущности контента нет
-- (Р-31.1): тело модуля — обычная запись `lessons`, у которой владелец не раздел курса, а
-- модуль. В репозитории у урока своего `body` нет — урок ссылается на материал (`docs/11`
-- §3.2), — поэтому черновик тела живёт в рабочей редакции `resources`, а версия — в
-- неизменяемом снимке `resource_versions`, на который указывает `lessons.resource_version_id`
-- урока-снимка. Один редактор, один санитайзер, один плеер урока (`31` §3.1 исправлен PR-25).
--
-- ── Отступления от DDL `31` §3.6 (каждое — с пометкой «исправлено» в документе) ─────────
-- 1. `search_tsv` ведёт триггер, а не `generated always as`: `array_to_string` в Postgres
--    STABLE, и выражение с ним генерируемой колонкой не принимается. Приём — как у
--    `resources` и `knowledge_articles` (0008).
-- 2. `content_kind` — перечень `resources.kind` без `scorm` (SCORM у материала — R3, Г-11.6):
--    тело модуля и есть материал, «свой перечень не заводим» (Р-31.5).
-- 3. `lessons.library_version_id` — `on delete set null`, а не `restrict`: иначе удаление
--    тенанта (`tenant.purge`) упирается в цикл «урок курса → версия → урок-снимок → версия»
--    и не сходится. Версию, на которую ссылается урок, приложение не удаляет никогда:
--    физическое удаление модуля разрешено только без единого места (§7.5).
-- 4. `lessons_library_ref_ck` сверяет не `body is null` (колонки `body` у урока нет), а то,
--    что место использования читает закреплённый снимок: `item_type = 'resource'` и
--    `resource_version_id is not null`. Плюс `lessons_library_body_ck`: в R1 телом модуля
--    бывает только материал (Р-31.7).
-- 5. `pin_mode` по умолчанию `hotfix_auto`, а не `fixed`: так требуют Р-31.4 («значение по
--    умолчанию») и критерий приёмки 6 (§13); `fixed` в §7.2 описывал закрепление версии,
--    которое действует при любом режиме.
-- 6. `library_module_usages.holder_title` и `library_modules.embedding_model` — сверх DDL:
--    первое требует В-11 (у каждой мягкой ссылки — снимок названия, «Вузол/Урок» на экране
--    §5.3 и в «Відключені раніше» переживает удаление узла), второе — несравнимость векторов
--    разных моделей (провайдер без ключа — заглушка, `HANDOFF` §6; смена провайдера должна
--    находить устаревшие векторы, а не молча смешивать их в поиске PR-26).
-- 7. `trajectory_nodes.library_version_id` здесь НЕ заводится — это PR-26 (`45` §5: две ветки
--    не трогают одну таблицу). Место узла траектории до PR-26 живёт только в реестре мест.

-- ── 1. Карточка модуля (`31` §3.2) — без FK на текущую версию: цикл, шаг 3 ──────────────
CREATE TABLE "library_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"content_kind" text DEFAULT 'article' NOT NULL,
	"category_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"language" text DEFAULT 'uk' NOT NULL,
	"summary" text,
	"estimated_minutes" integer,
	"owner_id" uuid NOT NULL,
	"author_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"draft_lesson_id" uuid,
	"current_version_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"archived_by" uuid,
	"archive_reason" text,
	"search_tsv" tsvector,
	"embedding" vector(768),
	"embedding_model" text,
	"created_by" uuid NOT NULL,
	CONSTRAINT "library_modules_tenant_slug_uq" UNIQUE("tenant_id","slug"),
	CONSTRAINT "library_modules_status_chk" CHECK ("status" IN ('draft', 'published', 'archived')),
	CONSTRAINT "library_modules_content_kind_chk" CHECK ("content_kind" IN ('article', 'file', 'video', 'link')),
	CONSTRAINT "library_modules_archived_chk" CHECK ("status" <> 'archived' OR ("archived_at" IS NOT NULL AND "archive_reason" IS NOT NULL)),
	-- cardinality, а не array_length из DDL: array_length('{}', 1) — NULL, и CHECK пропустил бы пустой массив
	CONSTRAINT "library_modules_authors_chk" CHECK (cardinality("author_ids") BETWEEN 1 AND 10),
	CONSTRAINT "library_modules_tags_chk" CHECK (cardinality("tags") <= 20),
	CONSTRAINT "library_modules_title_chk" CHECK (char_length("title") BETWEEN 3 AND 200),
	CONSTRAINT "library_modules_slug_chk" CHECK ("slug" ~ '^[a-z0-9-]{3,80}$'),
	CONSTRAINT "library_modules_summary_chk" CHECK ("summary" IS NULL OR char_length("summary") <= 300),
	CONSTRAINT "library_modules_minutes_chk" CHECK ("estimated_minutes" IS NULL OR "estimated_minutes" BETWEEN 1 AND 600),
	CONSTRAINT "library_modules_reason_chk" CHECK ("archive_reason" IS NULL OR char_length("archive_reason") BETWEEN 5 AND 500),
	CONSTRAINT "library_modules_usage_count_chk" CHECK ("usage_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "library_modules" ADD CONSTRAINT "library_modules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_modules" ADD CONSTRAINT "library_modules_category_id_course_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."course_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_modules" ADD CONSTRAINT "library_modules_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_modules" ADD CONSTRAINT "library_modules_draft_lesson_id_lessons_id_fk" FOREIGN KEY ("draft_lesson_id") REFERENCES "public"."lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_modules" ADD CONSTRAINT "library_modules_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_modules" ADD CONSTRAINT "library_modules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_library_modules_tenant" ON "library_modules" USING btree ("tenant_id","status","updated_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_library_modules_tenant_kind" ON "library_modules" USING btree ("tenant_id","content_kind");--> statement-breakpoint
CREATE INDEX "idx_library_modules_tenant_category" ON "library_modules" USING btree ("tenant_id","category_id");--> statement-breakpoint
-- gin и hnsw не начинаются с tenant_id по своей природе; рядом три полных btree с tenant_id
-- первым (`40` §7.1 признал это достаточным), RLS корректности поиска не теряет
CREATE INDEX "idx_library_modules_search" ON "library_modules" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "idx_library_modules_embedding" ON "library_modules" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint

-- Полнотекстовый вектор: название (A), описание и метки (B). Тело ищется эмбеддингом по
-- последней версии (§7.8), а не FTS черновика — поиск находит то, что можно вставить.
CREATE OR REPLACE FUNCTION library_modules_tsv_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.summary, '')), 'B') ||
    setweight(to_tsvector('simple', array_to_string(NEW.tags, ' ')), 'B');
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER library_modules_tsv_trg BEFORE INSERT OR UPDATE OF title, summary, tags
  ON library_modules FOR EACH ROW EXECUTE FUNCTION library_modules_tsv_update();
--> statement-breakpoint

-- ── 2. Версии (`31` §3.3) ───────────────────────────────────────────────────────────────
CREATE TABLE "library_module_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"library_module_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"lesson_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content_kind" text NOT NULL,
	"estimated_minutes" integer,
	"changelog" text NOT NULL,
	"diff" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_hotfix" boolean DEFAULT false NOT NULL,
	"media_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid NOT NULL,
	CONSTRAINT "library_module_versions_tenant_module_version_uq" UNIQUE("tenant_id","library_module_id","version"),
	CONSTRAINT "library_module_versions_version_chk" CHECK ("version" >= 1),
	CONSTRAINT "library_module_versions_status_chk" CHECK ("status" IN ('published', 'retired')),
	CONSTRAINT "library_module_versions_changelog_chk" CHECK (char_length("changelog") BETWEEN 5 AND 500)
);
--> statement-breakpoint
ALTER TABLE "library_module_versions" ADD CONSTRAINT "library_module_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_module_versions" ADD CONSTRAINT "library_module_versions_library_module_id_library_modules_id_fk" FOREIGN KEY ("library_module_id") REFERENCES "public"."library_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Урок-снимок неизменяем и не удаляется, пока его держит версия (§3.3 «неизменяемый снимок»)
ALTER TABLE "library_module_versions" ADD CONSTRAINT "library_module_versions_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_module_versions" ADD CONSTRAINT "library_module_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_library_module_versions_tenant" ON "library_module_versions" USING btree ("tenant_id","library_module_id","version" DESC);--> statement-breakpoint
CREATE INDEX "idx_library_module_versions_lesson" ON "library_module_versions" USING btree ("tenant_id","lesson_id");--> statement-breakpoint

-- ── 3. Замыкание цикла карточка ↔ версия (`40` §5, шаг 3) ───────────────────────────────
ALTER TABLE "library_modules" ADD CONSTRAINT "library_modules_current_version_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."library_module_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ── 4. Места использования (`31` §3.4) ──────────────────────────────────────────────────
-- holder_id / container_id — мягкие ссылки (В-11): держатель бывает узлом графа, у которого
-- нет строки урока. Снимки названий — чтобы строка пережила удаление цели. Строка не
-- удаляется никогда: detached_at конечен, отключённые места нужны отчёту и §7.5.
CREATE TABLE "library_module_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"library_module_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"holder_type" text NOT NULL,
	"holder_id" uuid NOT NULL,
	"holder_title" text,
	"container_type" text NOT NULL,
	"container_id" uuid NOT NULL,
	"container_title" text NOT NULL,
	"pin_mode" text DEFAULT 'hotfix_auto' NOT NULL,
	"is_stale" boolean DEFAULT false NOT NULL,
	"latest_version_seen" integer,
	"attached_by" uuid NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detached_at" timestamp with time zone,
	CONSTRAINT "library_module_usages_holder_type_chk" CHECK ("holder_type" IN ('trajectory_node', 'course_lesson')),
	CONSTRAINT "library_module_usages_container_type_chk" CHECK ("container_type" IN ('trajectory', 'course')),
	CONSTRAINT "library_module_usages_pin_mode_chk" CHECK ("pin_mode" IN ('fixed', 'hotfix_auto')),
	-- Узел живёт в траектории, урок — в курсе (`31` §3.4); иначе «Трек/Курс» на экране §5.3 врёт
	CONSTRAINT "library_module_usages_holder_container_chk" CHECK (("holder_type" = 'trajectory_node') = ("container_type" = 'trajectory'))
);
--> statement-breakpoint
ALTER TABLE "library_module_usages" ADD CONSTRAINT "library_module_usages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- restrict: модуль и версию, которые держит место (даже отключённое), удалить нельзя (§7.5)
ALTER TABLE "library_module_usages" ADD CONSTRAINT "library_module_usages_library_module_id_library_modules_id_fk" FOREIGN KEY ("library_module_id") REFERENCES "public"."library_modules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_module_usages" ADD CONSTRAINT "library_module_usages_version_id_library_module_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."library_module_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_module_usages" ADD CONSTRAINT "library_module_usages_attached_by_users_id_fk" FOREIGN KEY ("attached_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_library_module_usages_tenant" ON "library_module_usages" USING btree ("tenant_id","library_module_id") WHERE detached_at IS NULL;--> statement-breakpoint
-- Полный индекс с tenant_id первым (контрактный тест 2): частичный выше не обслуживает «Відключені раніше»
CREATE INDEX "idx_library_module_usages_container" ON "library_module_usages" USING btree ("tenant_id","container_type","container_id");--> statement-breakpoint
CREATE INDEX "idx_library_module_usages_module_all" ON "library_module_usages" USING btree ("tenant_id","library_module_id","attached_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_library_module_usages_stale" ON "library_module_usages" USING btree ("tenant_id","is_stale") WHERE detached_at IS NULL AND is_stale;--> statement-breakpoint
-- §7.15: один держатель — одна активная ссылка; в разные узлы одного трека — можно
CREATE UNIQUE INDEX "idx_library_module_usages_holder" ON "library_module_usages" USING btree ("tenant_id","holder_type","holder_id") WHERE detached_at IS NULL;--> statement-breakpoint

-- ── 5. Предложения (`31` §3.5) ──────────────────────────────────────────────────────────
CREATE TABLE "library_module_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_lesson_id" uuid NOT NULL,
	"source_container_type" text NOT NULL,
	"source_container_id" uuid NOT NULL,
	"proposed_title" text NOT NULL,
	"proposed_category_id" uuid,
	"comment" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposed_by" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"library_module_id" uuid,
	CONSTRAINT "library_module_proposals_status_chk" CHECK ("status" IN ('pending', 'accepted', 'rejected', 'withdrawn')),
	CONSTRAINT "library_module_proposals_container_type_chk" CHECK ("source_container_type" IN ('trajectory', 'course')),
	CONSTRAINT "library_module_proposals_rejected_chk" CHECK ("status" <> 'rejected' OR "decision_comment" IS NOT NULL),
	CONSTRAINT "library_module_proposals_title_chk" CHECK (char_length("proposed_title") BETWEEN 3 AND 200),
	CONSTRAINT "library_module_proposals_comment_chk" CHECK (char_length("comment") BETWEEN 1 AND 500),
	CONSTRAINT "library_module_proposals_decision_chk" CHECK ("decision_comment" IS NULL OR char_length("decision_comment") BETWEEN 5 AND 500)
);
--> statement-breakpoint
ALTER TABLE "library_module_proposals" ADD CONSTRAINT "library_module_proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_module_proposals" ADD CONSTRAINT "library_module_proposals_source_lesson_id_lessons_id_fk" FOREIGN KEY ("source_lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_module_proposals" ADD CONSTRAINT "library_module_proposals_proposed_category_id_course_categories_id_fk" FOREIGN KEY ("proposed_category_id") REFERENCES "public"."course_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_module_proposals" ADD CONSTRAINT "library_module_proposals_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_module_proposals" ADD CONSTRAINT "library_module_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_module_proposals" ADD CONSTRAINT "library_module_proposals_library_module_id_library_modules_id_fk" FOREIGN KEY ("library_module_id") REFERENCES "public"."library_modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_library_module_proposals_tenant" ON "library_module_proposals" USING btree ("tenant_id","status","created_at" DESC);--> statement-breakpoint
-- «Цей урок уже запропоновано, рішення ще не ухвалено» (§6.3) — индексом, а не проверкой в коде
CREATE UNIQUE INDEX "idx_library_module_proposals_pending" ON "library_module_proposals" USING btree ("tenant_id","source_lesson_id") WHERE status = 'pending';--> statement-breakpoint

-- ── 6. `lessons`: ровно одно владение (`31` §3.1, П-11; `40` §5 шаг 5 — последним) ──────
-- До этой миграции `module_id` был NOT NULL, а `library_module_id` появляется здесь пустым:
-- у каждой существующей строки владелец ровно один. Констрейнт ставится с проверкой всех
-- строк (не NOT VALID) — это и есть гарантия «ни одного урока без владельца» на живых данных.
ALTER TABLE "lessons" ALTER COLUMN "module_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "library_module_id" uuid;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "library_version_id" uuid;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_library_module_id_library_modules_id_fk" FOREIGN KEY ("library_module_id") REFERENCES "public"."library_modules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_library_version_id_library_module_versions_id_fk" FOREIGN KEY ("library_version_id") REFERENCES "public"."library_module_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_owner_ck" CHECK ((module_id IS NOT NULL)::int + (library_module_id IS NOT NULL)::int = 1);--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_library_ref_ck" CHECK (library_version_id IS NULL OR (module_id IS NOT NULL AND item_type = 'resource' AND resource_version_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_library_body_ck" CHECK (library_module_id IS NULL OR item_type = 'resource');--> statement-breakpoint
CREATE INDEX "idx_lessons_tenant_library" ON "lessons" USING btree ("tenant_id","library_module_id") WHERE library_module_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_lessons_tenant_library_version" ON "lessons" USING btree ("tenant_id","library_version_id") WHERE library_version_id IS NOT NULL;--> statement-breakpoint

-- ── 7. RLS: enable + force, политика с using и with check (`02` §2.12) ───────────────────
ALTER TABLE library_modules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE library_modules FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON library_modules
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE library_module_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE library_module_versions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON library_module_versions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE library_module_usages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE library_module_usages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON library_module_usages
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE library_module_proposals ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE library_module_proposals FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON library_module_proposals
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

COMMENT ON COLUMN "lessons"."library_module_id" IS 'Владелец-модуль библиотеки (docs/v2/31 §3.1): черновик или снимок версии. Ровно одно из module_id / library_module_id — lessons_owner_ck.';--> statement-breakpoint
COMMENT ON COLUMN "lessons"."library_version_id" IS 'Урок курса как место использования версии модуля: читает закреплённый снимок (resource_version_id), своего материала нет — lessons_library_ref_ck.';--> statement-breakpoint
COMMENT ON COLUMN "library_modules"."embedding_model" IS 'Чем посчитан embedding (provider:model:dims). Векторы разных моделей несравнимы: library.embedding_refresh пересчитывает строки чужой модели.';--> statement-breakpoint
COMMENT ON COLUMN "library_module_usages"."pin_mode" IS 'fixed — критичне виправлення не доезжает само; hotfix_auto (по умолчанию, Р-31.4) — доезжает, если по контейнеру нет прохождений in_progress (PR-26).';--> statement-breakpoint

-- ── 8. Скоупы модуля уже заведённым тенантам (`31` §2) ──────────────────────────────────
-- mentor и manager — `library.view` + `library.use` (вставлять они всё равно не могут: нет
-- `course.edit`, но предложить урок — могут, критерий приёмки 5); author — плюс
-- `library.publish`; admin — все четыре. Новые тенанты получают набор из SYSTEM_ROLES
-- (`shared/domain/roles.ts`), здесь — догоняющая вставка тем же составом. Каждый скоуп
-- добавляется, только если его ещё нет: частично выданный набор не дублируется.
UPDATE roles SET scopes = scopes || ARRAY(SELECT s FROM unnest(ARRAY['library.view', 'library.use']) AS s WHERE NOT s = ANY(roles.scopes))
	WHERE is_system AND code IN ('mentor', 'manager') AND NOT scopes @> ARRAY['library.view', 'library.use'];--> statement-breakpoint
UPDATE roles SET scopes = scopes || ARRAY(SELECT s FROM unnest(ARRAY['library.view', 'library.use', 'library.publish']) AS s WHERE NOT s = ANY(roles.scopes))
	WHERE is_system AND code = 'author' AND NOT scopes @> ARRAY['library.view', 'library.use', 'library.publish'];--> statement-breakpoint
UPDATE roles SET scopes = scopes || ARRAY(SELECT s FROM unnest(ARRAY['library.view', 'library.use', 'library.publish', 'library.manage']) AS s WHERE NOT s = ANY(roles.scopes))
	WHERE is_system AND code = 'admin' AND NOT scopes @> ARRAY['library.view', 'library.use', 'library.publish', 'library.manage'];
