# Lola LMS — ТЗ. 43. Сверка пакета `docs/v2` с фактическим состоянием репозитория

**Фаза 0 задания `docs/v2/HANDOFF.md` §2.** Пакет писался от снимка ТЗ на 19.09.2026, а
репозиторий с тех пор ушёл вперёд: закрыта очередь аудита (`docs/32-audit-2026-09-19-2.md`
§Б), закрыто 64 из 75 долгов (`docs/33-debts-2026-09-20.md`), получены ответы заказчика
(`docs/34-questions-2026-09-21.md`), сверстаны экраны по мокапам (`docs/31-mockups-map.md`).
Этот документ отвечает на один вопрос: **что из пакета уже сделано, что сделано иначе, а что
ещё предстоит.**

## Чем сверялось

| Ось | Источник «заявлено» | Источник «фактически» |
|---|---|---|
| Схема | `docs/v2/40-data-model-delta.md` §2 (73 таблицы), §3 (14 `alter table`, 97 колонок) | живая dev-БД (`information_schema`), `server/db/migrations/*.sql` (53 файла, `0000`…`0052`), `server/db/schema/*.ts`, `docs/02-data-model.md` |
| Патчи | `docs/v2/39-patches.md` (19 номеров П-01…П-25 с подпунктами) | `docs/00-…34-…`, `shared/`, `server/`, `app/` |
| API | `docs/v2/41-api-delta.md` §2 | `docs/04-api.md`, дерево `server/api/v1` (603 файла) |
| Противоречия | `docs/v2/40` §9 (Р-1…Р-11), `docs/v2/41` §8 | всё перечисленное выше |

Состояние БД снято на 23.09.2026: **143 таблицы**, последняя миграция
`0052_screens7_development_mentor.sql`. Представлений и материализованных представлений в
схеме `public` нет ни одного — это важно для Р-3.

**Метод.** Для каждой строки пакета выполнялась проверка в фактическом артефакте (запрос к
`information_schema`, `grep` по коду, чтение файла), а не сверка по памяти. Строк «не
проверено» в документе нет. Там, где вердикт опирается на конкретный файл, файл назван.

---

## 1. Схема

### 1.1 Итог по 73 новым таблицам

**Ни одна из 73 таблиц пакета не существует в БД под своим именем.** Проверено запросом к
`information_schema.tables` и `grep` по `server/db/schema/`, `server/services/` и
`docs/02-data-model.md` — все 73 имени дают ноль совпадений во всех трёх местах.

| Вердикт | Таблиц |
|---|---:|
| Есть под тем же именем | **0** |
| Есть под другим именем (частично по колонкам) | **2** |
| Есть частично (часть колонок в существующей таблице того же назначения) | **0** |
| Нет | **71** |

Отдельно ниже (§1.3) перечислены **8 таблиц, чья функция частично закрыта другими
таблицами репозитория**, но эквивалентом не является: пакет в этих случаях сам заводит
новую сущность рядом с существующей и делает по существующей `alter table`.

### 1.2 Две таблицы, существующие под другим именем

| Заявлено (`40` §2) | Фактически | Чего нет | Что делать |
|---|---|---|---|
| `org_structure_conflicts` (`32` §3.3) | **`org_conflicts`** — `id, tenant_id, user_id, kind, source, import_job_id, details, actor_id, request_context, resolved_at, resolved_by` (миграция `0038_spec16_people.sql`, `shared/enums.ts` `ORG_CONFLICT_KINDS`) | `severity`, `node_id`, `status`, `detected_at`; `code` называется `kind`. Перечни не пересекаются по именам: репозиторий — `double_unit, placement_replaced, manager_self, manager_cycle, unit_missing` (5), пакет — `no_manager, manager_mismatch, self_manager, orphan_user, multi_primary, depth_exceeded, dismissed_holder, position_mismatch` (8) | Не создавать новую таблицу. `alter table org_conflicts` на 4 колонки; перечень `kind` расширить объединением двух списков через `docs/02` §«Перечисления» (CLAUDE.md п. 13 — не молча). `node_id` добавляется вместе с `org_nodes`. Пакет сам пишет, что таблица «стыкуется с протоколом конфликтов базового ТЗ» (`32` §3.3) — значит, это одна сущность, а не две |
| `person_notes` (`38` §3.4) | **`user_notes`** — `id, tenant_id, user_id, author_id, body, created_at, updated_at` (миграция `0038`) | `visibility`, `category`, `is_pinned`, `flagged_at`, `flagged_terms`, `shared_at`, `archived_at` (7 колонок) и 4 констрейнта (`visibility_chk`, `category_chk`, `body_chk` 3…2000, `self_chk`) | Не создавать `person_notes`. `alter table user_notes` на 7 колонок + 4 констрейнта + частичный индекс `(tenant_id, user_id, created_at desc) where archived_at is null`. Пакет `user_notes` не видел — это прямое дублирование, поймать его можно было только сверкой |

### 1.3 Восемь таблиц, чья функция частично закрыта, но эквивалента нет

Все восемь получают вердикт **«нет»** в §1.1: пакет заводит их рядом с существующими
таблицами, а не вместо них. Перечислены отдельно, чтобы при реализации не продублировать
данные.

| Заявлено | Чем частично закрыто сейчас | Почему не эквивалент |
|---|---|---|
| `org_nodes` (`32`) | `org_units` (`id, tenant_id, parent_id, name, path ltree`) | Пакет **явно разводит** три сущности (`32` §3.1): `org_units` — подразделение, `positions` — должность, `org_nodes` — узел подчинения. Это разные деревья, `org_units` остаётся |
| `org_manager_map` (`32`) | `locations.manager_id`, `user_placements.manager_id`, `functional_chiefs` (`user_id, chief_id, kind, scope`) | Три источника без материализованной карты и без цепочки вверх. Ровно то, что `32` §7.8 закрывает `resolveManager()` |
| `storage_usage_counters` (`34`) | `tenant_usage.storage_bytes` — одно число на суточный сбор | Нет разреза по происхождению и категории, нет оперативности |
| `usage_counters` (`35`) | `tenant_usage` — суточный снимок (`server/services/usage.ts`, задача `usage.collect`) | Пакет делает по `tenant_usage` **отдельный** `alter table` на 8 колонок (`40` §3.5) — значит, в модели пакета это две разные таблицы: снимок и счётчик периода со снимком лимита |
| `usage_events` (`35`) | `sms_usage` (`tenant_id, count, month`) — одна ось, агрегат | Журнала расхода по осям нет |
| `user_activity_events` (`38`) | `task_access_log`, `security_log`, `pass_events` | Три журнала разного назначения, без снимка таймзоны и локального дня — того, ради чего таблица и заводится |
| `content_issues` / `content_reports` (`36`) | `knowledge_feedback` (`article_id, user_id, helpful, comment`) | Только база знаний, только «полезно/нет», без дедупликации, влияния на баллы и пересчёта |
| `learning_time_sessions` / `learning_time_totals` (`37`) | `attempts.time_spent_sec`, `lesson_progress.seconds_spent`, `lesson_progress.last_tick_at` | Сырые величины есть (это и предполагает `40` §3.5), сегментов и витрины нет |

### 1.4 Вердикт по каждой из 73 таблиц

Легенда: **нет** — отсутствует везде (БД, миграции, `server/db/schema`, `docs/02`);
**др. имя** — существует под другим именем, состав колонок неполон (§1.2).

#### 2.1 Рекрутинг: кандидаты (`28`) — 4

| Таблица | Вердикт | Подтверждение |
|---|---|---|
| `candidate_statuses` | нет | 0 совпадений в БД и коде |
| `candidate_scores` | нет | зависит от `scales`/`scale_levels` — **они уже есть** (см. Р-4) |
| `candidate_comments` | нет | `comments` — комментарии к контенту, не к человеку |
| `candidate_status_history` | нет | — |

#### 2.2 Рекрутинг: вакансии (`29`) — 10

| Таблица | Вердикт |
|---|---|
| `vacancies` · `vacancy_languages` · `vacancy_criteria` · `vacancy_criterion_scores` · `vacancy_templates` | нет (5) |
| `job_board_accounts` · `vacancy_publications` · `vacancy_applications` · `public_apply_attempts` · `vacancy_ai_generations` | нет (5) |

Подтверждение: `grep -rn "vacanc" server/ shared/ app/ i18n/` — пусто. Ближайшая опора —
`rate_limits` (существует) закрывает механику `public_apply_attempts`, но не саму таблицу.

