-- docs/v2/45-plan.md PR-14 · docs/v2/28-recruiting-candidates.md §4.2, §5.2, §7.5, §7.6, §7.9, §11 ·
-- docs/v2/44-decisions.md В-8 (кандидат и сотрудник — одна запись users).
--
-- Воронка: канбан, транзакция найма, две фоновые задачи. Новых таблиц здесь нет и не нужно:
-- найм не переносит строки, а меняет `users.kind` (`28` §3.1) — значит всё, чего не хватает,
-- это две колонки состояния и два индекса под выборки, которых до PR-14 не существовало.
--
-- Номер: план называл `0064`, но параллельные ветки заняли `0063` (PR-12), `0064` (PR-13),
-- `0066` (PR-18) и `0067` (PR-23). `when` в `meta/_journal.json` строго больше, чем у `0067`:
-- миграция с меньшим `when` молча пропускается на уже накаченной базе
-- (docstring tests/unit/migrations-journal.spec.ts).

-- ── 1. Момент последней смены состояния воронки (`28` §7.5) ─────────────────────────────
-- Авто-архивация считает «N дней с момента отказа». Выводить этот момент из
-- `candidate_status_history` нельзя без натяжки: историю пишет смена **колонки канбана**, а
-- состояние меняют и решения без смены колонки (отзыв кандидата, повторное открытие,
-- фоновая задача). Колонка — единственный носитель, одинаково верный для всех путей, и по ней
-- же считается «скільки днів у стані» на карточке. Значение ставит сервис при каждой записи
-- `candidate_state`; у сотрудника она пуста, как и остальные колонки кандидата.
ALTER TABLE "users" ADD COLUMN "candidate_state_at" timestamp with time zone;--> statement-breakpoint

-- ── 2. Отметка обезличивания по истёкшему согласию (`28` §7.9) ──────────────────────────
-- `candidate.consent_sweep` стирает ПД необратимо. Отметка нужна двум разным читателям:
-- задаче — чтобы не перебирать одни и те же записи каждую ночь (операция идемпотентна по
-- этой колонке, а не по «пустому телефону»), и карточке — чтобы объяснить человеку, почему
-- поля пусты, вместо «данные потерялись». В `audit_log` факт тоже пишется, но журнал
-- ретенционируется (docs/22 §10), а отметка живёт со строкой.
ALTER TABLE "users" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint

-- Догоняющее значение: у уже заведённых кандидатов состояние не менялось ни разу с момента
-- появления колонки (PR-13 вчера), поэтому берём `updated_at` — ближайшую честную оценку.
-- Без этого первая же ночная авто-архивация посчитала бы «в состоянии 0 дней» для всех.
UPDATE "users" SET "candidate_state_at" = coalesce("updated_at", "created_at")
 WHERE "kind" = 'candidate' AND "candidate_state_at" IS NULL;--> statement-breakpoint

-- ── 3. Индекс канбана (`28` §5.2, критерий §13 к. 12) ───────────────────────────────────
-- Колонка доски: страница из 50 карточек по `(tenant_id, candidate_status_id)` с сортировкой
-- по `created_at desc` и курсором по `id`. Существующий `idx_users_tenant_candidate_status`
-- порядка не даёт — при 250 карточках в колонке это sort всей колонки на каждую догрузку.
-- Индекс частичный по `kind = 'candidate'` (сотрудников в доске нет) — полный аналог уже
-- есть рядом: `idx_users_tenant_kind` (контрактная проверка 2 пакета, `40` §8).
CREATE INDEX "idx_users_candidate_board" ON "users" USING btree ("tenant_id","candidate_status_id","created_at" DESC,"id") WHERE "kind" = 'candidate';--> statement-breakpoint

-- ── 4. Индекс фоновых задач (`28` §7.5, §7.9, §11) ──────────────────────────────────────
-- `candidate.auto_archive` ищет `candidate_state = 'rejected'` старше N дней,
-- `candidate.consent_sweep` — истёкшее согласие. Обе задачи ходят по каждому тенанту каждую
-- ночь: без индекса это seq scan по всем людям тенанта, включая сотрудников.
CREATE INDEX "idx_users_candidate_state_at" ON "users" USING btree ("tenant_id","candidate_state","candidate_state_at") WHERE "kind" = 'candidate';--> statement-breakpoint
CREATE INDEX "idx_users_candidate_consent" ON "users" USING btree ("tenant_id","consent_expires_at") WHERE "kind" = 'candidate' AND "anonymized_at" IS NULL;
