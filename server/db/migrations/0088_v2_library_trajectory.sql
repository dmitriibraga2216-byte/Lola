-- docs/v2/45-plan.md PR-26 · docs/v2/31-module-library.md §3.1 (DDL «-- PR-26»), §7.1–§7.4, §7.8 ·
-- docs/v2/39-patches.md П-17 (узел траектории ссылается на модуль библиотеки с закреплённой
-- версией; модель ветвления `17` §14.3 не сокращается).
--
-- Узел траектории становится местом использования тем же способом, что урок курса в PR-25
-- (`31` §3.1): ссылка живёт в самом держателе. Узел-ссылка — это узел-задание, чей контент —
-- материал-тело модуля (`content_type = 'resource'`, `content_id` — материал, который ведёт
-- только библиотека), а какой снимок этого материала получит человек, решает
-- `library_version_id`: версия → урок-снимок → `resource_versions`. Публикация новой версии
-- модуля узел не трогает (Р-31.2); переключает его только явное «Оновити до останньої версії»
-- или «Критичне виправлення» с `pin_mode = 'hotfix_auto'` (Р-31.4).
--
-- ── Отступления от DDL `31` §3.1 (каждое — с пометкой «исправлено» в документе) ─────────
-- 1. Плюс CHECK `trajectory_nodes_library_ref_ck`: ссылка бывает только у узла-задания,
--    читающего материал, — зеркало `lessons_library_ref_ck`. Без него ссылку можно было бы
--    повесить на «І»/«АБО» или таймер, и движок выдал бы назначение там, где его нет.
-- 2. `search_tsv` получает тело последней опубликованной версии с весом C (§7.8): критерий
--    приёмки 8 ищет «розведення» — слово, которого нет ни в названии, ни в описании, ни в
--    метках, — одним словом, а гибрид с вектором §7.8 включается только для запроса длиннее
--    трёх слов. Черновик по-прежнему не индексируется: поиск находит то, что можно вставить.
--
-- Колонку `trajectory_nodes.library_version_id` PR-25 сознательно не заводил (`45` §5: две
-- ветки одну таблицу не трогают) — место узла жило только в реестре `library_module_usages`.
-- Активные места узлов переносятся в колонку здесь же (шаг 2).

-- ── 1. Ссылка узла на закреплённую версию (`31` §3.1) ───────────────────────────────────
-- restrict, как в DDL: версию, которую держит узел, не удалить. Цикла для `tenant.purge`
-- (удаление таблицами с повтором) нет — версии на узлы не ссылаются, узлы уходят первыми.
ALTER TABLE "trajectory_nodes" ADD COLUMN "library_version_id" uuid;--> statement-breakpoint
-- Имя задано явно: сгенерированное (`…_library_module_versions_id_fk`) длиннее 63 символов и
-- Postgres молча обрезал бы его
ALTER TABLE "trajectory_nodes" ADD CONSTRAINT "trajectory_nodes_library_version_fk" FOREIGN KEY ("library_version_id") REFERENCES "public"."library_module_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- ── 2. Перенос активных мест узлов из реестра в колонку ─────────────────────────────────
-- До PR-26 вставка в узел писала только строку реестра, а узел продолжал читать свой прежний
-- контент. Теперь узел читает материал-тело модуля (`lessons.item_id` урока-снимка версии)
-- на закреплённой версии места. Места, чей держатель уже не задание или исчез, остаются как
-- есть — их закрывает ночная сверка `library.usage_recalc` (узел без ссылки — место закрыто).
UPDATE "trajectory_nodes" n
   SET "library_version_id" = u."version_id",
       "content_type" = 'resource',
       "content_id" = l."item_id",
       "updated_at" = now()
  FROM "library_module_usages" u
  JOIN "library_module_versions" v ON v."id" = u."version_id"
  JOIN "lessons" l ON l."id" = v."lesson_id"
 WHERE u."holder_type" = 'trajectory_node'
   AND u."detached_at" IS NULL
   AND u."holder_id" = n."id"
   AND n."kind" = 'task';--> statement-breakpoint

-- ── 3. Ссылка — только у узла-задания с материалом (зеркало lessons_library_ref_ck) ─────
-- Ставится после переноса и проверяет все строки (не NOT VALID).
ALTER TABLE "trajectory_nodes" ADD CONSTRAINT "trajectory_nodes_library_ref_ck" CHECK ("library_version_id" IS NULL OR ("kind" = 'task' AND "content_type" = 'resource' AND "content_id" IS NOT NULL));--> statement-breakpoint
CREATE INDEX "idx_trajectory_nodes_tenant_library" ON "trajectory_nodes" USING btree ("tenant_id","library_version_id") WHERE "library_version_id" IS NOT NULL;--> statement-breakpoint

-- ── 4. Полнотекст по телу последней версии (`31` §7.8, критерий 8) ──────────────────────
-- Название (A), описание и метки (B) — как в 0081; плюс тело текущей опубликованной версии
-- (C): урок-снимок версии → неизменяемый снимок материала. Триггер срабатывает и на смену
-- `current_version_id`, то есть на каждую публикацию версии.
CREATE OR REPLACE FUNCTION library_modules_tsv_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  body text;
BEGIN
  IF NEW.current_version_id IS NOT NULL THEN
    SELECT rv.plain_text INTO body
      FROM library_module_versions v
      JOIN lessons l ON l.id = v.lesson_id
      JOIN resource_versions rv ON rv.id = l.resource_version_id
     WHERE v.id = NEW.current_version_id;
  END IF;
  NEW.search_tsv :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.summary, '')), 'B') ||
    setweight(to_tsvector('simple', array_to_string(NEW.tags, ' ')), 'B') ||
    setweight(to_tsvector('simple', coalesce(body, '')), 'C');
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS library_modules_tsv_trg ON library_modules;--> statement-breakpoint
CREATE TRIGGER library_modules_tsv_trg BEFORE INSERT OR UPDATE OF title, summary, tags, current_version_id
  ON library_modules FOR EACH ROW EXECUTE FUNCTION library_modules_tsv_update();--> statement-breakpoint
-- Пересчёт уже опубликованных модулей: колонка в SET — и триггер пересобирает вектор
UPDATE library_modules SET current_version_id = current_version_id WHERE current_version_id IS NOT NULL;--> statement-breakpoint

COMMENT ON COLUMN "trajectory_nodes"."library_version_id" IS 'Узел-задание как место использования версии модуля библиотеки (docs/v2/31 §3.1, П-17): контент — материал-тело модуля, человек получает снимок этой версии. Переключает только «Оновити до останньої» или hotfix_auto (§7.3, §7.4).';