#### 2.3 ИИ (`30`) — 11

| Таблица | Вердикт |
|---|---|
| `ai_providers` · `ai_calls` · `interview_scenarios` · `interview_criteria` · `interview_consents` · `interview_sessions` | нет (6) |
| `interview_turns` · `interview_criterion_scores` · `candidate_summaries` · `ai_review_hints` · `ai_quality_reviews` | нет (5) |

Подтверждение: в репозитории нет ни одного обращения к модели — ни таблиц, ни сервиса, ни
секрета в `.env.example`. Расширение `vector` при этом **уже создано** (см. Р-5), то есть
опора под `library_modules.embedding` готова.

#### 2.4 Библиотека модулей (`31`) — 4

| Таблица | Вердикт | Примечание |
|---|---|---|
| `library_modules` · `library_module_versions` · `library_module_usages` · `library_module_proposals` | нет (4) | `modules` в БД — разделы курса, не библиотека; не переиспользовать имя. Приём «закреплённая версия» в репозитории уже отработан: `course_versions`, `resource_versions`, `lessons.resource_version_id`, `notification_template_versions` |

#### 2.5 Оргструктура (`32`) — 5

| Таблица | Вердикт |
|---|---|
| `org_nodes` | нет (§1.3) |
| `org_node_assignments` | нет — частично перекрыто `user_placements` (`org_unit_id, manager_id, started_at, ended_at, is_primary`) |
| `org_manager_map` | нет (§1.3) |
| `org_structure_snapshots` | нет |
| `org_structure_conflicts` | **др. имя** → `org_conflicts` (§1.2) |

#### 2.6 Жизненный цикл (`33`) — 3

| Таблица | Вердикт | Примечание |
|---|---|---|
| `lifecycle_stages` · `employee_lifecycle_state` · `offboarding_cases` | нет (3) | Ни одного кода этапа (`recruiting`, `onboarding`, `knowledge`, `attestation`, `offboarding`, …) в `server/` и `app/` нет — то есть сквозная проверка П-07.1 на сегодня **проходит тривиально**, и её надо написать до миграции, а не после |

#### 2.7 Хранилище (`34`) — 6

| Таблица | Вердикт |
|---|---|
| `storage_usage_counters` | нет (§1.3) |
| `storage_usage_daily` · `storage_retention_policies` · `storage_deletion_requests` · `storage_pending_uploads` | нет (4) |
| `storage_quota_addons` | нет — **и не создаётся** по решению Р-6 (см. §4) |

#### 2.8 Биллинг (`35`) — 8

| Таблица | Вердикт | Примечание |
|---|---|---|
| `plan_prices` (П) | нет | Цена живёт колонкой `plans.price_uah` — одна валюта, без интервала действия |
| `plan_addons` (П) · `tenant_addons` | нет (2) | — |
| `usage_counters` | нет (§1.3) | — |
| `usage_events` | нет (§1.3) | — |
| `tenant_payments` · `plan_change_requests` · `limit_notices` | нет (3) | Коды `limit_warning` / `limit_exceeded` **уже шлются** (`server/services/usage.ts:75`), но без таблицы открытых предупреждений — дедупликации «одно на ось и уровень» нет |

#### 2.9 Обратная связь по контенту (`36`) — 5

| Таблица | Вердикт |
|---|---|
| `content_issues` · `content_reports` | нет (§1.3) |
| `content_issue_events` · `content_issue_routing_rules` · `content_reporter_stats` | нет (3) |

Проверено отдельно по заданию: таблицы **`content_ratings` в репозитории нет** — ни в БД, ни
в схеме, ни в `docs/02`.

#### 2.10 Проверка, делегирование, время (`37`) — 9

| Таблица | Вердикт | Примечание |
|---|---|---|
| `review_delegations` · `review_routing_rules` · `reviewer_capacity` · `reviewer_absences` · `review_sla_events` · `reviewer_stats_daily` · `content_time_norms` | нет (7) | Очередь проверки сегодня — запрос в `server/services/queue.ts` поверх `attempt_answers` и `workshop_submissions`, эндпоинты `/review/answers`, `/review/submissions`, `/review/workshops`. `workshop_submissions` уже несёт `reviewer_id`, `claimed_at`, `sla_due_at` — половина состояния одного таба |
| `learning_time_sessions` · `learning_time_totals` | нет (§1.3) | — |

#### 2.11 Люди: расширения карточки (`38`) — 8

| Таблица | Вердикт |
|---|---|
| `user_activity_events` | нет (§1.3) |
| `user_activity_daily` | нет |
| `person_notes` | **др. имя** → `user_notes` (§1.2) |
| `person_document_types` · `person_documents` · `absence_norms` · `absence_records` · `person_rating_snapshots` | нет (5) |

### 1.5 Изменения существующих таблиц — 14 `alter table`, 97 колонок

Из 97 заявленных колонок **6 уже существуют**. Одна из 14 таблиц —
`review_queue_items` — **в БД отсутствует как объект вообще**, поэтому `alter` по ней
невыполним (Р-3).

| Таблица | Колонок в пакете | Уже есть | Каких нет | Что делать |
|---|---:|---:|---|---|
| `users` | 16 | **0** | все 16: `kind`, `candidate_state`, `candidate_status_id`, `source`, `source_detail`, `vacancy_id`, `recruiter_id`, `access_until`, `comm_language`, `resume_asset_id`, `converted_from_candidate_at`, `consent_given_at`, `consent_expires_at`, `rating_pct`, `rating_updated_at`, `timezone` | Мигрировать целиком. `hired_at` подтверждён в БД как `date` — пакет прав, повторно не добавляется. Констрейнтов `users_kind_chk` и др. нет, индексов `idx_users_tenant_*` из пакета нет |
| `media_assets` | 19 | **3** | есть `created_at`, `original_name`, `deleted_at`. Нет 16: `origin`, `owner_user_id`, `course_id`, `category_id`, `enrollment_id`, `source_entity`, `source_id`, `lifecycle`, `is_evidence`, `retention_until`, `orphaned_at`, `purge_after`, `deleted_by`, `delete_reason`, `checksum_sha256`, `last_accessed_at` | Близкие колонки уже есть и переиспользуются: `uploaded_by` ≈ `owner_user_id`, `checksum` ≈ `checksum_sha256`. **Решить в фазе 1: переименовать или завести рядом.** Check-констрейнтов на таблице нет ни одного — перечень `origin` (`40` §4) заводится с нуля |
| `review_queue_items` | 21 | — | таблицы нет | См. Р-3: сначала решение «витрина → таблица», потом DDL, потом 21 колонка. `alter` из `37` §3.1 неисполним как написан |
| `tenant_limits` | 10 | **2** | есть `updated_at`, `updated_by`. Нет 8: `billing_period`, `status`, `paid_until`, `grace_until`, `ai_until`, `autorenew`, `currency`, `ai_status` | **Пакет ошибается в исходной форме таблицы**: он предполагает `overrides jsonb`, фактически это явные колонки `users, storage_gb, sms_per_month, api_per_minute, webhooks, active_jobs`. Формулу эффективного лимита (`35` §7.3) переписать под явные колонки или мигрировать на `jsonb` — решение в фазе 1 |
| `plans` | 9 | **1** | есть `sort`. Нет 8: `title_uk`, `tier`, `ai_included`, `ai_term_days`, `addons_allowed`, `is_active`, `valid_from`, `valid_to` | Платформенная, `tenant_id` нет — пакет прав. Но PK — `code`, а не `id`, и лимиты лежат колонками `max_users`, `max_storage_gb`, `max_sms_per_month`, а не `limits jsonb`. Ссылка `plan_prices.plan_id` не встанет без ключа |
| `tenant_usage` | 8 | **0** | `plan_id`, `candidates_active`, `storage_by_category`, `ai_ops`, `sms_out`, `telegram_out`, `integrations_active`, `axes` | `sms_month` ≈ `sms_out`, `storage_bytes` — база для `storage_by_category`. Сбор уже есть (`usage.collect`), расширяется |
| `lesson_progress` | 3 | **0** | `content_seconds`, `discarded_seconds`, `sessions_count` | `seconds_spent` уже есть — «сырая величина», которую `40` §3.1 и просит сохранить. Плюс `last_tick_at`, `video_pct`, `scroll_pct` — heartbeat-механика уже работает |
| `courses` | 2 | **0** | `lifecycle_stage_id`, `stage_locked` | Зависит от `lifecycle_stages` |
| `lessons` | 2 | **0** | `library_module_id`, `library_version_id`; `module_id` **остаётся `not null`** | Снятие `not null` — отдельным шагом, П-11 |
| `attempts` | 2 | **0** | `net_seconds`, `discarded_seconds` | `time_spent_sec` есть |
| `workshop_submissions` | 2 | **0** | `attempt_seconds`, `content_seconds` | `sla_due_at`, `mentor_rating`, `rework_count` есть |
| `trajectory_nodes` | 1 | **0** | `library_version_id` | — |
| `quizzes` | 1 | **0** | `mode` | Есть `kind` и `selection_mode` — проверить, не конфликтует ли `mode='interview'` с `kind` |
| `attempt_answers` | 1 | **0** | `input_mode` | — |

