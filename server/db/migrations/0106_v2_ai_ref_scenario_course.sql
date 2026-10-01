-- owner-decisions-ai-track · docs/v2/44 §Р-AI2.10 (решение владельца 01.10) и Р-BT.3.
--
-- Написана руками: снимок drizzle не пересобирается начиная с `0056` (см. `0098`).
--
-- Перечень `ai_call_ref_kind` (`docs/02` «Перечисления») пополняется двумя значениями:
--   * `interview_scenario` — «Згенерувати критерії (ШІ)» сценария собеседования (`30` §6.2, §10),
--     `ref_id` — сценарий; значение разрешено владельцем 01.10 (CLAUDE.md п. 13);
--   * `course` — «Згенерувати трек» (`35` §7.1, §7.7 п. 4, к. 4): черновик курса из модулей
--     библиотеки тенанта, `ref_id` — созданный курс; решение — по поручению владельца (`44` Р-BT.3).
-- Старые значения не трогаются: строки журнала, уже записанные под ними, остаются валидными.
ALTER TABLE "ai_calls" DROP CONSTRAINT "ai_calls_ref_chk";--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_ref_chk" CHECK ("ref_kind" in ('interview_session', 'interview_turn', 'review_hint', 'summary', 'vacancy_generation', 'library_module', 'knowledge_article', 'search_query', 'interview_scenario', 'course'));
