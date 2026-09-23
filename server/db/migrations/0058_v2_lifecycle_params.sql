-- docs/v2/45-plan.md PR-06 · docs/v2/39-patches.md П-15 · docs/v2/33-lifecycle.md §7.5
-- Индексы под фильтр ключей `params` по возможностям этапа.
--
-- Схему фильтр не меняет: правила прохождения остаются в назначении (CLAUDE.md п. 11), этап
-- лишь ограничивает их состав, и решает это код (`stageCan()` через
-- `server/services/taskParams.ts`), а не констрейнт. Миграция нужна ради двух чтений, которые
-- фильтр породил:
--   1) запись назначения теперь на каждый create/update читает этап своего курса
--      (`assignments.subject_type = 'course'` → `courses.lifecycle_stage_id` → `lifecycle_stages`);
--   2) сквозная проверка 14 (`docs/v2/42-stages-delta.md` §5) обходит назначения курсов
--      целиком и обязана оставаться дешёвой, чтобы её гоняли, а не пропускали.
--
-- Существующий `assignments (tenant_id, subject_id)` для этих выборок не годится: обе
-- начинаются с типа носителя, а не с конкретного идентификатора. Индекс tenant-first —
-- контрактный тест 2 пакета (`docs/v2/40` §8).
CREATE INDEX IF NOT EXISTS "assignments_tenant_id_subject_type_subject_id_index"
  ON "assignments" USING btree ("tenant_id", "subject_type", "subject_id");--> statement-breakpoint

-- Обратный путь той же проверки: вход со стороны справочника этапов. `courses (tenant_id,
-- lifecycle_stage_id)` из 0057 отвечает на «курсы этапа внутри тенанта»; этот — на соединение
-- `lifecycle_stages.id = courses.lifecycle_stage_id`, где ведущей колонки `tenant_id` в условии
-- нет. Частичный: курс без этапа в такие соединения не входит никогда, и полный индекс с той же
-- ведущей колонкой уже есть рядом (контрактный тест 2 это и требует).
CREATE INDEX IF NOT EXISTS "courses_lifecycle_stage_id_index"
  ON "courses" USING btree ("lifecycle_stage_id") WHERE "lifecycle_stage_id" IS NOT NULL;