### 1.6 Что сверка схемы изменила в плане пакета

1. **Нумерация миграций `0004`–`0028` из `40` §5 недействительна.** В репозитории
   последняя — `0052`, стиль имён `NNNN_<область>_<что>.sql`. Пакет ещё и опирается на
   несуществующий `0001_foundation.sql`: расширения создаёт `0000_youthful_warhawk.sql`.
2. **Миграция `0004_extensions.sql` не нужна** — `ltree` и `vector` уже созданы (Р-5).
3. **Две миграции пакета схлопываются в `alter` существующих таблиц**: `org_conflicts` и
   `user_notes` вместо `org_structure_conflicts` и `person_notes`.
4. `scales` / `scale_levels` существуют и используются — из порядка миграций выпадает целый
   узел зависимостей (Р-4).

---

## 2. Патчи — `docs/v2/39-patches.md`

### 2.1 Сколько патчей на самом деле

`HANDOFF` §2 и §8 говорят о «25 патчах». Фактически в `39-patches.md` **19 номеров**:
П-01, П-02, П-03, П-04, П-05, П-07, П-11, П-12, П-13, П-14, П-15, П-16, П-17, П-20, П-21,
П-22, П-23, П-24, П-25. Номера 06, 08, 09, 10, 18, 19 не заняты — нумерация идёт по номеру
**базового документа**, а не подряд. Вместе с подпунктами (П-12.1…4, П-16.1…4, П-24.1…5)
получается **29 проверяемых пунктов**; вердикт ниже есть у каждого.

> [исправлено, пересчёт по документу: 19 номеров П-01…П-25 с пропусками, 29 пунктов с
> подпунктами] Ранее (в `HANDOFF` §2): «каждый из 25 патчей».

### 2.2 Общее правило вердикта

Ни один базовый документ (`docs/00-…34-…`) **не ссылается на пакет `docs/v2`** — проверено
`grep -rln "docs/v2" docs/*.md`, единственное упоминание во всём репозитории вне пакета — в
`CLAUDE.md`. Значит, **как правка базового документа не применён ни один из 19 патчей.**

Но часть требований патчей **уже выполнена кодом** независимо от пакета. Поэтому вердикт
двухчастный: «патч как правка документа» и «требование по существу».

### 2.3 Вердикты

| Патч | Приоритет | Вердикт | Подтверждение и что делать |
|---|---|---|---|
| **П-01** новые скоупы | блокирующий | **не применён** | `shared/domain/roles.ts` → `SCOPES` + `SCOPE_GROUPS` (10 групп, ~60 скоупов): ни одного из `candidate.*`, `vacancy.*`, `interview.*`, `library.*`, `org.structure.*`, `lifecycle.*`, `storage.manage`, `billing.*`, `content_issue.*`, `review.delegate`, `person.note.*`, `absence.manage`. Механика своя есть: `roles.scopes` — массив, редактор ролей работает, скоуп добавляется без миграции |
| **П-02** ссылка на дельту в `02` | блокирующий | **не применён** | `grep "v2\|Дельта" docs/02-data-model.md` → 0. Вторая половина патча **уже верна фактически**: `users.hired_at` в БД — `date`, повторно никем не добавляется |
| **П-03** карта модулей в `03` | обязательный | **не применён** | `docs/03-modules.md` не знает об одиннадцати новых модулях |
| **П-04** ссылка на дельту API + публичный контур | обязательный | **применён частично по существу, не применён как правка** | Публичный контур **уже работает**: `server/api/v1/public/guest-page.get.ts`, `public/signup.post.ts`, `public/mystery/[token]/`. Но путь — `/api/v1/public/*`, а пакет требует `/api/public/v1` (коллизия путей, §4.2). `docs/04-api.md` публичный контур не описывает |
| **П-05** навигация + 10 экранов | обязательный | **не применён** | Ни `/candidates`, ни `/vacancies`, ни `/library/modules`, ни `/org-structure`, ни `/offboarding`, ни `/storage`, ни `/settings/lifecycle`, ни `/j/:token`. `/org-units` и `/org-conflicts` есть как API |
| **П-07** этапы внедрения + 4 сквозные проверки | обязательный | **не применён** | `docs/07-stages.md` не переписан. Свои сквозные проверки в репозитории есть и работают — `tests/integration/rls.spec.ts`, `tests/integration/schema-parity.spec.ts`; четыре проверки пакета к ним пристраиваются, а не заводятся с нуля. Проверка П-07.1 (коды этапов) сейчас проходит тривиально — этапов нет |
| **П-11** `lessons.module_id` nullable | обязательный | **не применён** | В БД `lessons.module_id` — `is_nullable = NO`. Ровно тот случай, от которого патч предостерегает |
| **П-12.1** тип вопроса «Лінійна шкала» | обязательный | **применён частично** | В опросах есть: `POLL_QUESTION_KINDS` содержит `scale`, `pollQuestionSchema.scaleId` ссылается на `scales` (`shared/enums.ts:82`, `shared/schemas/assessment.ts:147`). В тестах — нет: `QUESTION_KINDS` — 10 значений без линейной шкалы. Патч сужается до «добавить в тесты» |
| **П-12.2** анонимный опрос + подсказка | обязательный | **применён частично** | `surveys.is_anonymous` **существует** в БД. «Підказка для відповіді» в `pollQuestionSchema` нет. Влияние анонимности на хранение (не только на показ) надо подтвердить тестом — сейчас не подтверждено |
| **П-12.3** жалоба не блокирует попытку | обязательный | **не применён** | Модуля жалоб нет (§1.4, 2.9) |
| **П-12.4** второй вход в «Перерахувати» | обязательный | **не применён** | Пересчёт по тесту есть в отчётах, второй точки входа нет, потому что нет карточки жалобы |
| **П-13** очередь проверки | обязательный + блокирующее замечание | **не применён** | `docs/13-workshops.md` не правлен. Фактически: очередь — **запрос**, а не объект БД (`server/services/queue.ts`, эндпоинты `/review/answers`, `/review/submissions`, `/review/workshops`). Ни таблицы, ни представления, ни matview. Блокирующее замечание (повышение до таблицы) — **открыто**, см. Р-3 |
| **П-14** сертификаты и офбординг | желательный | **не применён** | Зависит от `lifecycle_stages` |
| **П-15** назначение не сохраняет ключи выключенных возможностей | блокирующий | **не применён** | Опора готова: `task_parameters`, `task_parameter_values`, `server/services/taskParams.ts` — параметры назначения уже вынесены в отдельный механизм, фильтр по возможностям этапа вставляется в одну точку |
| **П-16.1** фильтр по `users.kind` | **блокирующий** | **не применён и пока не требуется — но цена измерена** | `users.kind` в БД нет, поэтому сегодня все выборки корректны. Цена патча: **59** обращений `from(users)` в 26 файлах `server/services/*.ts` плюс **39** сырых `from users` в SQL — около **98 мест**. Рекомендация пакета (два репозиторных метода вместо ручного фильтра) — единственный реалистичный путь. Патч обязан идти **той же миграцией**, что и `users.kind` |
| **П-16.2** четыре блока карточки | блокирующий (в составе П-16) | **применён частично** | Заметки — `user_notes` есть; лента активности — есть сырьё (`task_access_log`, `pass_events`), блока нет; документы и нормы отсутствий — нет; блок «Етап» — нет |
| **П-16.3** колонка рейтинга | желательный | **не применён** | `users.rating_pct` нет |
| **П-16.4** `resolveManager()` | блокирующий (в составе П-16) | **не применён** | Руководитель берётся напрямую из `locations.manager_id` — `server/services/people.ts:294` и `:479` (адресат уведомления `user_blocked`). Плюс `user_placements.manager_id` и `functional_chiefs` — **три источника без единой функции**. Флага тенанта `org_structure_is_source_of_truth` нет (`tenants` — `id, branding, settings, plan, locale, timezone, status, …`) |
| **П-17.1** узел траектории → библиотечная версия | обязательный | **не применён** | `trajectory_nodes.library_version_id` нет |
| **П-17.2** сохранить ветвление графа | обязательный | **требование выполнено, правка не внесена** | `TRAJECTORY_NODE_KINDS` = `start, finish, task, and, or, delay, stop_delay, branch, mentor` (`shared/enums.ts:28`). Ветвление сохранено и даже расширено. Патч сводится к строке в `docs/17` — чтобы никто не «упростил» при сверке со вторым эталоном |
| **П-20** шкалы обслуживают рекрутинг | обязательный | **блокер снят, правка не внесена** | `scales` и `scale_levels` **существуют** (`scales`: `name, description, kind, display_as`; `scale_levels`: `label, value, range_from, range_to, characteristic, show_in_reports, sort_order`), эндпоинт `/scales`, сервис `server/services/scales.ts`, уже используются опросами и компетенциями. «Перенос минимального среза вперёд» больше не нужен — **это главная новость сверки для фазы 1** |
| **П-21** две разные «новости» | обязательный | **применён частично** | Корпоративная лента тенанта есть и не под угрозой: `news`, `news_views`, `/news`. `platform_announcements` нет (`platform_admins`, `platform_audit`, `platform_sessions` — есть). Вторая половина патча (публичная оргструктура = витрина из `32`) **уже соблюдена**: дерево одно, `server/services/orgTree.ts`, двух реализаций не появилось |
| **П-22** двенадцать новых отчётов | желательный | **не применён** | Реестр отчётов: `readiness, readiness-people, course, overdue, attempts, activity, mentors, personal, progress, content, questions, activity-extra` + `assessment, attendance, checklists, development, knowledge, notifications, people, programs`. Ни одного из двенадцати. Опора готова и дешёвая: единый каркас `server/services/reportFrame.ts` (`FRAME_COLUMNS`) и конструктор `/reports/builder` |
| **П-23** новые коды уведомлений | обязательный | **не применён** | Реестр шаблонов есть (`notification_templates`, `notification_template_versions`, `/settings/notification-templates`). `limit_warning` и `limit_exceeded` **действительно уже существуют** (`server/services/notifications.ts:139`, `usage.ts:75`) — пакет прав, дублировать нельзя |
| **П-24.1** шесть блоков настроек компании | обязательный | **применён частично — 2 из 6** | Есть: выбор языков (`settings.localesEnabled`, `shared/schemas/settings.ts:156`), API-токен тенанта (`api_tokens` с `token_hash`/`prefix`/`scopes`, `tenant_secrets`, `/settings/api-tokens`). Нет: колонтитул с логотипом в материалах (`tenants.branding` есть как опора), 2FA/TOTP (`grep totp` → 0), подгрузка таблиц при прокрутке, нормы отпуска |
| **П-24.2** объявления платформы | обязательный | **не применён** | `platform_announcements` нет |
| **П-24.3** посада → курси за замовчуванням | обязательный | **не применён, но механизм готов** | `automation_rules` + `automation_rule_dimensions` с `dimension` из `position, org_unit, city, tag, any` — **`position` уже поддержан**. Патч прав: отдельной таблицы не нужно, это правило автоматизации |
| **П-24.4** тарифы → `35` | обязательный | **не применён** | Панель оператора и лимиты есть (`/platform/tenants`, `/settings/usage`, `tenant_limits`, `tenant_usage`, `plans`), раздел в `docs/24` на `35` не заменён |
| **П-24.5** `position_groups` | обязательный | **не применён** | Есть `position_levels`, `position_profiles`, `position_profile_positions`, `position_role_map` — группы должностей среди них нет |
| **П-25.1** одиннадцать осей лимитов | обязательный | **не применён; исходная посылка патча неверна** | Пакет пишет «три оси» — фактически **шесть**: `users, storageGb, smsPerMonth, apiPerMinute, webhooks, activeJobs` (`server/services/tenantLimits.ts:41`). Патч переписывается: 6 → 11, а не 3 → 11 |
| **П-25.2** обучение не останавливается лимитами | обязательный | **требование соблюдено, на новые оси не распространено** | Жёсткие лимиты (диск, SMS) проверяются в момент операции, обучение ими не останавливается (`server/services/usage.ts` — шапка). Новых осей (ИИ, хранилище с досылкой) нет, распространять пока не на что |
| **П-25.3** публичный контур `/api/public/v1` | обязательный | **механизм реализован, путь другой, описания нет** | `server/services/mystery.ts:86` `publicForm()` — ровно схема патча: токен → `tenant_id` → `withTenant(tenant_id, created_by, …)`, без сессии. То есть «как проходить изоляцию без сессии» в репозитории **уже решено и работает**. Остаётся описать и переиспользовать; путь согласовать (§4.2) |

