-- docs/v2/45-plan.md PR-11 · docs/v2/34-storage.md §3.2, §7.2, §13 к. 2 и 6 ·
-- docs/v2/44-decisions.md В-4, В-17, В-19 · docs/v2/40-data-model-delta.md §3.3
--
-- `media_assets`: переименование двух колонок и колонки мягкого удаления.
--
-- Переименование, а не пара новых колонок (В-4, вариант A): `alter table … rename column` —
-- это метаданные, данные не переписываются, внешний ключ переезжает вместе с колонкой.
-- `checksum` была мёртвой (0 чтений, 0 записей), `uploaded_by` — почти мёртвой (одна запись
-- в `server/services/media.ts`, 0 чтений), поэтому цена в коде — одна строка продакшна
-- и семь тестовых фикстур.
--
-- Факт «кто загрузил» не теряется: он переезжает в `audit_log` событием `media.upload`
-- (В-4; до этой миграции `media.ts` не писал аудит ни разу — файл появлялся в тенанте
-- без следа). Для файлов, созданных до миграции, `owner_user_id` = загрузивший
-- (`34` §7.1, оговорка о домиграционных файлах).
--
-- Перечень `origin` и остальные колонки `34` §3.2 — следующей миграцией 0063: порядок
-- В-4 → В-6 задан `44` §10, чтобы снимок drizzle пересобирался один раз.

-- ── 1. uploaded_by → owner_user_id (В-4) ────────────────────────────────────────────────
ALTER TABLE "media_assets" RENAME COLUMN "uploaded_by" TO "owner_user_id";--> statement-breakpoint
COMMENT ON COLUMN "media_assets"."owner_user_id" IS 'Чей файл по смыслу (docs/v2/34 §7.1). Кто загрузил — событие media.upload в audit_log (docs/v2/44 В-4). У домиграционных файлов совпадают.';--> statement-breakpoint

-- Имя внешнего ключа приводится к колонке, и поведение при удалении человека меняется
-- с `no action` на `set null`: `34` §13 к. 6 — «сотрудник удалён по запросу на стирание ПД,
-- видеоответы присутствуют с пустым owner_user_id». С `no action` удаление человека
-- упиралось бы в его файлы, то есть критерий был бы невыполним.
ALTER TABLE "media_assets" DROP CONSTRAINT IF EXISTS "media_assets_uploaded_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_user_id_users_id_fk"
  FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint

-- ── 2. checksum → checksum_sha256 (В-4) ─────────────────────────────────────────────────
ALTER TABLE "media_assets" RENAME COLUMN "checksum" TO "checksum_sha256";--> statement-breakpoint
COMMENT ON COLUMN "media_assets"."checksum_sha256" IS 'sha256 файла (docs/11 §7, дедупликация в тенанте); индекс — ниже, docs/v2/34 §3.2.';--> statement-breakpoint

-- ── 3. Мягкое удаление: кто и почему (В-17, `40` §3.3) ──────────────────────────────────
-- `deleted_at` уже существует и до этого PR никем не выставлялся — колонка есть, механизма
-- нет, худшее из состояний (В-17). Теперь удаление — только мягкое: `lifecycle` и
-- `purge_after` добавляет 0063, физическое удаление объекта из S3 не делает никто
-- (`44` §8: срок корзины предварительно 30 дней, задача `storage.purge` — PR-36).
ALTER TABLE "media_assets" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "delete_reason" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_deleted_by_users_id_fk"
  FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
COMMENT ON COLUMN "media_assets"."delete_reason" IS 'Причина удаления, обязательна для is_evidence (docs/v2/34 §6.1, §7.2.2).';--> statement-breakpoint

-- ── 4. Индексы по переименованным колонкам (`34` §3.2) ──────────────────────────────────
-- Частичный по контрольной сумме — опора дедупликации `docs/11` §7 п. 7, которая до сих пор
-- была обещанием без индекса. Полный tenant-first индекс у таблицы уже есть
-- (`media_assets_tenant_id_key_unique`), контрактный тест v2-contract-02 доволен.
CREATE INDEX "idx_media_assets_tenant_checksum" ON "media_assets" USING btree ("tenant_id","checksum_sha256","bytes") WHERE "checksum_sha256" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_media_assets_tenant_owner" ON "media_assets" USING btree ("tenant_id","owner_user_id","created_at" DESC);
