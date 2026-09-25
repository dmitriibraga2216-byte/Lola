# Lola LMS — ТЗ. 40. Дельта модели данных: сводка и порядок миграций

## 1. Назначение

Этот документ сводит модель данных одиннадцати документов пакета `lola-spec-v2`
(`28`–`38`) в один исполнимый порядок миграций поверх базового ТЗ
(`lola-spec/docs/02-data-model.md`) и уже реализованной стадии 0
(`lola/drizzle/sql/0001_foundation.sql`, `0002_rls.sql`, `0003_indexes.sql`).

**Как им пользоваться.** Разработчик, который пишет миграции пакета, читает §5 и делает
файлы ровно в этом порядке, а DDL каждой таблицы берёт из документа-владельца по ссылке
из §2. Полный DDL здесь намеренно не повторяется: две копии DDL расходятся на первой же
правке. Исключения — три места, где сводка **и есть** источник истины и приводится полным
SQL: итоговый констрейнт `media_assets.origin` (§4), блок применения RLS (§6) и
контрактные тесты (§8).

**Статус документа.** Это единственный источник истины по **составу и порядку** миграций
пакета. Источник истины по **содержанию таблицы** — документ-владелец из §2. При
расхождении этого документа с модульным правится модульный, а этот пересобирается заново;
обратный порядок (тихо поправить сводку под код) запрещён — он превращает §8 в
декорацию.

**Охват.** 73 новые таблицы, 14 изменяемых существующих таблиц, 25 файлов миграций,
71 таблица под RLS, 2 платформенные вне RLS.

---

## 2. Сводная таблица новых сущностей

Колонка «Т/П»: **Т** — тенантная (есть `tenant_id`, попадает под RLS §6), **П** —
платформенная (нет `tenant_id`, вне RLS).

### 2.1 Рекрутинг: кандидаты и воронка (`28-recruiting-candidates.md`) — 4

| Таблица | Назначение | Т/П |
|---|---|:-:|
| `candidate_statuses` | Расширяемый справочник колонок канбана воронки; каждая колонка знает своё терминальное `maps_to` | Т |
| `candidate_scores` | Четыре независимых вида оценки кандидата (`manual`/`task`/`ai`/`recruiter`) с историей через `is_current` | Т |
| `candidate_comments` | Служебная переписка рекрутеров о кандидате; кандидату не видна никогда | Т |
| `candidate_status_history` | Лента смен колонки канбана: сколько дней стоял и кто подвинул | Т |

### 2.2 Рекрутинг: вакансии и площадки (`29-vacancies.md`) — 10

| Таблица | Назначение | Т/П |
|---|---|:-:|
| `vacancies` | Вакансия: описание, условия, привязка к рекрутинговому курсу и точке, публичная ссылка | Т |
| `vacancy_languages` | Требования к языкам по шкале CEFR плюс `native` | Т |
| `vacancy_criteria` | Критерии человеческой оценки кандидата по вакансии (рамка решения, не правило прохождения) | Т |
| `vacancy_criterion_scores` | Баллы по критериям; сворачиваются в `candidate_scores` с `kind='recruiter'` | Т |
| `vacancy_templates` | Самостоятельный шаблон вакансии (не вакансия-черновик) с вложенными критериями и языками | Т |
| `job_board_accounts` | Аккаунты внешних job-бордов с тремя уровнями владения (`company`/`personal`/`recruiter`) | Т |
| `vacancy_publications` | Журнал публикаций вакансии на площадках, состояние и внешние идентификаторы | Т |
| `vacancy_applications` | Сырой отклик с публичной страницы до превращения в кандидата, с антиспам-оценкой | Т |
| `public_apply_attempts` | Журнал обращений к публичной странице отклика для частотных ограничений | Т |
| `vacancy_ai_generations` | Журнал ИИ-генераций текстов вакансии и списанных операций | Т |

### 2.3 ИИ: провайдеры, собеседование, артефакты (`30-ai-interview.md`) — 11

| Таблица | Назначение | Т/П |
|---|---|:-:|
| `ai_providers` | Профиль поставщика модели: назначение, драйвер, регион данных, срок хранения у поставщика, цепочка запасных | Т |
| `ai_calls` | Журнал вызовов модели: дайджесты входа и выхода, латентность, стоимость, ось расхода | Т |
| `interview_scenarios` | Сценарий авто-собеседования поверх `quizzes` с `kind='interview'` (`44` В-12, PR-28) | Т |
| `interview_criteria` | Критерии оценки собеседования с обязательным определением 20–500 знаков | Т |
| `interview_consents` | Согласие кандидата на запись и обработку, с хэшем редакции текста и выбранной альтернативой | Т |
| `interview_sessions` | Сессия собеседования поверх строки `attempts`: обрывы, антифрод-флаги, срок стирания записей | Т |
| `interview_turns` | Реплика диалога: медиа, длительность, расшифровка и её достоверность | Т |
| `interview_criterion_scores` | Балл по критерию с обязательным обоснованием и минимум одной цитатой; расхождение с человеком | Т |
| `candidate_summaries` | «3Д-резюме» кандидата: версия, полнота, правило авто-отправки, токен доступа | Т |
| `ai_review_hints` | Подсказка проверяющему: что из ключа прозвучало, чего нет, где противоречие; вердикта не выносит | Т |
| `ai_quality_reviews` | Выборочный аудит качества машинных выводов | Т |

### 2.4 Контент: библиотека переиспользуемых модулей (`31-module-library.md`) — 4

| Таблица | Назначение | Т/П |
|---|---|:-:|
| `library_modules` | Карточка переиспользуемого модуля: владелец, статус, поиск по тексту и по эмбеддингу | Т |
| `library_module_versions` | Закреплённая версия модуля: неизменяемый снимок тела, changelog, diff по блокам | Т |
| `library_module_usages` | Где версия используется, режим закрепления и признак устаревания | Т |
| `library_module_proposals` | Предложение вынести урок из курса или траектории в библиотеку | Т |

### 2.5 Оргструктура (`32-org-structure.md`) — 5

| Таблица | Назначение | Т/П |
|---|---|:-:|
| `org_nodes` | Узел штатного дерева (`ltree`-путь), плановая численность, признак точки управления | Т |
| `org_node_assignments` | Кто и с какой ролью держит узел и в какой период | Т |
| `org_manager_map` | Материализованная карта «кто чей руководитель» с цепочкой вверх и источником вывода | Т |
| `org_structure_snapshots` | Снимки дерева для отката реорганизации и сравнения периодов | Т |
| `org_structure_conflicts` | Журнал конфликтов структуры: система пишет строку и продолжает, а не падает | Т |

### 2.6 Жизненный цикл сотрудника (`33-lifecycle.md`) — 3

| Таблица | Назначение | Т/П |
|---|---|:-:|
| `lifecycle_stages` | Справочник восьми этапов с картой возможностей `capabilities` | Т |
| `employee_lifecycle_state` | На каком этапе человек находится сейчас и когда вошёл; хранится явно, не выводится | Т |
| `offboarding_cases` | Процесс увольнения: передача дел, выходное интервью, отзыв доступа | Т |

### 2.7 Хранилище файлов (`34-storage.md`) — 6

| Таблица | Назначение | Т/П |
|---|---|:-:|
| `storage_usage_counters` | Оперативный счётчик занятого места по происхождению и категории | Т |
| `storage_usage_daily` | Суточный срез потребления для биллинга и графика, с расчётом дрейфа счётчика | Т |
| `storage_retention_policies` | Политика хранения на каждое происхождение файла: срок, точка отсчёта, действие | Т |
| `storage_deletion_requests` | Заявка на массовое удаление со снимком фильтров и подтверждающей фразой | Т |
| `storage_quota_addons` | Докупленное место сверх тарифа (см. риск Р-6 в §9) | Т |
| `storage_pending_uploads` | Работа сотрудника, не поместившаяся в квоту, ждущая места на устройстве | Т |

### 2.8 Биллинг и лимиты (`35-billing-limits.md`) — 8

| Таблица | Назначение | Т/П |
|---|---|:-:|
| `plan_prices` | Цена тарифа за период в валюте с интервалом действия | **П** |
| `plan_addons` | Каталог докупаемых опций: ось, шаг единицы, срочность | **П** |
| `tenant_addons` | Докупленные тенантом опции со снимком шага на момент покупки | Т |
| `usage_counters` | Счётчики расхода периода в реальном времени со снимком лимита | Т |
| `usage_events` | Журнал расхода по осям, хранение 400 дней | Т |
| `tenant_payments` | Платежи и счета тенанта | Т |
| `plan_change_requests` | Заявка на смену тарифа с результатом предполётной проверки превышений | Т |
| `limit_notices` | Открытые предупреждения и превышения по осям, по одному на ось и уровень | Т |

### 2.9 Обратная связь по контенту (`36-content-feedback.md`) — 5

| Таблица | Назначение | Т/П |
|---|---|:-:|
| `content_issues` | Дефект контента: дедупликация жалоб, влияние на баллы, состояние пересчёта | Т |
| `content_reports` | Отдельная жалоба человека с контекстом, скриншотом и версией вопроса | Т |
| `content_issue_events` | Лента событий по дефекту: смены статуса, назначения, пересчёты | Т |
| `content_issue_routing_rules` | Правила автоматического назначения ответственного за дефект | Т |
| `content_reporter_stats` | Статистика заявителя и защита от спама жалобами | Т |

### 2.10 Проверка работ, делегирование, учёт времени (`37-review-delegation.md`) — 9

| Таблица | Назначение | Т/П |
|---|---|:-:|
| `review_delegations` | Передача элемента очереди другому проверяющему, глубина цепочки ≤2 | Т |
| `review_routing_rules` | Правила распределения работ по проверяющим со стратегией выбора | Т |
| `reviewer_capacity` | Ёмкость проверяющего: потолок открытых работ, дневная норма, курсор round-robin | Т |
| `reviewer_absences` | Отсутствия проверяющего и замещающий на период | Т |
| `review_sla_events` | События SLA по элементу очереди: назначен, предупреждён, просрочен, эскалирован | Т |
| `reviewer_stats_daily` | Суточная статистика проверяющего для отчёта и выбора наименее загруженного | Т |
| `content_time_norms` | «Розрахунковий час» элемента контента: норма автора, авторасчёт, наблюдаемая медиана | Т |
| `learning_time_sessions` | Сегменты измеренного времени с зачтёнными и выброшенными секундами | Т |
| `learning_time_totals` | Витрина суммарного времени на контент и на испытание по элементу | Т |