### 2.4 Счётчики по патчам

| Вердикт | Пунктов (из 29) |
|---|---:|
| Применён полностью | **0** |
| Применён частично / требование выполнено кодом без правки документа | **10** — П-04, П-12.1, П-12.2, П-16.2, П-17.2, П-20, П-21, П-24.1, П-25.2, П-25.3 |
| Не применён | **19** |
| Потерял смысл | **0** (но два изменились по содержанию: П-20 лишился блокирующей части, П-25.1 — неверной посылки) |

По 19 номерам (без подпунктов): 0 применено, 8 частично, 11 не применено.

**П-16.1 — блокирующий, статус:** не применён, и это **корректно** — колонки `users.kind`
ещё нет. Риск не материализован. Но цена измерена (≈98 мест обращения к `users`), и
требование «в одной миграции с `users.kind`» остаётся в силе как главный инвариант фазы 3.

---

## 3. API

Сверялось: `docs/v2/41-api-delta.md` §2 (сводка по документам пакета) и §3 (публичный
контур) против дерева `server/api` — **603 файла, все под `server/api/v1/**`** — плюс
`server/routes/` (5 файлов: `health`, `ready`, `metrics`, `c/[token]`, `tg/go`) и
`docs/04-api.md`.

Проверка отсутствия делалась `grep` по всему `server/`, а не по памяти. Слова `vacanc`,
`interview`, `billing`, `offboarding`, `content-issue`, `org-structure`, `time-norm`,
`absence`, `person-document`, `delegat` **не встречаются ни в одном файле сервера**;
`candidate` — один раз в `server/services/password.ts` (не по теме), `lifecycle` — один раз
в `server/services/reportExports.ts` (не по теме).

### 3.1 Сводка по группам

| Группа (документ) | Заявлено | Тот же путь | Другой путь | Нет |
|---|---:|---:|---:|---:|
| 2.1 Кандидаты `28` | 22 | 0 | 0 | 22 |
| 2.2 Вакансии `29` | 33 | 0 | 0 | 33 |
| 2.3 ИИ-собеседование `30` | 31 | 0 | 0 | 31 |
| 2.4 Библиотека модулей `31` | 20 | 0 | 0 | 20 |
| 2.5 Оргструктура `32` | 18 | 0 | **6** | 12 |
| 2.6 Жизненный цикл `33` | 12 | 0 | 0 | 12 |
| 2.7 Хранилище `34` | 18 | 0 | **4** | 14 |
| 2.8 Тариф и лимиты `35` | 20 | **2** | **2** | 16 |
| 2.9 Обратная связь `36` | 16 | 0 | **1** | 15 |
| 2.10 Проверка и время `37` | 21 | **1** | **1** | 19 |
| 2.11 Карточка человека `38` | 23 | **4** | 0 | 19 |
| **Закрытый контур, итого** | **234** | **7** | **14** | **213** |
| Публичный контур `/api/public/v1` (§3 пакета) | 5 | 0 | 0 | 5 |
| **Всего** | **239** | **7** | **14** | **218** |

**Реализовано 21 из 239 — 8,8 %.** Пять подсистем из одиннадцати отсутствуют целиком
(кандидаты, вакансии, ИИ, библиотека модулей, жизненный цикл/офбординг), как и весь
публичный контур пакета.

### 3.2 Что именно уже есть — поимённо

**Тем же путём — 7**

