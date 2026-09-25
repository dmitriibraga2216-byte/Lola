-- fix-candidate-access · docs/v2/28 §7.7, §4.2 (критерий §13 к. 7) · docs/28 §28.22.
--
-- Схема не меняется — только данные. Снимок drizzle не пересобирается начиная с `0056`:
-- миграция написана руками и меняет только `_journal.json`.
--
-- До этого исправления отказ, архивация, самоотвод и стирание ПД не гасили сессии кандидата:
-- вошедший до решения человек оставался внутри до конца скользящего 30-дневного срока, хотя
-- новый вход ему по §7.7 закрыт. С этого PR сессии гаснут в момент смены состояния
-- (`server/services/candidateAccess.ts#closeCandidateSessionsTx`), а здесь закрываются те, что
-- пережили такой переход раньше. Нанятый — `kind = 'employee'` и `candidate_state` пуст, его
-- сессии не трогаются. Строк `session.revoked` в журнал безопасности миграция не пишет: контекста
-- запроса у неё нет (CLAUDE.md п. 14), а факт закрытия остаётся в `sessions.revoked_at`.
UPDATE "sessions" AS s
   SET "revoked_at" = now()
  FROM "users" AS u
 WHERE u."id" = s."user_id"
   AND u."kind" = 'candidate'
   AND u."candidate_state" <> 'active'
   AND s."revoked_at" IS NULL;