### 2.11 Люди: расширения карточки (`38-people-extensions.md`) — 8

| Таблица | Назначение | Т/П |
|---|---|:-:|
| `user_activity_events` | Событие активности человека со снимком таймзоны и локального дня | Т |
| `user_activity_daily` | Суточный агрегат активности и уровень для «травы» на карточке | Т |
| `person_notes` | Заметки о человеке с видимостью, категорией и скрином чувствительных формулировок | Т |
| `person_document_types` | Справочник видов документов человека: обязательность, срок годности, напоминания | Т |
| `person_documents` | Документ человека: файл или факт, срок действия, состояние | Т |
| `absence_norms` | Нормы отпуска и больничного по уровням «тенант / точка / человек» | Т |
| `absence_records` | Факты отсутствий с диапазоном дат и числом дней | Т |
| `person_rating_snapshots` | Снимок расчёта рейтинга с разложением формулы; источник истины для `users.rating_pct` | Т |

> [уточнено, PR-35, миграция `0094_v2_person_rating`] «Рейтинг» здесь — **індекс навчальної
> залученості** (0…130 %), а не баллы рейтинга `points_ledger`. `person_rating_snapshots` заведена
> с отступлениями от DDL `38` §3.7, перечисленными там же: без отдельного индекса `(tenant_id,
> user_id, calc_date desc)` (его роль играет уникальный ключ), с `uq_person_rating_current` и
> проверками слагаемых. `users.rating_pct` получил `users_rating_pct_chk` (0…130), частичный индекс
> `idx_users_tenant_rating` — `where kind = 'employee'` без условия статуса (Р-35.1).

> [уточнено, PR-34, миграция `v2_user_activity`] `user_activity_events` и `user_activity_daily` заведены с
> отступлениями от DDL `38` §3.3, перечисленными там же: у события нет `seconds_spent` (время — из учёта времени PR-21,
> в агрегат его сводит `activity.aggregate`), есть `created_at` и индекс уборки `(tenant_id, occurred_at)`; второй
> индекс агрегата не заводится — tenant-first индекс даёт уникальный ключ `(tenant_id, user_id, local_date)`. Вместе с
> ними — `users.timezone` (строка 16 таблицы §3) с `users_timezone_chk`: неизвестное Postgres имя пояса не сохраняется.

### 2.12 Итог

| Подсистема | Таблиц | Тенантных | Платформенных |
|---|---:|---:|---:|
| Рекрутинг (`28` + `29`) | 14 | 14 | 0 |
| ИИ (`30`) | 11 | 11 | 0 |
| Контент-библиотека (`31`) | 4 | 4 | 0 |
| Оргструктура (`32`) | 5 | 5 | 0 |
| Жизненный цикл (`33`) | 3 | 3 | 0 |
| Хранилище (`34`) | 6 | 6 | 0 |
| Биллинг (`35`) | 8 | 6 | 2 |
| Обратная связь (`36`) | 5 | 5 | 0 |
| Проверка и время (`37`) | 9 | 9 | 0 |
| Люди (`38`) | 8 | 8 | 0 |
| **Всего** | **73** | **71** | **2** |

### 2.13 Факт после внедрения: было в пакете → стало (PR-40)

> [дополнено, PR-40, сверка по миграциям `0056`–`0096` и `tests/integration/v2-package-tables.ts`]
> Таблицы §2.1–§2.12 — намерение пакета на 19.09. Ниже — что создано на самом деле. Источник —
> `create table` в 35 миграциях пакета `NNNN_v2_*.sql` (номера `0056`–`0096`; `0065` и `0067` не
> заняты — перенумерация при rebase параллельных веток, `45` §5). Длину списков и их совпадение с
> этой таблицей держит **контрактный тест №6** (`tests/integration/v2-contract-06-package-tables.spec.ts`):
> тенантных — **74**, платформенных — **3**. Изменение состава пакета — новой строкой здесь и
> числом в тесте, а не молча через список.

| # | Было в пакете | Стало по факту | Каким PR | Почему |
|---:|---|---|---|---|
| 1 | `org_structure_conflicts` (Т, `32` §3.3) | **не создана**; `alter table org_conflicts` (+`severity`, `node_id`, перечень `kind` расширен объединением двух списков) | PR-30 #111, `0075_v2_org_structure` | `44` В-7: протокол конфликтов базового ТЗ (`0033`) — та же сущность; вторая таблица дала бы два источника истины |
| 2 | `person_notes` (Т, `38` §3.4) | **не создана**; существующая `user_notes` (`0019`) взята пакетом под своим именем: +7 колонок (видимость, категория, закрепление, скрин формулировок, архив), FK на `tenants`, полный tenant-first индекс рядом с частичным | PR-32 #121, `0082_v2_person_notes_docs` | `43` §1.2 «есть под другим именем»; таблица входит в список контрактов 1–3, 5, 6 |
| 3 | `storage_quota_addons` (Т, `34` §3.3) | **не создана**; докупка места — `tenant_addons` с `addon_code = 'storage_pack'` | PR-08 #94 (`tenant_addons`), PR-36 #122 (квота) | Р-6: два механизма докупки → одна функция эффективного лимита (`44` В-5); сквозная проверка 23 |
| 4 | `review_queue_items` — витрина (`docs/14` §3.3), в §3.4 — `alter` на 21 колонку | **создана таблицей с нуля** — 71-я таблица плана | PR-18 #100, `0066_v2_review_queue` | `44` В-2: у очереди собственное состояние (назначение, SLA, делегирование), витрина его не держит |
| 5 | `platform_announcement_reads` — нет в §2 (патч `39` П-21) | создана (Т) | PR-39 #124, `0084_v2_settings` | вводят патчи к базовому ТЗ, а не модульные документы §2 |
| 6 | `position_groups` — нет в §2 (П-24.5) | создана (Т) | PR-39 #124, `0084_v2_settings` | то же |
| 7 | `user_totp` — нет в §2 (П-24.1) | создана (Т) | PR-39 #124, `0084_v2_settings` | то же |
| 8 | `user_totp_recovery_codes` — нет в §2 (П-24.1) | создана (Т) | PR-39 #124, `0084_v2_settings` | то же |
| 9 | `platform_announcements` — нет в §2 (П-21, П-24.2) | создана (**П**, вне RLS; у `app_user` только `select`) | PR-39 #124, `0084_v2_settings` | объявление оператора одно на платформу — третья платформенная таблица (§6.2) |
| 10 | `absence_norms` (`38` §3.6), план — PR-33 | создана раньше плана | PR-39 #124, `0084_v2_settings` | блок норм отпуска в настройках компании пишет уровни компании и точки; PR-33 (#133) добавил уровень человека и факты `absence_records` |
| 11 | `users` — 16 колонок пакета (§3.2) | **18**: + `candidate_state_at`, `anonymized_at` | PR-14 #102, `0068_v2_candidates_funnel` | от `candidate_state_at` считает авто-архив воронки (`28` §11); `anonymized_at` — отметка стирания ПД по истёкшему согласию. Состав держит контрактный тест №7 |