| Заявлено | Файл | Оговорка |
|---|---|---|
| `GET /platform/tenants/:id/limits` | `server/api/v1/platform/tenants/[id]/limits.get.ts` | — |
| `PUT /platform/tenants/:id/limits` | `platform/tenants/[id]/limits.put.ts` | Оси уже есть (`shared/schemas/platform.ts:11–18`), но требования `35` «причина обязательна» в схеме нет |
| `GET /review/queue` | `review/queue.get.ts` | Одна очередь; четырёх табов и фильтров по филиалу/треку/`subject_kind` нет |
| `GET /people/:id/activity` | `people/[id]/activity.get.ts` | **Контракт другой:** `personActivity()` (`server/services/people.ts:727`) отдаёт последние 100 записей `audit_log`, а не «дни · события · уровни за год». Скоуп `people.view`, а не `person.activity.view_others` |
| `GET /people/:id/notes` | `people/[id]/notes.get.ts` | Скоуп `people.edit`; записи в `audit_log` при чтении (`38` §5.1) нет |
| `POST /people/:id/notes` | `people/[id]/notes.post.ts` | Без `visibility`/`category` (см. §1.2) |
| `GET /reports/activity` | `reports/[name].get.ts`, ветка `case 'activity'` | Это DAU/сессии (`services/reports.ts:139`), а не «Навчальна активність» человека — совпало имя, не смысл |

**Под другим путём — 14**

| Заявлено | Фактически |
|---|---|
| `GET /org-structure/tree` | `org/tree.get.ts` |
| `POST /org-structure/nodes` | `org-units/index.post.ts` |
| `PUT /org-structure/nodes/:id` | `org-units/[id].patch.ts` (метод другой — PATCH) |
| `POST /org-structure/nodes/:id/assignments` | `people/[id]/placements.post.ts` |
| `GET /org-structure/conflicts` | `org-conflicts/index.get.ts` (сверх пакета — `org-conflicts/[id]/placements.get.ts`) |
| `POST /org-structure/conflicts/:id/resolve` | `org-conflicts/[id]/resolve.post.ts` |
| `GET /storage/summary` | `settings/usage.get.ts` — тариф, лимиты, история 30 сборов; без `driftBytes` и разбивки по `origin` |
| `POST /storage/upload-intent` | `media/upload-url.post.ts` + `media/[id]/complete.post.ts`; `origin` и режим `{deferred:true}` отсутствуют |
| `GET /storage/files/:id` | `media/[id]/index.get.ts` |
| `GET /storage/files/:id/download` | он же с `?redirect=1` (`docs/04-api.md` §4.15) |
| `GET /billing/usage` | `settings/usage.get.ts` |
| `GET /platform/plans/:id` | `platform/plans.get.ts` — только список, элемента и `PUT` нет |
| `POST /content-issues/reports` | `knowledge/[id]/feedback.post.ts` — только материал базы знаний, без слияния дублей |
| `POST /learning/time/beat` | `learning/enrollments/[id]/lessons/[lessonId]/tick.post.ts`, `enrollments/[id]/items/[itemId]/tick.post.ts`, `meetup-sessions/[id]/tick.post.ts`. `tickSchema` (`shared/schemas/content.ts:108`) — `{seconds ≤ 60, scrollPct, videoPct, blocksState, device}`, без `(session_key, seq)` и без пакетного варианта |

### 3.3 Заделы, которые ускоряют реализацию

Не засчитаны как «есть», но снимают проектирование:

- **Шкалы для критериев вакансии** — `scales/{index.get,index.post,[id].get,[id].put,[id].delete}.ts` готовы.
- **Каркас OAuth-интеграций** повторяет форму `job_board_accounts` один в один:
  `integrations/[provider]/{auth-url,callback,disconnect,status}` +
  `settings/integrations/[provider]/{index.get,index.put,test.post,disconnect.post}`.
- **Версии и «где используется»** — `resources/[id]/{versions,duplicate,archive,restore,publish}`,
  `trajectories/[id]/usages.get.ts`, `automation-rules/[id]/usages.get.ts`,
  `position-profiles/[id]/coverage.get.ts` — готовый образец для `library_module_versions`
  и `library_module_usages`.
- **Публичный токен-маршрут** — `server/routes/c/[token].get.ts` (сертификат, HTML,
  `X-Robots-Tag: noindex`) — образец для `GET /public/candidate-summaries/:token`.
- **Взять/отпустить работу** — `review/workshops/[id]/{claim,grade}`,
  `review/submissions/[id]/{claim,release,grade,comments}`. Нет только «передать другому».
- **CSV-импорт** — `people/import/*` (8 эндпоинтов) как образец для `POST /org-structure/import`.
- **Лимит объёма** уже проверяется: `server/services/media.ts:135` → код `storage_limit`.

### 3.4 `docs/v2/41` §8 — коллизии кодов и путей

| Пункт | Вердикт | Чем определяется |
|---|---|---|
| **8.1** П-01 объявляет 24 скоупа, приводит 35 имён, в модульных документах их 68 | **открыт; репозиторием не проверяется, но форма известна** | Ни одного скоупа пакета в `shared/domain/roles.ts` нет (§2.3, П-01) — сверять не с чем. Репозиторий снимает часть тревоги: скоуп — строка в массиве `roles.scopes`, добавляется без миграции, экран ролей группирует их через `SCOPE_GROUPS`. Коллизия `storage.manage` (`35` §2) против `storage.view/delete/policy/addon` (`34` §2) — чисто внутренняя, решать в фазе 1 по правилу П-01 «побеждает модульный документ», то есть в пользу `34` |
| **8.2.1** `consent.required` 422 vs 409 | **открыт**, пока безвреден | Кода `consent.required` в `server/` нет; единственное `consent` — `birthdayConsent` (`server/db/schema/people.ts:27`). Коллизия бумажная, чинится правкой до реализации |
| **8.2.2** `limit_exceeded` vs именованные `limit.*` | **частично закрыт в пользу `35`** | Репозиторий уже использует единый `limit_exceeded` / `limit_warning` (`server/services/usage.ts:75`, `notifications.ts:140`). Но `details.axis` нет: payload — `{resource, used, limit, pct}`, где `resource` — человекочитаемая метка, а не машинная ось. Форму `details.axis` ещё вводить |
| **8.2.3** `already_decided` в `30` и `31` | **открыт** | Ни interview, ни library в коде нет |
| **8.2.4** `file.too_large` vs `file_too_large` | **закрыт третьим вариантом** | Репозиторий не использует ни одно из двух написаний: `services/media.ts` отдаёт `too_big` / `resource_too_big`, наружу — `media.too_big` (`media/upload-url.post.ts`, `docs/04-api.md` §4.15). Выбор не из двух, а из трёх; соглашение де-факто — `media.too_big` |
| **8.2.5** `VALIDATION_FAILED` UPPER_SNAKE в `36` | **закрыт фактически** | Повсеместно `validation_failed` с `details.issues` — десятки вхождений (`reports/[name].get.ts`, `platform/tenants/[id]/limits.put.ts`, `comments/index.post.ts`). Править надо `36`, а не код |
| **8.2.6** `absence.range_invalid` vs `absence_range_invalid` | **открыт** | Слова `absence` в `server/` нет ни в одном файле |
| **8.2.7** Пять написаний «нет скоупа» | **закрыт фактически** | В `server/api` ровно одно написание — `'forbidden'`, 25 файлов. Уточняющие коды `30`, `31`, `38` противоречат коду |
| **8.2.8** Обрывки `409 limit`, `410 expired` | **открыт** | Ни того, ни другого в коде нет |
| **8.3.1** Два контракта `/storage/files` | **открыт, но поле пустое** | `/storage/*` не реализован ни в одном варианте. Находка сверх пакета: `docs/04-api.md` §4.15 объявляет `DELETE /media/:id`, **а обработчика в `server/api/v1/media/` нет** — мягкого удаления медиа сейчас не существует ни под каким путём |
| **8.3.2** `/public/candidate-summaries/:token` вне публичного контура | **открыт и усугублён** | `/api/public/v1` не существует, а в `/api/v1` уже живут четыре бессессионных маршрута (`public/guest-page`, `public/signup`, `public/mystery/[token]` ×2) плюс HTML-маршрут `server/routes/c/[token].get.ts`. **Правило «единственное место без сессии» неверно на текущем коде ещё до пакета** — это надо зафиксировать в `29` и `39`, а не переносить один эндпоинт |
| **8.3.3** Два входа в загрузку файла | **открыт** | Реализован только старый: `media/upload-url.post.ts` → `media/[id]/complete.post.ts`; `origin` в `uploadUrlSchema` нет. `upload-intent` отсутствует |
| **8.3.4** Два реестра отсутствий | **открыт** | Ни `/review/absences`, ни `/people/:id/absences`, ни `/absence-norms` |
| **8.3.5** Кросс-документное владение `/candidates/*` | **открыт** | `/candidates` не существует; отсылку в `28` §10 добавить |
| **8.3.6** `35` пишет пути с префиксом `/api/v1` | **открыт (только документ)** | Nitro собирает маршруты из дерева `server/api/v1/**`, префикс задаётся каталогами — строки `35` §10 дали бы `/api/v1/api/v1/…`. Правка в `35` |
| **8.3.7** `/review/queue` против трёх базовых очередей | **частично закрыт репозиторием, не закрыт документом** | В коде **одновременно** `review/queue.get.ts` и базовые `review/answers/index.get.ts`, `review/workshops/index.get.ts` (+ `review/submissions/*`), при этом `docs/04-api.md` §4.7 про `/review/queue` не знает вовсе, а `/review/checklists` помечен там как долг и не реализован. «Построит и то и другое» уже произошло; вопрос о четырёх табах решать с учётом существующего `review.queue` |
| **8.4** Неполные секции 10 | **не закрыт** | Из отчётов пакета в коде есть только `GET /reports/activity`, и с другим смыслом. Реестр: `readiness, readiness-people, course, overdue, attempts, activity, mentors, personal, progress, content, questions, activity-extra` + файлы `assessment, attendance, checklists, development, knowledge, notifications, people, programs`, `tasks/[contentType]`, конструктор `reports/builder/*` |
| **8.5** Расхождения в числах и именах скоупов | **частично закрыт фактом** | П-04 подтверждён: ссылки на `41-api-delta.md` в `docs/04-api.md` нет, публичный контур там не описан. Остальные три строки — внутренние расхождения пакета, репозиторием не проверяются; правило «побеждает имя из модульного документа» остаётся |
| **8.6** Дубли кодов уведомлений (4 пары) | **1 из 4 закрыта кодом** | Пара 3 (`candidate.limit_warning` / `limit_warning`) решена в пользу `35`: `usage.ts` шлёт единый код с дедупликацией по ресурсу, кандидатского кода нет. Пары 1, 2, 4 открыты — `addon`, `ai_ops_exhausted`, `vacancy.*` в коде отсутствуют |
| **8.7.1** Окно частотных ограничений закрытого контура не описано | **закрыт фактически** | Репозиторий уже отвечает: окно считается **на токен интеграции** — `server/services/apiTokens.ts:60`, `hitRateLimit('api:' + token_id, perMinute, 60)`, значение берётся из `tenant_limits.api_per_minute`. Фиксированное окно, счётчики в таблице `rate_limits` (`server/services/rateLimit.ts`). Остаётся записать это в `35` §7.1, а не решать заново |
| **8.7.2** Какие эндпоинты доступны по Bearer, а какие только по сессии | **частично закрыт** | Механизм работает: `server/middleware/01.session.ts:43` принимает `Authorization: Bearer`, `validateBearer()` даёт `AuthContext` со скоупами токена, CSRF для Bearer пропускается (`02.csrf.ts:13`). То есть разграничение уже идёт **по скоупам токена**, а не по списку путей. Открыто одно: пакет предлагает запретить `/platform/*` и чувствительные чтения (`GET /people/:id/notes`) целиком — этого правила в коде нет |
| **8.7.3** Вебхуки наружу: события пакета не добавлены | **открыт** | `WEBHOOK_EVENTS` (`server/services/webhooks.ts:18`) — 7 значений: `enrollment.completed, attempt.passed, attempt.failed, certificate.issued, assignment.overdue, user.created, notice.acknowledged`. Ни `candidate.hired`, ни `vacancy.application_received`, ни `offboarding.completed`. Инфраструктура готова (`webhook_endpoints`, `webhook_deliveries`, `/settings/webhooks`), событие добавляется строкой в перечень |
| **8.7.4** Пишется ли скачивание файла-доказательства в `audit_log` | **открыт, опасение подтверждено** | `server/api/v1/media/[id]/index.get.ts:17–18` — ветка `?redirect=1` отдаёт `302` на подписанную ссылку **без записи в журнал**. Сейчас безвредно (доказательств как отдельного класса нет), но вместе с `media_assets.is_evidence` (`40` §3.3) станет дырой в §9 документа `34` «кто снёс доказательства» |

### 3.5 Счётчики по API

| Показатель | Значение |
|---|---:|
| Эндпоинтов заявлено в пакете | 239 (234 закрытый контур + 5 публичный) |
| Реализовано тем же путём | 7 |
| Реализовано под другим путём | 14 |
| **Реализовано всего** | **21 (8,8 %)** |
| Отсутствует | 218 |
| Подсистем отсутствует целиком | 5 из 11 + публичный контур |
| Пунктов в `41` §8 | 23 (8.1 · 8.2.1–8.2.8 · 8.3.1–8.3.7 · 8.4 · 8.5 · 8.6 · 8.7.1–8.7.4) |
| Закрыто фактическим состоянием | 4 (8.2.5, 8.2.7 — в пользу базового ТЗ; 8.2.4 — третьим вариантом `media.too_big`; 8.7.1 — окно на токен) |
| Закрыто частично | 5 (8.2.2, 8.3.7, 8.5, 8.6, 8.7.2) |
| Открыто | 14 |
| Из них **усугублено** кодом | 2 (8.3.2 и 8.3.7 — обе коллизии существуют в репозитории до пакета) |
| Найдено сверкой сверх §8 | 2 (префикс `/api/v1/public/*`; `DELETE /media/:id` без обработчика) |

---

## 4. Противоречия

### 4.1 `docs/v2/40` §9 — риски Р-1…Р-11