**Не пакет**, хотя номера миграций в том же диапазоне: `points_ledger`, `shop_categories`, `shop_items`,
`shop_orders` (`0076_gamification`, #114, базовое ТЗ D-069) и `resource_progress` (`0092_fix_resource_node`,
#132, Г-11.5). Их контракты держат базовые `rls.spec.ts` и `schema-parity.spec.ts`, в список пакета они не входят.

**Итог по подсистемам (факт):**

| Подсистема | `40` §2 (Т/П) | Создано (Т/П) | Разница |
|---|---:|---:|---|
| Рекрутинг (`28` + `29`) | 14 / 0 | 14 / 0 | — |
| ИИ (`30`) | 11 / 0 | 11 / 0 | — |
| Контент-библиотека (`31`) | 4 / 0 | 4 / 0 | — |
| Оргструктура (`32`) | 5 / 0 | 4 / 0 | −`org_structure_conflicts` (п. 1) |
| Жизненный цикл (`33`) | 3 / 0 | 3 / 0 | — |
| Хранилище (`34`) | 6 / 0 | 5 / 0 | −`storage_quota_addons` (п. 3) |
| Биллинг (`35`) | 6 / 2 | 6 / 2 | — |
| Обратная связь (`36`) | 5 / 0 | 5 / 0 | — |
| Проверка и время (`37`) | 9 / 0 | 10 / 0 | +`review_queue_items` (п. 4) |
| Люди (`38`) | 8 / 0 | 7 / 0 | −`person_notes` (п. 2; `absence_norms` — в PR-39, п. 10) |
| Патчи `39` (П-21, П-24) | 0 / 0 | 4 / 1 | пп. 5–9 |
| **Всего создано** | **71 / 2 = 73** | **73 / 3 = 76** | |
| **Под контрактами пакета** (`v2-package-tables.ts`) | 71 / 2 | **74 / 3** | 73 созданные + `user_notes` (п. 2) |

---

## 3. Изменения существующих таблиц

14 таблиц базового ТЗ получают `alter`. Ниже полный список добавляемых колонок с
документом-источником.

> [дополнено, реализация PR-33] Пятнадцатая: `enrollments` + `deadline_shifted_reason` (`38` §7.14,
> §13 к. 10 — «в назначении фиксируется `deadline_shifted_reason='absence'`»; колонки документ не
> называл). Срок у людей одного назначения свой, а отсутствует один человек — поэтому причина
> живёт в записи на курс, которую назначение создаёт, рядом с её `due_at`; констрейнт
> `enrollments_deadline_shift_reason_chk` — перечень `deadline_shift_reason` в `docs/02`.

### 3.1 Сводка по таблицам

| Таблица | Документ | Колонок | Прочее |
|---|---|---:|---|
| `users` | `28` + `38` | 16 | 3 констрейнта, 5 индексов — см. §3.2 |
| `media_assets` | `34` (+`30`, `38` по констрейнту) | 19 | 3 констрейнта, 7 индексов — см. §3.3 и §4 |
| `review_queue_items` | `37` | 21 | 4 констрейнта, 3 индекса |
| `tenant_limits` | `35` | 10 | — |
| `plans` | `35` | 9 | платформенная, вне RLS |
| `tenant_usage` | `35` | 8 | 1 индекс |
| `lesson_progress` | `37` | 3 | `seconds_spent` сохраняется как «сырая» величина |
| `courses` | `33` | 2 | 1 индекс |
| `lessons` | `31` | 2 | `module_id` становится nullable, 3 констрейнта, 2 индекса (PR-25; `31` §3.1) |
| `attempts` | `37` | 2 | `time_spent_sec` сохраняется |
| `workshop_submissions` | `37` | 2 | — |
| `trajectory_nodes` | `31` | 1 | 1 индекс |
| `quizzes` | `30` | 1 | 1 констрейнт |
| `attempt_answers` | `30` | 1 | 1 констрейнт |

### 3.2 `users` — единственная таблица, которую меняют два документа

Требование задания выполнено явно: ниже итоговый набор одним блоком. Документ `38` §3.1
перечисляет имена из `28` поимённо и подтверждает, что **ни одно не переиспользуется**.

| # | Колонка | Тип | Документ | Смысл |
|---:|---|---|:-:|---|
| 1 | `kind` | text not null default `'employee'` | 28 | Кандидат или сотрудник; единственное различие двух сущностей |
| 2 | `candidate_state` | text | 28 | Терминальное состояние воронки, 5 значений |
| 3 | `candidate_status_id` | uuid | 28 | Колонка канбана, FK `candidate_statuses` (см. §5, миграция 0013) |
| 4 | `source` | text | 28 | Откуда пришёл кандидат |
| 5 | `source_detail` | text | 28 | Уточнение источника |
| 6 | `vacancy_id` | uuid | 28 | Вакансия отклика, FK `vacancies` (см. §5, миграция 0013) |
| 7 | `recruiter_id` | uuid | 28 | Ответственный рекрутер, самоссылка на `users` |
| 8 | `access_until` | date | 28 | Право входа, не дедлайн прохождения |
| 9 | `comm_language` | text not null default `'uk'` | 28 | Язык писем и интерфейса кандидата |
| 10 | `resume_asset_id` | uuid | 28 | Резюме, FK `media_assets` с `origin='candidate_cv'` |
| 11 | `converted_from_candidate_at` | timestamptz | 28 | Факт прихода сотрудника через воронку |
| 12 | `consent_given_at` | timestamptz | 28 | Согласие на обработку ПД |
| 13 | `consent_expires_at` | date | 28 | Дата стирания ПД кандидата |
| 14 | `rating_pct` | numeric(5,1) | 38 | Денормализованный снимок рейтинга для сортировки |
| 15 | `rating_updated_at` | timestamptz | 38 | Свежесть снимка; старше 48 ч — цифра серая |
| 16 | `timezone` | text | 38 | Override таймзоны точки для удалённых |

Констрейнты (все из `28`): `users_kind_chk`, `users_candidate_state_chk`,
`users_candidate_coherence_chk`.

Индексы: `idx_users_tenant_kind`, `idx_users_tenant_candidate_status`,
`idx_users_tenant_recruiter`, `idx_users_tenant_vacancy` (`28`),
`idx_users_tenant_rating` (`38`).

**`hired_at` не добавляется ни одним документом.** Колонка объявлена в базовом ТЗ
(`02` §2.3) как `date`. Документ `28` §3.2 содержит явный комментарий «Новую колонку не
добавляем», документ `38` §3.1 фиксирует то же самое как решение. Если понадобится
точность до времени — это `alter column hired_at type timestamptz`, а не `add column`.
Остаточное расхождение в тексте `38` разобрано в §9, Р-2.

### 3.3 `media_assets` — 19 колонок, все из `34`

`created_at`, `origin`, `owner_user_id`, `course_id`, `category_id`, `enrollment_id`,
`source_entity`, `source_id`, `lifecycle`, `is_evidence`, `retention_until`,
`orphaned_at`, `purge_after`, `deleted_at`, `deleted_by`, `delete_reason`,
`checksum_sha256`, `last_accessed_at`, `original_name`.

Констрейнты: `media_assets_origin_chk` (см. §4), `media_assets_lifecycle_chk`,
`media_assets_purge_chk`.

Документы `30` и `38` **колонок сюда не добавляют** — они трогают только перечень
`origin`, и это разобрано отдельно в §4.

### 3.4 `review_queue_items` — 21 колонка, все из `37`

`subject_kind`, `task_type`, `task_title`, `track_id`, `estimated_seconds`,
`attempts_count`, `completed_at`, `content_seconds`, `attempt_seconds`,
`time_confidence`, `delegation_id`, `assigned_reviewer_id`, `assigned_at`,
`assigned_by_rule_id`, `origin_reviewer_id`, `delegation_depth`, `sla_hours`,
`sla_warned_at`, `sla_breached_at`, `escalated_at`, `escalated_to_id`.

`delegation_id` и `assigned_by_rule_id` объявлены как `uuid` без `references`: обе
целевые таблицы создаются позже и одна из них (`review_delegations`) ссылается обратно.
Внешние ключи ставятся отдельным шагом в миграции 0022 (§5).

### 3.5 Остальные таблицы

| Таблица | Документ | Колонки |
|---|:-:|---|
| `plans` | 35 | `title_uk`, `tier`, `ai_included`, `ai_term_days`, `addons_allowed`, `sort`, `is_active`, `valid_from`, `valid_to` |
| `tenant_limits` | 35 | `billing_period`, `status`, `paid_until`, `grace_until`, `ai_until`, `autorenew`, `currency`, `ai_status`, `updated_at`, `updated_by` |
| `tenant_usage` | 35 | `plan_id`, `candidates_active`, `storage_by_category`, `ai_ops`, `sms_out`, `telegram_out`, `integrations_active`, `axes` |
| `courses` | 33 | `lifecycle_stage_id`, `stage_locked` |
| `lessons` | 31 | `library_module_id`, `library_version_id`; плюс `alter column module_id drop not null` |
| `trajectory_nodes` | 31 | `library_version_id` |
| `quizzes` | 30 | `mode` |
| `attempt_answers` | 30 | `input_mode` |
| `lesson_progress` | 37 | `content_seconds`, `discarded_seconds`, `sessions_count` |
| `attempts` | 37 | `net_seconds`, `discarded_seconds` |
| `workshop_submissions` | 37 | `attempt_seconds`, `content_seconds` |

### 3.6 Проверка на двойное добавление — подтверждение

Все `alter table … add column` пакета разобраны механически и сведены по паре
(таблица, колонка). **Ни одна колонка не добавляется дважды.** Отдельно проверены
четыре места, где риск был реальным:

1. **`users`** — два документа (`28`, `38`), 13 + 3 колонки, пересечений нет (§3.2).
2. **`hired_at`** — не добавляется вообще, ни одним из трёх документов, которые о ней
   говорят (§3.2).
3. **`media_assets`** — колонки добавляет только `34`; `30` и `38` работают
   исключительно с констрейнтом `origin` (§4).
4. **Повторяющиеся имена в разных таблицах** — `content_seconds` и `attempt_seconds`
   появляются в `review_queue_items`, `workshop_submissions` и (как `content_seconds`)
   в `lesson_progress`; `discarded_seconds` — в `lesson_progress` и `attempts`. Это
   одноимённые, но разные колонки разных таблиц, конфликта нет.

Автоматическая защита от регресса — тест 6 в §8.

---

## 4. Реестр `media_assets.origin`

Это единственный узел пакета, который трогают три документа, а используют пять.
Владелец перечня — `34-storage.md` §3.2. `30-ai-interview.md` §3.7 добавляет одно
значение патчем `П-30.1`. `38-people-extensions.md` §3.2 **пересоздаёт констрейнт
целиком** (drop + add), и его версия перечня не содержит значения из `30`. Порядок
миграций здесь решает: если `38` выполнится после `30`, значение `interview_answer`
молча исчезнет и запись собеседования станет невставляемой.

**Решение сводки:** перечень собирается один раз, в отдельной миграции `0019`, после
всех таблиц `30` и до таблиц `38` (§5). Модульные документы не правятся, но при
реализации `38` §3.2 исполняется **в редакции ниже**, а не дословно. Расхождение
зафиксировано в §9, Р-1.

> [исправлено, PR-23: реестр собирался из `34`, `30` и `38`, а `36` §3.2 в сводку не попал —
> хотя скриншот жалобы в его DDL уже ссылается на `media_assets`. Шестнадцатое значение
> `issue_screenshot` добавлено правкой **здесь**, как требует правило 19, и одной миграцией
> `0069_v2_content_issues`, целиком пересоздающей констрейнт] Ранее: «15 значений»

### 4.1 Итоговый перечень — 16 значений

| Значение | Что это за файл | Порождает | Используют |
|---|---|:-:|---|
| `content_cover` | Обложка курса, траектории, раздела каталога | 34 | базовое ТЗ |
| `lesson_attachment` | Вложение урока или блока контента | 34 | базовое ТЗ, 31 |
| `workshop_submission` | Файл, приложенный к сдаче практикума | 34 | базовое ТЗ, 37 |
| `video_answer` | Видеоответ на задание трека | 34 | базовое ТЗ |
| `candidate_cv` | Резюме кандидата (`users.resume_asset_id`, `vacancy_applications.resume_asset_id`) | 34 | **28**, **29** |
| `certificate` | Выданный сертификат | 34 | базовое ТЗ |
| `import` | Файл импорта людей или контента | 34 | базовое ТЗ |
| `checklist_photo` | Фотография в прохождении чек-листа | 34 | базовое ТЗ |
| `avatar` | Аватар человека | 34 | базовое ТЗ |
| `brand_asset` | Логотип и брендинг тенанта | 34 | базовое ТЗ |
| `ai_artifact` | Артефакт работы модели: вход вызова в S3, PDF «3Д-резюме» | 34 | **30** |
| `report_export` | Сформированная выгрузка отчёта | 34 | базовое ТЗ |
| `interview_answer` | Аудио- или видеозапись реплики кандидата на авто-собеседовании | **30** | 30 |
| `person_document` | Документ человека: договор, инструктаж, внешний сертификат | **38** | 38 |
| `issue_screenshot` | Скриншот, приложенный к жалобе на материал (`content_reports.screenshot_media_id`) | **36** | 36 |
| `other` | Всё, что не отнесено; существует ради того, чтобы разбивка не падала на неизвестном виде | 34 | — |

Значение для резюме кандидата — `candidate_cv`, оно уже унифицировано между `28`, `29`
и `34`; второго имени (`resume`, `cv`) в пакете нет.

### 4.2 Итоговый констрейнт — полный SQL

```sql
-- migration 0019_media_origin_v2.sql
-- Единый перечень origin. Заменяет: 34 §3.2 (13 значений),
-- патч П-30.1 из 30 §3.7 (+interview_answer), 38 §3.2 (+person_document),
-- 36 §3.2 (+issue_screenshot, добавлено PR-23 миграцией 0069_v2_content_issues).
-- Два независимых check по одной колонке дали бы неразрешимую ошибку вставки,
-- поэтому констрейнт всегда один и всегда пересоздаётся целиком.

alter table media_assets drop constraint if exists media_assets_origin_chk;

alter table media_assets add constraint media_assets_origin_chk check (origin in (
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
  'issue_screenshot',
  'other'
));
```

### 4.3 Политики хранения, привязанные к перечню

> [исправлено, PR-23: новых значений стало три вместе с `issue_screenshot`] Ранее: «для двух новых значений»

`storage_retention_policies` держит одну строку на значение `origin`. Пакет задаёт
умолчания для трёх новых значений:

| `origin` | `action` | `keep_months` | `anchor` | `keep_evidence` | Источник |
|---|---|---:|---|:-:|---|
| `interview_answer` | `purge` | 3 | `created_at` | `false` | `30` §7.7 |
| `person_document` | `notify_only` | — | — | `true` | `38` §3.2 |
| `issue_screenshot` | `purge` | 6 | `created_at` | `false` | `36` §12 (180 дней) |

Обоснование в документах-владельцах: голос кандидата нельзя хранить по остаточному
принципу, а документ человека нельзя удалять автоматически — он доказательство того, что
инструктаж был проведён.

---

## 5. Порядок миграций

> [исправлено фазой 1, `43` §5 и `44` В-14] Ранее: «Нумерация продолжает стадию 0. Номер `0003`
> уже занят файлом `lola/drizzle/sql/0003_indexes.sql`, поэтому пакет начинается с `0004`. Всего
> 25 файлов», а раздел ниже опирался на несуществующий `0001_foundation.sql`. Фактически в
> `main` 54 миграции `0000`…`0053`, стиль имён `NNNN_<область>_<что>.sql`; `ltree` и `vector`
> уже созданы в `0000_youthful_warhawk.sql`, отдельного файла расширений пакету не нужно.
> **Нумерация `0004`–`0028` отменяется целиком.** Миграции пакета получают номера по факту
> начиная с `0054`, в стиле `NNNN_v2_<область>_<что>.sql`; точные номера и разбивка по PR —
> `docs/v2/45-plan.md` §5 и §8.1 (фаза 2). Порядок и зависимости между шагами, описанные ниже
> под старыми именами `0004`…`0028`, **сохраняются** — читать имена файлов в этом разделе как
> условные шаги, а не как согласованные номера миграций.

Правило порядка одно: таблица создаётся после всех, на которые ссылается её FK. Там, где
ссылки образуют цикл, создание таблицы и постановка FK разносятся по разным шагам — это
отмечено словом **«цикл»**.

### ~~0004_extensions.sql~~ — шаг отменён

> [исправлено, `43` §5 Р-5] Ранее: «Расширения, которых нет в `0001_foundation.sql` (там только
> `pgcrypto` и `pg_trgm`)» и требование отдельного файла для `ltree`/`vector`. Фактически оба
> расширения (`ltree` — для `org_nodes.path`, `32`; `vector` — для
> `library_modules.embedding vector(768)` и индекса `hnsw`, `31`) уже созданы миграцией
> `0000_youthful_warhawk.sql`. Отдельный шаг не нужен; условные «0011» и «0020» ниже зависят
> от расширений, уже присутствующих в базе, а не от этого шага.

### 0005_lifecycle.sql

Справочник этапов и привязка курса к этапу. Идёт первым из содержательных: `33` ни от
чего в пакете не зависит, а на `lifecycle_stages` ссылается `courses`.

- `lifecycle_stages`
- `alter table courses` — `lifecycle_stage_id` (FK → `lifecycle_stages`), `stage_locked`

Зависимости: `tenants`, `courses` (базовое ТЗ).

### 0006_candidate_statuses.sql

Справочник колонок воронки. Отделён от остального `28`, потому что на него ссылается
`users.candidate_status_id`, а `users` меняется позже.

- `candidate_statuses`

Зависимости: `tenants`, `users`.

### 0007_billing_platform.sql

Платформенный слой биллинга. **Вне RLS**, без `tenant_id`. Обязан идти до тенантного
слоя: `tenant_addons.addon_code` ссылается на `plan_addons.code`.

- `alter table plans` — 9 колонок
- `plan_prices`
- `plan_addons`

Зависимости: `plans` (стадия 0).

### 0008_billing_tenant.sql

- `alter table tenant_limits` — 10 колонок
- `alter table tenant_usage` — 8 колонок + индекс `tenant_usage_recent_idx`
- `tenant_addons`, `usage_counters`, `usage_events`, `tenant_payments`,
  `plan_change_requests`, `limit_notices`

Зависимости: `plans`, `plan_addons` (0007), `tenants`, `users`.
`tenant_addons.payment_id` и `tenant_payments.invoice_media_id` объявлены как `uuid` без
FK — первое разрывает цикл с `tenant_payments`, второе ждёт `media_assets` (0009).

### 0009_media_assets.sql

Расширение реестра файлов. Идёт до всего, что ссылается на `media_assets`: `28`
(`users.resume_asset_id`), `29` (`vacancy_applications`), `30` (`interview_turns`,
`candidate_summaries`), `36` (`content_reports`), `38` (`person_documents`).

- `alter table media_assets` — 19 колонок, 3 констрейнта (`origin` в редакции `34`,
  далее будет заменён в 0019), 7 индексов

Зависимости: `media_assets`, `users`, `courses`, `course_categories`, `enrollments`.

### 0010_storage.sql

- `storage_usage_counters`, `storage_usage_daily`, `storage_retention_policies`,
  `storage_deletion_requests`, `storage_quota_addons`, `storage_pending_uploads`

Зависимости: 0009, `course_categories`, `enrollments`, `users`.
`storage_usage_counters` и `storage_usage_daily` используют `unique nulls not distinct` —
требуется Postgres 15+, у нас 16 (AUTHORS.md).

### 0011_org_structure.sql

- `org_nodes` (самоссылка `parent_id`), `org_node_assignments`, `org_manager_map`,
  `org_structure_snapshots`, `org_structure_conflicts`

Зависимости: 0004 (`ltree`), `positions`, `org_units`, `locations`, `users`,
`user_placements`.

### 0012_vacancies.sql

Внутренний порядок внутри файла важен: `vacancy_templates` создаётся **раньше**
`vacancies`, потому что `vacancies.template_id` на неё ссылается. Это прямо оговорено в
`29` §3.1.

1. `vacancy_templates`
2. `vacancies`
3. `vacancy_languages`
4. `vacancy_criteria`

Зависимости: `course_categories`, `users`, `courses`, `course_versions`, `locations`,
`org_units`, `positions`.

### 0013_users_candidate.sql — узел двух циклов

**Цикл 1:** `users.vacancy_id → vacancies`, а `vacancies.recruiter_id → users`.
**Цикл 2:** `users.candidate_status_id → candidate_statuses`, а
`candidate_statuses.created_by → users`.

Оба разрываются одинаково: справочник и `vacancies` уже созданы (0006, 0012), и только
теперь `users` получает колонки и внешние ключи.

- `alter table users` — 13 колонок из `28`, 3 констрейнта, 4 индекса
- `alter table users add constraint users_candidate_status_fk foreign key
  (candidate_status_id) references candidate_statuses(id)`
- `alter table users add constraint users_vacancy_fk foreign key (vacancy_id)
  references vacancies(id)`

Зависимости: 0006, 0009 (`resume_asset_id → media_assets`), 0012.

`resume_asset_id` получает FK здесь же, поскольку `media_assets` расширена в 0009.

### 0014_candidates.sql

- `candidate_scores`, `candidate_comments`, `candidate_status_history`,
  `vacancy_criterion_scores`

Зависимости: 0012 (`vacancy_criteria`), 0013 (`users.kind`), 0006
(`candidate_status_history` → `candidate_statuses`), `scales` и `scale_levels` из
базового ТЗ (`02`, раздел «Геймификация и шкалы») — см. §9, Р-4.

`vacancy_criterion_scores` физически принадлежит `29`, но создаётся здесь: он ссылается
на кандидата и по смыслу сворачивается в `candidate_scores`.

### 0015_job_boards.sql

- `job_board_accounts`, `vacancy_publications`, `vacancy_applications`,
  `public_apply_attempts`, `vacancy_ai_generations`

Зависимости: 0012 (`vacancies`), 0009 (`media_assets`), 0013 (`vacancy_applications
.candidate_id → users`), `tenant_secrets` (базовое ТЗ).

### 0016_ai_core.sql

- `ai_providers` (самоссылка `fallback_provider_id`), `ai_calls`

Зависимости: `users`, `tenants`. Оси расхода (`usage_axis`) согласованы с `35` §7.1 и
здесь не переопределяются.

### 0017_ai_interview.sql

- `alter table quizzes` — `mode` + констрейнт
- `alter table attempt_answers` — `input_mode` + констрейнт
- `interview_scenarios`, `interview_criteria`, `interview_consents`,
  `interview_sessions`, `interview_turns`, `interview_criterion_scores`

Зависимости: `quizzes`, `attempts`, `attempt_answers` (базовое ТЗ), 0009
(`interview_turns.media_id`), 0014 (`interview_sessions.candidate_score_id →
candidate_scores`), 0016 (`interview_criterion_scores.ai_call_id → ai_calls`).

**Порядок внутри файла:** `alter` идут первыми — `interview_scenarios.quiz_id` требует,
чтобы у `quizzes` уже был `mode='interview'` как допустимое значение.
> [исправлено, PR-28 по `44` В-12] Колонки `mode` нет: `quizzes_kind_chk` с тремя значениями `kind`
> (`quiz | certification | interview`), миграция `0095_v2_interview`.

### 0018_ai_artifacts.sql

- `candidate_summaries`, `ai_review_hints`, `ai_quality_reviews`

Зависимости: 0013 (`users`), 0009 (`media_assets`), 0016 (`ai_calls`).
`candidate_summaries.vacancy_id` объявлен как `uuid` без FK — мягкая ссылка, вакансия к
моменту выдачи резюме может быть закрыта и архивирована.

### 0019_media_origin_v2.sql

Единый перечень `origin` — полный SQL в §4.2. Стоит здесь, потому что все таблицы,
пишущие `interview_answer` (0017, 0018), уже существуют, а таблицы `38`, пишущие
`person_document`, появятся в 0026. Плюс строки `storage_retention_policies` для двух
новых значений (§4.3).

Зависимости: 0009, 0010, 0017, 0018.

### 0020_library.sql — цикл `lessons ↔ library_modules`

`library_modules.draft_lesson_id → lessons`, `library_module_versions.lesson_id →
lessons`, и обратно `lessons.library_module_id → library_modules`,
`lessons.library_version_id → library_module_versions`. Плюс внутренний цикл
`library_modules.current_version_id → library_module_versions.library_module_id →
library_modules`. Порядок внутри файла:

1. `library_modules` — **без** FK на `current_version_id`
2. `library_module_versions`
3. `alter table library_modules add constraint library_modules_current_version_fk`
4. `library_module_usages`, `library_module_proposals`
5. `alter table lessons` — `alter column module_id drop not null`,
   `library_module_id`, `library_version_id`, констрейнты `lessons_owner_ck`,
   `lessons_library_ref_ck` и `lessons_library_body_ck`, два индекса

> [исправлено, PR-25: третий констрейнт `lessons_library_body_ck` (в R1 телом модуля бывает
> только материал, Р-31.7) и второй индекс по `library_version_id`; `lessons.library_version_id`
> — `on delete set null`, а не `restrict`: иначе `tenant.purge` (удаление по таблицам с
> повтором) упирается в цикл «урок курса → версия → урок-снимок» и не сходится. Шаг 6
> (`trajectory_nodes`) — отдельной миграцией PR-26, `45` §5] Ранее: «констрейнты
> `lessons_owner_ck` и `lessons_library_ref_ck`, индекс»; шаг 6 в том же файле.
6. `alter table trajectory_nodes` — `library_version_id`, индекс

Шаг 5 обязан идти последним: `lessons_owner_ck` требует, чтобы у каждой существующей
строки было заполнено ровно одно из двух владений, и до создания
`library_modules` констрейнт не с чем сверять.

Зависимости: 0004 (`vector`), `lessons`, `trajectory_nodes`, `course_categories`,
`media_assets`, `users`.

### 0021_lifecycle_people.sql

- `employee_lifecycle_state`, `offboarding_cases`

Зависимости: 0005 (`lifecycle_stages`), `users`, `enrollments`.
Вынесено из 0005, потому что `employee_lifecycle_state` ссылается на `users`, а
`offboarding_cases` — на `enrollments`; справочник же нужен `courses` гораздо раньше.

### 0022_review_queue.sql — цикл `review_queue_items ↔ review_delegations`

`review_delegations.queue_item_id → review_queue_items`, а
`review_queue_items.delegation_id → review_delegations`. Порядок внутри файла:

1. `alter table review_queue_items` — 21 колонка (`delegation_id` и
   `assigned_by_rule_id` пока без FK), 4 констрейнта, 3 индекса
2. `review_routing_rules`
3. `review_delegations`
4. `alter table review_queue_items add constraint rqi_delegation_fk foreign key
   (delegation_id) references review_delegations(id)`
5. `alter table review_queue_items add constraint rqi_rule_fk foreign key
   (assigned_by_rule_id) references review_routing_rules(id)`

Зависимости: `review_queue_items` (`lola-spec/docs/14-certification.md` §3.3 — см. §9,
Р-3), `users`.

### 0023_review_ops.sql

- `reviewer_capacity`, `reviewer_absences`, `review_sla_events`, `reviewer_stats_daily`

Зависимости: 0022 (`review_sla_events.queue_item_id`), `users`.

### 0024_time_tracking.sql

- `content_time_norms`, `learning_time_sessions`, `learning_time_totals`
- `alter table lesson_progress` — 3 колонки
- `alter table attempts` — 2 колонки
- `alter table workshop_submissions` — 2 колонки

Зависимости: `enrollments`, `users`, `lesson_progress`, `attempts`,
`workshop_submissions` (базовое ТЗ). От 0022 не зависит: `review_queue_items` берёт
снимок нормы числом, а не ссылкой.

### 0025_content_feedback.sql

- `content_issues`, `content_reports`, `content_issue_events`,
  `content_issue_routing_rules`, `content_reporter_stats`

> [исправлено, реализация: модуль лёг двумя миграциями — `0069_v2_content_issues` (PR-23, четыре
> таблицы подачи) и `0077_v2_content_routing` (PR-24, `content_issue_routing_rules`). Вторая
> добавляет два `alter table` к базовым таблицам, которых в этом перечне не было:
> `course_categories.owner_id` («владелец категории курса», `36` §7.5 в) и `attempt_results.issue_id`
> (запись пересчёта ссылается на карточку, `36` §7.8)] Ранее: одна миграция без `alter table`

Зависимости: 0009 (`content_reports.screenshot_media_id`), `users`, `enrollments`,
`lessons`, `attempts`, `course_categories`, `roles`.
`content_issues.target_id` — намеренно полиморфная мягкая ссылка без FK: целью бывает
блок внутри `lessons.body`, у которого нет своей строки.

### 0026_people_extensions.sql

- `alter table users` — 3 колонки из `38` + индекс `idx_users_tenant_rating`
- `user_activity_events`, `user_activity_daily`, `person_notes`,
  `person_document_types`, `person_documents`, `absence_norms`, `absence_records`,
  `person_rating_snapshots`

Зависимости: 0013 (индекс `idx_users_tenant_rating` содержит `where kind='employee'` —
колонка `kind` должна существовать), 0019 (`person_documents.media_id` требует значения
`person_document` в перечне `origin`), `locations`, `users`.

**Внутри файла `person_document_types` создаётся раньше `person_documents`.**

### 0027_indexes_delta.sql

Недостающие tenant-first индексы, найденные проверкой §7.

### 0028_rls_delta.sql

Применение `app_apply_tenant_rls` ко всем 71 тенантной таблице пакета — полный SQL
в §6.3. Обязан быть **последним**: функция ставит политику и выдаёт гранты, и таблица,
созданная после него, останется без политики и без грантов.

### 5.1 Карта межмодульных зависимостей

Список зависимостей, из-за которых порядок нельзя переставлять. Каждая строка — причина,
по которой левый документ обязан лечь раньше правого.

| Раньше | Позже | Через что |
|---|---|---|
| `33` (0005) | базовые `courses` | `courses.lifecycle_stage_id → lifecycle_stages` |
| `28` справочник (0006) | `28` `users` (0013) | `users.candidate_status_id → candidate_statuses` |
| `35` платформа (0007) | `35` тенант (0008) | `tenant_addons.addon_code → plan_addons.code` |
| `34` (0009) | `28`, `29`, `30`, `36`, `38` | пять таблиц ссылаются на `media_assets` |
| `29` (0012) | `28` `users` (0013) | `users.vacancy_id → vacancies` |
| `29` `vacancy_templates` | `29` `vacancies` | `vacancies.template_id → vacancy_templates` |
| `28` `users` (0013) | `29` отклики (0015) | `vacancy_applications.candidate_id → users` |
| `28` `candidate_scores` (0014) | `30` (0017) | `interview_sessions.candidate_score_id` |
| `30` `ai_calls` (0016) | `30` оценки (0017, 0018) | `ai_call_id` в трёх таблицах |
| `30` (0017–0018) | перечень `origin` (0019) | значение `interview_answer` |
| перечень `origin` (0019) | `38` (0026) | значение `person_document` |
| `31` `library_modules` | `31` `lessons` | `lessons_owner_ck` |
| `37` очередь (0022) | `37` операции (0023) | `review_sla_events.queue_item_id` |
| всё | RLS (0028) | политика ставится по факту существования таблицы |

---

## 6. RLS

### 6.1 Тенантные таблицы — 71

Ко всем применяется `app_apply_tenant_rls(regclass)` из `0002_rls.sql`: она включает
`enable` + `force`, пересоздаёт политику `tenant_isolation` с `using` **и** `with check`
и выдаёт гранты роли `app_user`. Функция идемпотентна.

Все 71 таблица имеет `tenant_id uuid not null references tenants(id) on delete cascade`
— проверено по DDL всех одиннадцати документов, исключений нет.

`candidate_statuses`, `candidate_scores`, `candidate_comments`,
`candidate_status_history`, `vacancies`, `vacancy_languages`, `vacancy_criteria`,
`vacancy_criterion_scores`, `vacancy_templates`, `job_board_accounts`,
`vacancy_publications`, `vacancy_applications`, `public_apply_attempts`,
`vacancy_ai_generations`, `ai_providers`, `ai_calls`, `interview_scenarios`,
`interview_criteria`, `interview_consents`, `interview_sessions`, `interview_turns`,
`interview_criterion_scores`, `candidate_summaries`, `ai_review_hints`,
`ai_quality_reviews`, `library_modules`, `library_module_versions`,
`library_module_usages`, `library_module_proposals`, `org_nodes`,
`org_node_assignments`, `org_manager_map`, `org_structure_snapshots`,
`org_structure_conflicts`, `lifecycle_stages`, `employee_lifecycle_state`,
`offboarding_cases`, `storage_usage_counters`, `storage_usage_daily`,
`storage_retention_policies`, `storage_deletion_requests`, `storage_quota_addons`,
`storage_pending_uploads`, `tenant_addons`, `usage_counters`, `usage_events`,
`tenant_payments`, `plan_change_requests`, `limit_notices`, `content_issues`,
`content_reports`, `content_issue_events`, `content_issue_routing_rules`,
`content_reporter_stats`, `review_delegations`, `review_routing_rules`,
`reviewer_capacity`, `reviewer_absences`, `review_sla_events`, `reviewer_stats_daily`,
`content_time_norms`, `learning_time_sessions`, `learning_time_totals`,
`user_activity_events`, `user_activity_daily`, `person_notes`,
`person_document_types`, `person_documents`, `absence_norms`, `absence_records`,
`person_rating_snapshots`.

### 6.2 Платформенные таблицы вне RLS — 2

| Таблица | Документ | Почему вне RLS |
|---|:-:|---|
| `plan_prices` | 35 §3.4 | Цены тарифов общие для всей платформы. `tenant_id` здесь означал бы, что у каждого тенанта своя цена на один и тот же тариф — а это не так: индивидуальная цена выражается через `tenant_payments.kind='adjustment'` и `tenant_limits.overrides`, а не через копию прайса. Приложению — `grant select` на строки действующего периода, запись — роль `platform_admin` |
| `plan_addons` | 35 §3.4 | Каталог докупаемых опций общий: `storage_pack`, `ai_ops_pack`, `sms_pack`, `candidates_pack`, `ai_term`. Первичный ключ — `code`, на который ссылается тенантная `tenant_addons.addon_code`. Тенантная копия каталога сделала бы `tenant_addons` несравнимыми между тенантами и сломала бы биллинговую отчётность платформы |

Обе — по правилу `lola-spec/docs/25-multitenancy.md` §3.1 и прямому указанию
`35-billing-limits.md` §3.6.

> [дополнено, PR-39] Третья платформенная таблица — `platform_announcements` (патчи `39` П-21,
> П-24.2): объявление оператора одно на платформу, адресация колонками строки; у `app_user` на
> неё только `select`. Её отметки прочтения — тенантная `platform_announcement_reads` под RLS.
> Вместе с `position_groups`, `user_totp`, `user_totp_recovery_codes` это четыре тенантные таблицы
> сверх 71 — их вводят патчи к базовому ТЗ, а не модульные документы §2.

К ним **не применяется** `app_apply_tenant_rls`: у функции политика строится по
`tenant_id = app_current_tenant()`, а колонки нет — вызов завершится ошибкой. Это
поведение полезно: случайное включение такой таблицы в список §6.3 упадёт на миграции,
а не тихо откроет чужие данные.

Существующая платформенная `plans` (стадия 0) остаётся вне RLS и после добавления
9 колонок в 0007. `tenants` сохраняет собственную политику `tenant_self` из `0002_rls.sql`.

### 6.3 Готовый блок — миграция `0028_rls_delta.sql`

```sql
-- Lola LMS — миграция 0028. RLS для 71 тенантной таблицы пакета 28–38.
--
-- Список задан явно, а не выборкой по наличию tenant_id: выборка молча пропустит
-- таблицу, в которой tenant_id забыли, и тест §8 упадёт уже на проде. Явный список
-- падает здесь, на накате, с именем таблицы в тексте ошибки.
--
-- plan_prices и plan_addons в списке отсутствуют намеренно: они платформенные,
-- у них нет tenant_id, и app_apply_tenant_rls на них завершится ошибкой (§6.2).

do $$
declare
  t text;
  tenant_tables text[] := array[
    -- 28. Рекрутинг: кандидаты
    'candidate_statuses','candidate_scores','candidate_comments','candidate_status_history',
    -- 29. Рекрутинг: вакансии
    'vacancies','vacancy_languages','vacancy_criteria','vacancy_criterion_scores',
    'vacancy_templates','job_board_accounts','vacancy_publications','vacancy_applications',
    'public_apply_attempts','vacancy_ai_generations',
    -- 30. ИИ
    'ai_providers','ai_calls','interview_scenarios','interview_criteria','interview_consents',
    'interview_sessions','interview_turns','interview_criterion_scores','candidate_summaries',
    'ai_review_hints','ai_quality_reviews',
    -- 31. Библиотека модулей
    'library_modules','library_module_versions','library_module_usages','library_module_proposals',
    -- 32. Оргструктура
    'org_nodes','org_node_assignments','org_manager_map','org_structure_snapshots',
    'org_structure_conflicts',
    -- 33. Жизненный цикл
    'lifecycle_stages','employee_lifecycle_state','offboarding_cases',
    -- 34. Хранилище
    'storage_usage_counters','storage_usage_daily','storage_retention_policies',
    'storage_deletion_requests','storage_quota_addons','storage_pending_uploads',
    -- 35. Биллинг (тенантная часть)
    'tenant_addons','usage_counters','usage_events','tenant_payments',
    'plan_change_requests','limit_notices',
    -- 36. Обратная связь по контенту
    'content_issues','content_reports','content_issue_events',
    'content_issue_routing_rules','content_reporter_stats',
    -- 37. Проверка, делегирование, время
    'review_delegations','review_routing_rules','reviewer_capacity','reviewer_absences',
    'review_sla_events','reviewer_stats_daily','content_time_norms',
    'learning_time_sessions','learning_time_totals',
    -- 38. Люди
    'user_activity_events','user_activity_daily','person_notes','person_document_types',
    'person_documents','absence_norms','absence_records','person_rating_snapshots'
  ];
begin
  if array_length(tenant_tables, 1) <> 71 then
    raise exception 'Ожидается 71 тенантная таблица пакета, в списке %',
      array_length(tenant_tables, 1);
  end if;

  foreach t in array tenant_tables loop
    if to_regclass('public.' || t) is null then
      raise exception 'Таблица % отсутствует: миграция 0028 выполняется раньше её создания', t;
    end if;
    perform app_apply_tenant_rls(('public.' || t)::regclass);
  end loop;
end $$;

-- Платформенные таблицы пакета: чтение каталога и прайса приложению нужно,
-- запись — только роли platform_admin.
grant select on plan_prices to app_user;
grant select on plan_addons to app_user;
```

---

## 7. Индексы

Правило из `0003_indexes.sql` и `lola-spec/docs/02-data-model.md` §«Что проверяет тест
схемы»: **каждый индекс по таблице с `tenant_id` начинается с `tenant_id`**, иначе
планировщик идёт по всей таблице, а RLS отфильтровывает результат уже после. На тенанте
в сто человек это незаметно, на сотом тенанте это отказ сервиса. В базовом проекте этот
баг уже был, поэтому проверка ниже — не формальность.

### 7.1 Результат проверки

Все 71 тенантная таблица пакета имеет хотя бы один индекс, начинающийся с `tenant_id`.
Таблиц вообще без tenant-first индекса **нет**.

Но у трёх таблиц единственный tenant-first индекс — **частичный** (`where …`), а
частичный индекс не обслуживает запрос, выходящий за его предикат. Планировщик на таком
запросе уходит в seq scan по всей таблице всех тенантов.

| Таблица | Документ | Единственный tenant-first индекс | Что остаётся без индекса |
|---|:-:|---|---|
| `limit_notices` | 35 | `limit_notices_open_uidx (tenant_id, axis, level) where resolved_at is null` | История снятых предупреждений: экран «Ліміти» показывает и закрытые, отчёт по превышениям за период читает именно их |
| `review_routing_rules` | 37 | `idx_review_routing_rules_tenant (tenant_id, priority) where is_active` | Экран настройки правил показывает и выключенные правила — иначе их нельзя включить обратно |
| `person_notes` | 38 | `idx_person_notes_tenant (tenant_id, user_id, created_at desc) where archived_at is null` | Архив заметок: `38` §4 прямо описывает переход `active → archived` с последующим показом, а `gdpr.erase` обходит все заметки человека, включая архивные |

Отдельно проверены и **признаны достаточными**:

- `ai_providers` — партиальный `idx_ai_providers_tenant … where is_active`, но есть
  `unique (tenant_id, code)`, который Postgres обслуживает полным btree с `tenant_id`
  первым. Добавлять нечего.
- `org_manager_map`, `usage_counters` — tenant-first составной первичный ключ.
- `storage_usage_counters`, `storage_usage_daily` — tenant-first `unique nulls not
  distinct`.
- `org_nodes` — помимо gist-индекса по `path` есть полный `idx_org_nodes_tenant
  (tenant_id)`.
- `library_modules` — gin по `search_tsv` и hnsw по `embedding` не начинаются с
  `tenant_id` по своей природе, но рядом есть три полных btree с `tenant_id` первым.
  Фильтрация тенанта на поисковых запросах идёт после, и это осознанная цена
  полнотекстового и векторного поиска; RLS корректность при этом не страдает.

### 7.2 Недостающие индексы — миграция `0027_indexes_delta.sql`

```sql
-- Lola LMS — миграция 0027. Недостающие tenant-first индексы пакета 28–38.
-- Частичный индекс не обслуживает запрос вне своего предиката: три таблицы
-- имели только его и уходили в seq scan на «архивных» выборках.

create index idx_limit_notices_tenant
  on limit_notices (tenant_id, raised_at desc);

create index idx_review_routing_rules_tenant_all
  on review_routing_rules (tenant_id, priority);

create index idx_person_notes_tenant_all
  on person_notes (tenant_id, user_id, created_at desc);
```

Частичные индексы из документов-владельцев **не удаляются**: они остаются более узкими и
дешёвыми для горячего пути (открытые предупреждения, активные правила, неархивные
заметки), а новые покрывают холодный.

---

## 8. Контрактные тесты

Набор запросов, каждый из которых должен возвращать **ноль строк**. Любая непустая
выдача — расхождение кода с этим документом, и чинится оно либо миграцией, либо
пересборкой этого документа (§1), но никогда — ослаблением теста.

Запускаются через `psql` под ролью миграций после наката всего пакета; в CI
соответствуют `tests/integration/rls-completeness` и `tests/integration/schema-parity`.

> [исправлено, PR-40: тесты разложены по файлам `HANDOFF` §7.2 «по одному файлу на проверку»]
> Ранее: «в CI соответствуют `tests/integration/rls-completeness` и `tests/integration/schema-parity`».
> Файлы `tests/integration/v2-contract-NN-*.spec.ts`; номера 01–05 — нумерация `HANDOFF` §7.2,
> 06–09 — нумерация этого раздела и `44` В-13. Все зелёные на свежей базе (PR-40).
>
> | Тест §8 | Файл | Что держит |
> |---|---|---|
> | 1, 2 | `v2-contract-01-rls.spec.ts` (`HANDOFF` №1) | RLS `enable`+`force`, политика `tenant_isolation` с `using` и `with check` |
> | 3 | `v2-contract-02-tenant-index.spec.ts` (№2) | полный tenant-first индекс |
> | 4 | `v2-contract-03-tenants-fk.spec.ts` (№3) | FK на `tenants` с `on delete cascade` |
> | 5 | `v2-contract-04-media-origin.spec.ts` (№4) | перечень `origin` в обе стороны + ровно один `check` |
> | — | `v2-contract-05-schema-parity.spec.ts` (№5) | нет `attempts`, `pass_score`, `due_at`, `time_limit` в таблицах пакета |
> | 6 | `v2-contract-06-package-tables.spec.ts` (PR-40) | состав пакета на длину: 74 тенантные + 3 платформенные, поимённо против §6.1 и §2.13 и против `create table` миграций пакета; все тенантные — под RLS |
> | 7 | `v2-contract-07-users-columns.spec.ts` (PR-40) | колонки пакета в `users` — 18 по факту (§2.13 п. 11), каждая одной миграцией; `hired_at` одна и `date` |
> | 8 | `v2-contract-06-package-tables.spec.ts`, второй блок (PR-40) | `plans`, `plan_prices`, `plan_addons`, `platform_announcements` — без `tenant_id` и вне RLS |
> | 9 | `v2-contract-09-deferred-fk.spec.ts` (`44` В-13) | четыре отложенных FK по имени, на своей таблице и колонке, `on delete set null` |

### Тест 1. Все таблицы с `tenant_id` имеют RLS enable + force

```sql
select c.relname as table_name,
       c.relrowsecurity      as rls_enabled,
       c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid
                   and a.attname = 'tenant_id'
                   and a.attnum > 0
                   and not a.attisdropped
where c.relkind = 'r'
  and n.nspname = 'public'
  and not (c.relrowsecurity and c.relforcerowsecurity)
order by 1;
```

### Тест 2. У каждой такой таблицы есть политика `tenant_isolation` с `using` и `with check`

```sql
select c.relname as table_name,
       coalesce(p.polname, '(політики немає)') as policy_name,
       p.polqual   is not null as has_using,
       p.polwithcheck is not null as has_with_check
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid
                   and a.attname = 'tenant_id'
                   and a.attnum > 0
                   and not a.attisdropped
left join pg_policy p on p.polrelid = c.oid
                     and p.polname = 'tenant_isolation'
where c.relkind = 'r'
  and n.nspname = 'public'
  and (p.polname is null or p.polqual is null or p.polwithcheck is null)
order by 1;
```

### Тест 3. У каждой таблицы с `tenant_id` есть полный (непартиальный) tenant-first индекс

```sql
select c.relname as table_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid
                   and a.attname = 'tenant_id'
                   and a.attnum > 0
                   and not a.attisdropped
where c.relkind = 'r'
  and n.nspname = 'public'
  and not exists (
    select 1
    from pg_index i
    where i.indrelid = c.oid
      and i.indkey[0] = a.attnum   -- tenant_id стоит первым в ключе
      and i.indpred is null        -- частичный индекс не засчитывается
      and i.indisvalid
  )
order by 1;
```

### Тест 4. Ни одна таблица пакета не создана без FK на `tenants` с каскадом

```sql
with package_tables(t) as (values
  ('candidate_statuses'),('candidate_scores'),('candidate_comments'),('candidate_status_history'),
  ('vacancies'),('vacancy_languages'),('vacancy_criteria'),('vacancy_criterion_scores'),
  ('vacancy_templates'),('job_board_accounts'),('vacancy_publications'),('vacancy_applications'),
  ('public_apply_attempts'),('vacancy_ai_generations'),
  ('ai_providers'),('ai_calls'),('interview_scenarios'),('interview_criteria'),('interview_consents'),
  ('interview_sessions'),('interview_turns'),('interview_criterion_scores'),('candidate_summaries'),
  ('ai_review_hints'),('ai_quality_reviews'),
  ('library_modules'),('library_module_versions'),('library_module_usages'),('library_module_proposals'),
  ('org_nodes'),('org_node_assignments'),('org_manager_map'),('org_structure_snapshots'),
  ('org_structure_conflicts'),
  ('lifecycle_stages'),('employee_lifecycle_state'),('offboarding_cases'),
  ('storage_usage_counters'),('storage_usage_daily'),('storage_retention_policies'),
  ('storage_deletion_requests'),('storage_quota_addons'),('storage_pending_uploads'),
  ('tenant_addons'),('usage_counters'),('usage_events'),('tenant_payments'),
  ('plan_change_requests'),('limit_notices'),
  ('content_issues'),('content_reports'),('content_issue_events'),
  ('content_issue_routing_rules'),('content_reporter_stats'),
  ('review_delegations'),('review_routing_rules'),('reviewer_capacity'),('reviewer_absences'),
  ('review_sla_events'),('reviewer_stats_daily'),('content_time_norms'),
  ('learning_time_sessions'),('learning_time_totals'),
  ('user_activity_events'),('user_activity_daily'),('person_notes'),('person_document_types'),
  ('person_documents'),('absence_norms'),('absence_records'),('person_rating_snapshots')
)
select p.t as table_name,
       case when to_regclass('public.' || p.t) is null
            then 'таблиці немає'
            else 'немає FK на tenants з on delete cascade'
       end as problem
from package_tables p
where to_regclass('public.' || p.t) is null
   or not exists (
     select 1
     from pg_constraint con
     join pg_class child  on child.oid  = con.conrelid
     join pg_class parent on parent.oid = con.confrelid
     where con.contype = 'f'
       and child.relname  = p.t
       and parent.relname = 'tenants'
       and con.confdeltype = 'c'      -- on delete cascade
   )
order by 1;
```

### Тест 5. Перечень `media_assets.origin` в БД совпадает со списком §4

```sql
with expected(v) as (values
  ('content_cover'),('lesson_attachment'),('workshop_submission'),('video_answer'),
  ('candidate_cv'),('certificate'),('import'),('checklist_photo'),('avatar'),
  ('brand_asset'),('ai_artifact'),('report_export'),('interview_answer'),
  ('person_document'),('issue_screenshot'),('other')
),
def as (
  select pg_get_constraintdef(oid) as d
  from pg_constraint
  where conname = 'media_assets_origin_chk'
),
actual(v) as (
  -- Postgres нормализует `origin in (...)` в `origin = ANY (ARRAY['a'::text, ...])`
  select btrim(replace(part, '::text', ''), ' ''')
  from def,
       regexp_split_to_table(substring(d from '\[(.*)\]'), ',\s*') as part
)
select coalesce(e.v, a.v) as origin_value,
       case when e.v is null then 'зайве значення в БД'
            else 'значення відсутнє в БД' end as problem
from expected e
full join actual a on a.v = e.v
where e.v is null or a.v is null
order by 1;
```

Дополнительно — констрейнт вообще должен существовать и быть единственным по этой
колонке (два независимых `check` по `origin` дают неразрешимую ошибку вставки, `38` §3.2):

```sql
select count(*) as origin_checks
from pg_constraint con
join pg_class c on c.oid = con.conrelid
where c.relname = 'media_assets'
  and con.contype = 'c'
  and pg_get_constraintdef(con.oid) like '%origin%'
having count(*) <> 1;
```

### Тест 6. Состав пакета: 73 таблицы, 71 тенантная, 2 платформенные

```sql
with package_tables(t, expected_kind) as (values
  ('plan_prices','platform'),('plan_addons','platform')
  -- остальные 71 имя — из теста 4, с expected_kind = 'tenant'
)
select p.t as table_name,
       p.expected_kind,
       exists (
         select 1 from pg_attribute a
         where a.attrelid = ('public.' || p.t)::regclass
           and a.attname = 'tenant_id' and not a.attisdropped
       ) as has_tenant_id
from package_tables p
where to_regclass('public.' || p.t) is not null
  and (p.expected_kind = 'platform') = exists (
        select 1 from pg_attribute a
        where a.attrelid = ('public.' || p.t)::regclass
          and a.attname = 'tenant_id' and not a.attisdropped
      )
order by 1;
```

Платформенная таблица с `tenant_id` и тенантная без него одинаково валят этот запрос.

### Тест 7. Ни одна колонка не добавлена дважды

Прямого запроса не существует — Postgres не даёт добавить колонку дважды, вторая
миграция упадёт. Поэтому тест ставится на **состав**: в `users` ровно 16 новых колонок
пакета и среди них нет второй `hired_at`.

```sql
with expected(v) as (values
  ('kind'),('candidate_state'),('candidate_status_id'),('source'),('source_detail'),
  ('vacancy_id'),('recruiter_id'),('access_until'),('comm_language'),('resume_asset_id'),
  ('converted_from_candidate_at'),('consent_given_at'),('consent_expires_at'),
  ('rating_pct'),('rating_updated_at'),('timezone')
)
select e.v as column_name, 'колонки немає в users' as problem
from expected e
where not exists (
  select 1 from pg_attribute a
  where a.attrelid = 'public.users'::regclass
    and a.attname = e.v
    and not a.attisdropped
)
union all
select 'hired_at', 'hired_at має бути рівно одна і типу date або timestamptz'
from pg_attribute a
where a.attrelid = 'public.users'::regclass
  and a.attname = 'hired_at'
  and not a.attisdropped
group by 1, 2
having count(*) <> 1;
```

### Тест 8. Платформенные таблицы не попали под RLS

```sql
select c.relname as table_name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('plans','plan_prices','plan_addons')
  and (c.relrowsecurity or c.relforcerowsecurity);
```

---

## 9. Риски и открытые вопросы

### Р-1. Перечень `origin` пересобирается документом `38` и теряет значение документа `30`

**Расхождение между документами, а не ошибка одного из них.** `34` §3.2 задаёт закрытый
`check` из 13 значений. `30` §3.7 патчем `П-30.1` добавляет `interview_answer`. `38`
§3.2 делает `drop constraint` + `add constraint` со своим списком из 14 значений, в
котором `interview_answer` нет — документ `38` писался от редакции `34`, не зная о
патче `30`. Если миграции лягут в порядке «30 → 38», запись реплики собеседования
перестанет вставляться, а тест 5 §8 упадёт.

**Предложение (реализовано в §4 и §5):** перечень собирается один раз отдельной
миграцией `0019`, после таблиц `30` и до таблиц `38`; §4.2 и есть эта редакция. Правки
требует модульный документ `38` §3.2 — его SQL надо заменить ссылкой на §4.2 этого
документа. Молча исполнять `38` дословно нельзя.

### Р-2. Документ `38` описывает документ `28` в редакции, которой уже нет

`38` §3.1 утверждает, что `28` §3.2 «повторно добавляет `hired_at` как `timestamptz`»,
и предписывает исправить это правкой в `28`. Правка в `28` **уже сделана**: там стоит
комментарий «Новую колонку не добавляем» и колонки в списке `add column` нет.

**Предложение:** снять из `38` §3.1 предписание править `28`, оставив только факт
«`hired_at` существует в базовом ТЗ как `date`, никем не добавляется повторно, при
необходимости меняется тип». Это косметика, но она отнимает время у каждого, кто будет
сверять два документа перед миграцией 0013.

### Р-3. `review_queue_items` описана как витрина, но документ `37` меняет её как таблицу

`lola-spec/docs/14-certification.md` §3.3 объявляет `review_queue_items` «витриной поверх
двух источников» с полями `source` и `source_id`. В `lola-spec/docs/02-data-model.md`
таблицы нет ни в одном разделе. Документ `37` §3.1 делает по ней `alter table`, добавляет
21 колонку с собственным состоянием (`assigned_reviewer_id`, `sla_breached_at`,
`delegation_depth`) и ставит на неё FK из `review_delegations` и `review_sla_events`.

Витрина такого не выдерживает: собственное состояние нельзя пересчитать из источников,
а FK на представление Postgres не даёт поставить вовсе.

**Предложение:** признать `review_queue_items` обычной таблицей, наполняемой сервисом
при появлении работы на проверку, и внести её DDL в `lola-spec/docs/02-data-model.md`
до миграции 0022. Решение принимает владелец базового ТЗ, не этот документ.

### Р-4. `candidate_scores` зависит от `scales` и `scale_levels` из стадии R2–R3

`candidate_scores.scale_id` и `scale_level_id` ссылаются на `scales` и `scale_levels`,
которые в базовом ТЗ лежат в разделе «Таблицы модулей R2–R3» (`02` §2.15), то есть в
более поздней стадии, чем стадия 0. Миграция 0014 не выполнится, пока их нет.

**Предложение:** вынести `scales` и `scale_levels` в стадию 0 отдельной ранней
миграцией — они маленькие, ни от чего не зависят и нужны ещё трём модулям пакета. Если
это невозможно, `candidate_scores` создаётся без этих двух FK, а FK добавляются
миграцией стадии R2. Второй вариант хуже: до неё ничто не мешает записать чужой
`scale_level_id`.

### Р-5. Два расширения Postgres не создаются ни одной существующей миграцией

`0001_foundation.sql` создаёт `pgcrypto` и `pg_trgm`. Пакету нужны ещё два: `ltree`
(`org_nodes.path` и gist-индекс по нему, `32`) и `vector` (`library_modules.embedding
vector(768)` и hnsw-индекс, `31`). Ни `31`, ни `32` в своих §3 про `create extension` не
пишут — каждый документ справедливо считает это чужой заботой, и в результате это не
забота никого.

**Предложение:** миграция `0004_extensions.sql` (§5). Отмечено здесь, а не только в §5,
потому что это единственный пункт, где пакет падает на чистой базе на первом же файле,
и падает непонятно — ошибкой про неизвестный тип, а не про расширение.

### Р-6. Докупка места описана двумя механизмами в двух документах

`34` §3.3 заводит `storage_quota_addons` со своим `extra_bytes`, `status`, `price_minor`
и формулой эффективного лимита: `plans.limits.storage_bytes +
coalesce(tenant_limits.storage_bytes, 0) + sum(extra_bytes) where status='active'`.
`35` §3.4–3.5 заводит `plan_addons` с кодом `storage_pack` и `tenant_addons` с `qty ×
unit_step`, а §7.3 даёт другую формулу: `coalesce(overrides[axis], plans.limits[axis]) +
Σ(tenant_addons.qty × unit_step)`.

Это два независимых пути купить одно и то же место, две таблицы-источника и две формулы.
В рабочей системе они разойдутся: счётчик квоты будет считать по одной, счёт выставится
по другой. Дополнительно `34` ссылается на колонку `tenant_limits.storage_bytes`,
которой нет — ни в стадии 0 (там `overrides jsonb`), ни среди 10 колонок, добавляемых
документом `35`.

**Предложение:** оставить один механизм — `tenant_addons` с `addon_code='storage_pack'`
(он общий для всех осей и уже завязан на платёжный контур `35`), а
`storage_quota_addons` из `34` не создавать, заменив его представлением поверх
`tenant_addons`. Формула эффективного лимита — одна, из `35` §7.3. Это меняет состав
пакета на одну таблицу (73 → 72), поэтому решение принимается до миграции 0010, а не
после. До принятия решения §2, §5 и §6 оставлены в редакции «73 таблицы».

### Р-7. Три документа дают три разных числа категорий разбивки хранилища

`33` §3.2 фиксирует **8** этапов жизненного цикла и отдельно объясняет, почему не 10.
`35` §3.3 описывает `tenant_usage.storage_by_category` как «разбивка по **10** категориям
треков из `05-tracks.md` плюс `other`». `34` §5.1 описывает тот же экран как разбивку по
**7** подписям. Три числа для одной оси.

**Предложение:** признать источником `33` (восемь `lifecycle_stages.code` плюс `other` =
9 ключей) и привести к нему и `35` §3.3, и подписи экрана в `34` §5.1. `05-tracks.md`
принадлежит пакету-источнику (`lola-spec-sintegrum-additions`), его десять категорий —
таксономия эталона, а не Lola; `33` уже принял решение об отказе от двух из них с
обоснованием.

### Р-8. Документ `38` объявляет «шесть новых таблиц», а создаёт восемь

`38` §3.7 завершается фразой «Все шесть новых таблиц получают RLS», но в §3.3–3.7
создаются восемь: `user_activity_events`, `user_activity_daily`, `person_notes`,
`person_document_types`, `person_documents`, `absence_norms`, `absence_records`,
`person_rating_snapshots`.

**Предложение:** счётная ошибка в тексте, не в DDL. Поправить число в `38`. В §2 и §6
этого документа учтены все восемь; тест 4 §8 поймал бы пропуск любой из них, если бы
кто-то реализовал фразу вместо DDL.

### Р-9. Пакет ссылается на `docs/v2/39-patches.md`, которого в пакете нет

Ссылки на несуществующий документ: `28` §3.1 (`П-16.1` — фильтр `kind` во всех
существующих выборках людей базового ТЗ), `28` §5.5 (`П-24.3` — связь «должность → курсы
по умолчанию»), `30` §3.7 (`П-30.1` — патч перечня `origin`, разобран в Р-1).

`П-16.1` — не косметика: после миграции 0013 каждая выборка людей в базовом ТЗ без
`where kind='employee'` начнёт показывать кандидатов в списках сотрудников, в отчётах по
штату и в аудиториях назначений. Это тот самый риск, который `28` §3.1 называет ценой
решения «один `users` на две сущности».

**Предложение:** `39-patches.md` написать до реализации, и `П-16.1` внести в него
поимённым перечнем затронутых выборок, а не общим правилом. Общее правило здесь не
работает: забытая выборка не упадёт, она молча вернёт лишние строки.

### Р-10. Четыре FK объявлены в таблицах полей, но отсутствуют в DDL

`users.candidate_status_id` и `users.vacancy_id` (`28` §3.2),
`review_queue_items.delegation_id` и `assigned_by_rule_id` (`37` §3.1) описаны в
таблицах полей как FK, но в SQL объявлены просто как `uuid`. В обоих случаях причина
техническая и правильная — цикл ссылок, — но из документов это не видно, и при
реализации легко либо поставить FK слишком рано (миграция упадёт), либо не поставить
вовсе (осиротевшие ссылки на удалённый статус или отозванное делегирование).

**Предложение:** §5 (миграции 0013 и 0022) задаёт обе развязки явно. Дополнительно стоит
добавить в §8 девятый тест — на наличие этих четырёх именованных констрейнтов после
наката; он не написан здесь, потому что имена констрейнтов предложены этим документом и
должны сначала вернуться правкой в `28` и `37`.

### Р-11. Мягкие полиморфные ссылки без FK — осознанные, но ничем не защищённые

`media_assets.source_entity`/`source_id` (`34`), `content_issues.target_type`/`target_id`
(`36`), `library_module_usages.holder_id`/`container_id` (`31`),
`ai_calls.ref_kind`/`ref_id` и `ai_quality_reviews.ref_kind`/`ref_id` (`30`),
`candidate_scores.source_type`/`source_id` (`28`). Шесть мест, где целостность держится
на коде приложения.

Каждое обосновано в своём документе (цель бывает блоком внутри `lessons.body`, у
которого нет строки). Но ни один документ не описывает, что происходит с такой строкой,
когда цель удалена: остаётся висеть, чистится фоновой задачей или блокирует удаление.

**Предложение:** решить одинаково для всех шести — фоновая задача раз в сутки помечает
недостижимые ссылки, строка остаётся (она журнальная), интерфейс показывает «Джерело
видалено». Решение фиксируется правкой в `34` как во владельце самого массового случая,
остальные пять ссылаются на него.

---

**Пересобирать этот документ** нужно после любой правки §3 любого из одиннадцати
документов пакета: состав таблиц (§2), список колонок (§3), перечень `origin` (§4),
порядок миграций (§5), список RLS (§6) и имена в тестах (§8) выводятся из них и
расходятся молча.