| № | Суть | Вердикт | Обоснование |
|---|---|---|---|
| **Р-1** | Перечень `media_assets.origin` пересобирается документом `38` и теряет значение из `30` | **открыт** | В БД у `media_assets` **нет ни колонки `origin`, ни одного check-констрейнта** (`pg_constraint` по `contype='c'` → пусто). Конфликт двух редакций перечня ничем не снят; решение пакета (собирать один раз отдельной миграцией, §4.2 документа `40`) остаётся верным и обязательным. Правка в `38` §3.2 не сделана |
| **Р-2** | `38` описывает `28` в редакции, которой нет; `hired_at` | **закрыт по существу, косметика открыта** | `users.hired_at` в БД — `date`, повторного добавления нет ни в одной из 53 миграций. Факт, о котором спорят документы, разрешён в пользу `28`. Остаётся снять предписание из `38` §3.1 — правка на одну строку |
| **Р-3** | `review_queue_items`: витрина или таблица | **открыт, и стал острее** | В БД нет **ни таблицы, ни представления, ни матвью** с таким именем (проверено `information_schema.tables`, `information_schema.views`, `pg_matviews` — во всей схеме `public` ноль представлений). Очередь собирается запросом в `server/services/queue.ts`. То есть «витрина» реализована как запрос на лету, и повышение до таблицы — не изменение существующего объекта, а **создание с нуля**. Это упрощает решение: миграции-конвертации не нужно, но DDL надо внести в `docs/02` (сейчас таблицы там нет вовсе). Решение — в `44-decisions.md` |
| **Р-4** | `candidate_scores` зависит от `scales`/`scale_levels` из поздней стадии | **закрыт развитием репозитория** | `scales` и `scale_levels` **существуют в БД**, обслуживаются `server/services/scales.ts` и эндпоинтом `/scales`, уже используются опросами (`pollQuestionSchema.scaleId`), чек-листами (`checklists.scaleId`) и компетенциями. Миграция «0014» выполнится. Обсуждение «переносить срез вперёд или нет» (П-20, README «Что нужно решить» п. 1) **снимается с повестки фазы 1** |
| **Р-5** | `ltree` и `vector` не создаются ни одной миграцией | **закрыт развитием репозитория** | `0000_youthful_warhawk.sql` строки 1–2: `CREATE EXTENSION IF NOT EXISTS ltree` и `CREATE EXTENSION IF NOT EXISTS vector`. `select extname from pg_extension` → `ltree, plpgsql, vector`. Миграция `0004_extensions.sql` из `40` §5 **не нужна**. Попутно: посылка пакета о `0001_foundation.sql` с `pgcrypto`/`pg_trgm` не соответствует репозиторию — этих расширений нет и они не нужны (`gen_random_uuid()` в PG 16 встроена) |
| **Р-6** | Два механизма докупки места, две формулы | **открыт; решение пакета остаётся верным, но опирается на неверную форму таблицы** | Ни `storage_quota_addons`, ни `tenant_addons` в БД нет — выбирать можно свободно. Решение «оставить `tenant_addons`, 73 → 72 таблицы» принимается. **Но:** `tenant_limits` в репозитории — не `overrides jsonb`, а явные колонки (`users, storage_gb, sms_per_month, api_per_minute, webhooks, active_jobs`), и колонки `storage_bytes` действительно нет — пакет прав в наблюдении и неправ в описании того, что есть вместо неё. Формула `35` §7.3 переписывается под явные колонки. В фазу 1 |
| **Р-7** | Три числа категорий разбивки хранилища (8 / 10 / 7) | **открыт** | `tenant_usage.storage_by_category` не существует, `lifecycle_stages` не существует — фактического значения, которое можно было бы взять за истину, в репозитории нет. Решение пакета (источник — `33`, восемь этапов + `other` = 9 ключей) остаётся предложением и переносится в `44-decisions.md` |
| **Р-8** | `38` объявляет шесть таблиц, а создаёт восемь | **открыт, но безвреден** | Ни одной из восьми в БД нет, DDL не исполнялся. Счётная ошибка в тексте `38` §3.7 — правка на одно слово. §2 и §6 документа `40` учитывают все восемь; сверка это подтверждает (пересчитано поимённо в §1.4) |
| **Р-9** | Пакет ссылается на `39-patches.md`, которого нет | **закрыт** | `docs/v2/39-patches.md` существует в пакете (368 строк, 19 номеров). Ссылки из `28` §3.1 (П-16.1), `28` §5.5 (П-24.3) и `30` §3.7 (П-30.1) разрешаются. **Остаток риска:** рекомендация «внести П-16.1 поимённым перечнем затронутых выборок, а не общим правилом» **не выполнена** — в `39` он остался общим правилом. Измеренная цена (≈98 мест) делает перечень обязательным, а не желательным. В фазу 1 |
| **Р-10** | Четыре FK объявлены в таблицах полей, но отсутствуют в DDL | **открыт** | Ни `users.candidate_status_id`, ни `users.vacancy_id`, ни `review_queue_items.*` в БД нет — проверить нечего, риск целиком впереди. Развязки из `40` §5 (миграции «0013» и «0022») остаются нужными; девятый контрактный тест на четыре именованных констрейнта надо написать |
| **Р-11** | Шесть мягких полиморфных ссылок без FK | **открыт; прецедент в репозитории есть** | Ни одной из шести пар в БД нет. Но приём в репозитории уже применяется и обкатан: `task_status_log.content_type/content_id`, `task_access_log.content_type/content_id`, `pass_events.subject_type/subject_id` — с общим перечнем `CONTENT_TYPES` (`shared/enums.ts`, 12 значений) и без FK. Правило «что делать, когда цель удалена» для них тоже не описано — то есть вопрос шире пакета. Решать одинаково для всех: и для шести пакетных, и для трёх существующих |

**Счёт по §9:** закрыто развитием репозитория — **3** (Р-4, Р-5, Р-9); закрыто по существу с
косметическим остатком — **1** (Р-2); открыто — **7** (Р-1, Р-3, Р-6, Р-7, Р-8, Р-10, Р-11).

### 4.2 `docs/v2/41` §8 — коллизии кодов и путей

Разбор всех 23 пунктов (8.1 · 8.2.1–8.2.8 · 8.3.1–8.3.7 · 8.4 · 8.5 · 8.6 · 8.7.1–8.7.4) —
в §3.4 этого документа (ось API), счётчики — в §3.5. Кратко: закрыто фактическим состоянием
**4**, частично **5**, открыто **14**, из них две коллизии (8.3.2 и 8.3.7) **существуют в
репозитории ещё до пакета** и потому усугублены.

Две коллизии обнаружены сверкой и в §8 пакета отсутствуют, поэтому фиксируются здесь:

| Коллизия | Заявлено | Фактически | Что делать |
|---|---|---|---|
| Префикс публичного контура | `/api/public/v1` (`29` §10, П-04, П-25.3) | `/api/v1/public/*` — `guest-page`, `signup`, `mystery/[token]` ×2; префикс задаётся деревом каталогов Nitro, а не строкой | Победить должен **существующий** путь: механизм изоляции по токену обкатан (`server/services/mystery.ts:86` — токен → `tenant_id` → `withTenant`). Править `29` §10, П-04 и П-25.3, а не переносить работающие ручки |
| `DELETE /media/:id` объявлен, но не реализован | `34` строит на нём мягкое удаление файла | `docs/04-api.md` §4.15 объявляет эндпоинт, обработчика в `server/api/v1/media/` **нет** | Долг базового ТЗ, вскрытый сверкой. Закрывается вместе с `media_assets.deleted_at`/`deleted_by`/`delete_reason` (`40` §3.3) — одной работой, не двумя |

---

## 5. Что из пакета отменяется

| Что | Почему | Взамен |
|---|---|---|
| Миграция `0004_extensions.sql` (`40` §5) | `ltree` и `vector` созданы в `0000_youthful_warhawk.sql` | Ничего |
| Таблица `org_structure_conflicts` | Существует как `org_conflicts` и уже наполняется импортом людей | `alter table org_conflicts` на 4 колонки + расширение перечня `kind` |
| Таблица `person_notes` | Существует как `user_notes` | `alter table user_notes` на 7 колонок и 4 констрейнта |
| Таблица `storage_quota_addons` (`34` §3.3) | Решение Р-6: один механизм докупки | `tenant_addons` с `addon_code='storage_pack'`; при необходимости — представление |
| Блокирующая часть П-20 («перенести минимальный срез `scales` вперёд») | `scales` / `scale_levels` уже существуют и используются тремя модулями | Остаётся только строка в `docs/20`, что реестр шкал обслуживает и рекрутинг |
| Вопрос №1 из README «Что нужно решить» (`scales` в поздних этапах) | Тот же | Снят с повестки фазы 1 |
| Нумерация миграций `0004`–`0028` (`40` §5) целиком | В репозитории `0000`…`0052`, свой стиль имён | Пересобрать в `45-plan.md` (фаза 2); порядок и зависимости из `40` §5.1 сохраняются |
| Предписание `38` §3.1 править `28` по `hired_at` (Р-2) | Правка уже сделана, колонка в БД — `date` | Оставить в `38` только констатацию |
| Путь `/api/public/v1` | В репозитории работает `/api/v1/public/*`, префикс задаётся деревом каталогов | Править документы пакета под существующий путь |
| Коды `file.too_large` / `file_too_large` (`41` §8.2.4) | Оба не используются: действует `media.too_big` | Принять `media.too_big`, править оба документа |
| Уточняющие коды «нет скоупа» в `30`, `31`, `38` (`41` §8.2.7) | В `server/api` одно написание — `forbidden`, 25 файлов | Оставить `forbidden`, убрать пять вариантов из документов |
| `VALIDATION_FAILED` UPPER_SNAKE в `36` (`41` §8.2.5) | Повсеместно `validation_failed` | Править `36` |
| Строки путей с префиксом `/api/v1` в `35` §10 (`41` §8.3.6) | Nitro добавляет префикс сам — вышло бы `/api/v1/api/v1/…` | Править `35` |
| Фраза «шесть новых таблиц» в `38` §3.7 (Р-8) | Их восемь | Правка числа |
| Посылка П-25.1 «три оси лимитов» | Осей шесть | Патч переписывается как 6 → 11 |

**Три таблицы из 73 не создаются** (`org_structure_conflicts`, `person_notes`,
`storage_quota_addons`) → в работу идут **70 новых таблиц** и три дополнительных
`alter table` (`org_conflicts`, `user_notes` — и `tenant_addons` вместо
`storage_quota_addons`).

---

## 6. Открытые вопросы для фазы 1 (`44-decisions.md`)

Пронумерованы; каждый требует решения с обоснованием, не согласования.

**Унаследованные из README «Что нужно решить»**

1. ~~`scales` / `scale_levels` в поздних этапах~~ — **снят сверкой** (Р-4): таблицы есть.
2. **`review_queue_items`: витрина → таблица.** Обострился (Р-3): объекта нет вовсе, очередь
   собирается запросом. Решить: заводить полноценную таблицу с DDL в `docs/02` — и тогда
   чем наполнять (сервис при появлении работы) и что делать с существующим
   `server/services/queue.ts`; или оставить запрос и перенести 21 колонку состояния в
   `workshop_submissions` / `attempt_answers` (половина состояния там уже есть:
   `reviewer_id`, `claimed_at`, `sla_due_at`, `rework_count`).
3. **Гибридная модель категорий (`33` §3.1).** Сверкой не затронута, остаётся открытой.

**Поднятые сверкой**

4. **`media_assets`: переименовать или завести рядом.** `uploaded_by` ≈ `owner_user_id`,
   `checksum` ≈ `checksum_sha256`. Переименование дешевле в данных и дороже в коде (`media`,
   `media/[id]`, `server/services/media.ts`). Решить до миграции `origin`.
5. **Форма лимитов: явные колонки или `jsonb`.** Пакет писался под
   `plans.limits jsonb` + `tenant_limits.overrides jsonb`, фактически — явные колонки и
   `plans` с PK по `code` без `id`. От решения зависят `plan_prices.plan_id`, `tenant_addons`
   и формула эффективного лимита (`35` §7.3). Дорого откатывать.
6. **Перечень `media_assets.origin` — финальная редакция (Р-1).** Колонки нет, конфликт
   редакций `34`/`30`/`38` не разрешён в документах. Принять редакцию `40` §4.2 и правкой
   закрыть `38` §3.2.
7. **`org_conflicts`: объединение перечней `kind`.** 5 значений репозитория против 8 значений
   пакета, пересечения по именам нет. Нужен один перечень в `docs/02` §«Перечисления» —
   CLAUDE.md п. 13 запрещает выдумывать значения молча.
8. **П-16.1: поимённый перечень выборок (Р-9).** ≈98 мест (`from(users)` × 59 в 26 файлах +
   сырой SQL × 39). Решить форму: два репозиторных метода, два представления или lint-правило
   на прямое обращение к `users`. Плюс — как проверять в CI, чтобы забытая выборка падала, а
   не возвращала лишние строки. **Самое дорогое решение пакета.**
9. **Пути публичного контура.** Зафиксировать `/api/v1/public/*` и поправить `29` §10, П-04,
   П-25.3 (или обосновать перенос трёх работающих эндпоинтов).
10. **Девять ключей разбивки хранилища (Р-7).** Утвердить источником `33` (8 этапов +
    `other`), привести `35` §3.3 и подписи экрана `34` §5.1.
11. **Мягкие полиморфные ссылки (Р-11).** Решить одинаково для шести пакетных и трёх
    существующих (`task_status_log`, `task_access_log`, `pass_events`): фоновая пометка
    недостижимых, строка остаётся, интерфейс показывает «Джерело видалено».
12. **`quizzes.mode` против существующих `kind` и `selection_mode`.** Проверить, не дублирует
    ли `mode='interview'` смысл `kind`; при дублировании — расширить `kind`, а не добавлять
    колонку.
13. **Четыре отложенных FK (Р-10)** и девятый контрактный тест на их наличие после наката.
14. **Нумерация и разбивка миграций.** Формально вопрос фазы 2, но состав первой миграции
    (`users.kind` + П-16.1 в одном файле) — решение фазы 1, потому что задаёт размер первого
    PR.

**Поднятые сверкой API**

15. **Судьба `/review/queue` против трёх базовых очередей (`41` §8.3.7).** Коллизия
    существует в коде уже сейчас: `review/queue.get.ts` и `review/answers`,
    `review/workshops`, `review/submissions` живут одновременно, а `docs/04-api.md` §4.7 про
    `/review/queue` не знает. Решить вместе с вопросом №2 (`review_queue_items`): что
    остаётся публичным контрактом, а что становится внутренним.
16. **Форма машинной оси в `limit_warning` / `limit_exceeded` (`41` §8.2.2).** Единый код
    уже принят кодом, но payload несёт человекочитаемый `resource`, а не `details.axis`.
    Ввод `axis` — изменение контракта существующего уведомления; решить до одиннадцати осей
    (П-25.1).
17. **`DELETE /media/:id` — долг базового ТЗ.** Объявлен в `docs/04-api.md` §4.15, не
    реализован. Решить: закрывать вместе с колонками мягкого удаления из `40` §3.3 или
    убрать из документа.
18. **События вебхуков для пакета (`41` §8.7.3).** `WEBHOOK_EVENTS` — 7 значений, ни одного
    из `candidate.hired`, `vacancy.application_received`, `offboarding.completed`.
    Инфраструктура готова, решить нужно состав: какие события пакета уходят наружу и не
    протекают ли через них персональные данные кандидата.
19. **Журналирование скачивания файла-доказательства (`41` §8.7.4).** Сейчас `?redirect=1`
    отдаёт `302` без записи в `audit_log` (`media/[id]/index.get.ts:17`). Решить вместе с
    `media_assets.is_evidence`: писать факт скачивания или ограничиться выдачей ссылки.
20. **Запреты для Bearer-токена (`41` §8.7.2).** Разграничение идёт по скоупам токена;
    решить, нужен ли сверх этого чёрный список путей (`/platform/*`,
    `GET /people/:id/notes`) — и если да, то где он живёт.

**Решения, дорогие для отката** (для владельца продукта — читать первыми): №2, №4, №5, №8.

---

## 7. Счётчики самопроверки

**Схема.**

| Показатель | Значение |
|---|---:|
| Таблиц в пакете | 73 |
| Есть под тем же именем | 0 |
| Есть под другим именем (частично) | 2 |
| Есть частично | 0 |
| Нет | 71 |
| Из них: функция частично закрыта другой таблицей/колонками | 8 |
| Таблиц, которые по итогам сверки **не создаются** | 3 |
| Таблиц в работу | **70** |
| `alter table` в пакете | 14 (одна невыполнима — `review_queue_items`) |
| Колонок в `alter` | 97 |
| Колонок уже существует | 6 |
| Колонок мигрировать | **91** |
| Таблиц в dev-БД на 23.09.2026 | 143 |
| Миграций в репозитории | 53 (`0000`…`0052`) |

**Патчи.**

| Показатель | Значение |
|---|---:|
| Номеров в `39-patches.md` | 19 (П-01…П-25 с пропусками 06, 08, 09, 10, 18, 19) |
| Проверяемых пунктов с подпунктами | 29 |
| Применён полностью | 0 |
| Применён частично / выполнен кодом | 10 |
| Не применён | 19 |
| Потерял смысл | 0 |
| Изменился по содержанию | 2 (П-20, П-25.1) |
| Блокирующих патчей | 5 (П-01, П-02, П-15, П-16.1, П-13-замечание) — применённых среди них 0 |

**API.**

| Показатель | Значение |
|---|---:|
| Эндпоинтов в пакете | 239 |
| Реализовано тем же путём | 7 |
| Реализовано под другим путём | 14 |
| **Реализовано из пакета** | **21 (8,8 %)** |
| Отсутствует | 218 |
| Подсистем отсутствует целиком | 5 из 11 + публичный контур |
| Файлов в `server/api` | 603 |

Развёрнутая разбивка — §3.1–3.5.

**Противоречия.**

| Показатель | Значение |
|---|---:|
| Рисков в `40` §9 | 11 |
| Закрыто развитием репозитория | 3 (Р-4, Р-5, Р-9) |
| Закрыто по существу, косметика открыта | 1 (Р-2) |
| Открыто | 7 |
| Пунктов в `41` §8 | 23 |
| Из них закрыто фактическим состоянием | 4 |
| Из них закрыто частично | 5 |
| Из них открыто | 14 (две — усугублены кодом) |
| Коллизий найдено сверкой дополнительно | 2 (префикс публичного контура; `DELETE /media/:id` без обработчика) |
| **Противоречий всего проверено** | **34** (11 рисков §9 + 23 пункта §8) |
| Из них закрыто | 7 |
| Из них закрыто частично / с косметическим остатком | 6 |
| Из них открыто | 21 |
| Открытых вопросов в фазу 1 | 20 (из них снят сверкой 1 → к решению 19, дорогих для отката 4) |

**Строк «не проверено» в документе: 0.** Вердикт есть у каждой из 73 таблиц, у каждой из 97
колонок `alter`, у каждого из 29 пунктов патчей, у каждой из 11 групп эндпоинтов и у каждого
из 34 противоречий (11 рисков `40` §9 + 23 пункта `41` §8).
