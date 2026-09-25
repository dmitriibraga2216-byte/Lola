/**
 * Единый список таблиц пакета `docs/v2`, растущий по мере реализации плана `docs/v2/45-plan.md`.
 *
 * Источник истины для итогового состава — `docs/v2/40-data-model-delta.md` §8, тесты 4 и 6
 * (71 тенантная таблица пакета + 2 платформенные). Здесь список **не копируется целиком**:
 * ни одна из этих таблиц ещё не создана миграцией, и жёстко зашитый полный перечень сделал бы
 * контрактные тесты (`v2-contract-*.spec.ts`) красными уже сегодня — они проверяют факт
 * в БД, а не намерение в документе.
 *
 * Правило (`docs/v2/45-plan.md`, раздел PR-01): каждый PR, который миграцией создаёт таблицу
 * пакета, добавляет её имя сюда, в том разделе (тенантная/платформенная), к которому она
 * относится. Контрактные тесты RLS, индекса и внешнего ключа автоматически становятся
 * содержательными для добавленной таблицы — им не нужна отдельная правка.
 */

/** Тенантные таблицы пакета (docs/v2/40 §8 тест 4/6) — заполняются по мере миграций. */
export const V2_PACKAGE_TENANT_TABLES: string[] = [
  // 33. Жизненный цикл (PR-05, миграция 0057_v2_lifecycle_stages)
  'lifecycle_stages',
  // 33. Офбординг и состояние человека (PR-07, миграция 0060_v2_offboarding)
  'employee_lifecycle_state',
  'offboarding_cases',
  // 35. Тарифы и лимиты (PR-08, миграция 0059_v2_billing_plans)
  'tenant_addons',
  // 35. Потребление, предупреждения, деградация (PR-09, миграция 0061_v2_billing_usage)
  'usage_counters',
  'usage_events',
  'limit_notices',
  // 28. Рекрутинг: кандидат как запись users (PR-13, миграция 0064_v2_candidates).
  // Самого кандидата в списке нет и не будет: он живёт в `users` с `kind='candidate'`
  // (docs/v2/44 В-8), а здесь — только то, чего у сотрудника не бывает.
  'candidate_statuses',
  'candidate_scores',
  'candidate_comments',
  'candidate_status_history',
  // 37. Делегирование проверки: очередь как источник истины (PR-18, миграция 0066_v2_review_queue).
  // Единственная таблица PR-18: делегирования, правила маршрутизации, ёмкость проверяющих и
  // события SLA (`docs/v2/37` §3.2–3.4) приезжают следующим PR — они ссылаются на эту строку.
  'review_queue_items',
  // 37. Делегирование, распределение, SLA (PR-19, миграция 0080_v2_review_delegation): шесть
  // таблиц `37` §3.2–3.4 поверх очереди и два ключа-развязки из неё (В-13).
  'review_delegations',
  'review_routing_rules',
  'reviewer_capacity',
  'reviewer_absences',
  'review_sla_events',
  'reviewer_stats_daily',
  // 36. Обратная связь по контенту: подача и дедупликация (PR-23, миграция 0069_v2_content_issues).
  // `content_issue_events` здесь, а не в PR-24: критерий приёмки 2 (`36` §13) требует событие
  // `merged` в момент подачи, а `content_issue_routing_rules` придут с разбором.
  'content_issues',
  'content_reports',
  'content_issue_events',
  'content_reporter_stats',
  // 36. Разбор жалобы: маршрутизация, резолюции, пересчёт (PR-24, миграция 0077_v2_content_routing).
  // Пятая и последняя таблица модуля; `course_categories.owner_id` и `attempt_results.issue_id`
  // той же миграции — колонки базовых таблиц, а не таблицы пакета.
  'content_issue_routing_rules',
  // 29. Вакансии: схема, критерии, шаблон параметров (PR-15, миграция 0071_v2_vacancies).
  // Самой вакансии в списке мало: `users.vacancy_id` — колонка кандидата, а не таблица; её
  // ключ `users_vacancy_id_fk` проверяет девятый контрактный тест `deferred-fk.spec.ts`
  // (docs/v2/44 В-13), потому что отложенный ключ теряется тише, чем таблица.
  'vacancy_templates',
  'vacancies',
  'vacancy_languages',
  'vacancy_criteria',
  'vacancy_criterion_scores',
  // 35. Оплата, смена тарифа, экраны (PR-10, миграция 0073_v2_billing_payments)
  'tenant_payments',
  'plan_change_requests',
  // 29. Публичный контур и отклик (PR-16, миграция 0074_v2_vacancy_apply). Обе таблицы
  // тенантные, несмотря на то что пишутся **без сессии**: тенант выводится из токена ссылки
  // (`vacancy_public_lookup`), и дальше запись идёт внутри `withTenant()` — политика RLS
  // здесь не формальность, а единственное, что отделяет отклики разных пространств.
  'vacancy_applications',
  'public_apply_attempts',
  // 29. Публикация и генерация текста (PR-17, миграция — см. заголовок файла миграции).
  // Аккаунты площадок — бухгалтерская запись, не реальное подключение (`v2/HANDOFF` §6):
  // секрет в `secret_ref` — токен адаптера-заглушки, не вендора.
  'job_board_accounts',
  'vacancy_publications',
  'vacancy_ai_generations',
  // 32. Оргструктура: дерево подчинения (PR-30, миграция 0075_v2_org_structure).
  // Пятой таблицы пакета — `org_structure_conflicts` — здесь нет и не будет: решение
  // `docs/v2/44` В-7 свело её к `alter table org_conflicts` (таблица существует с 0033
  // и уже наполняется импортом людей).
  'org_nodes',
  'org_node_assignments',
  'org_manager_map',
  'org_structure_snapshots',
  // 37. Учёт времени биениями (PR-21, миграция 0078_v2_learning_time): сегменты измерения и
  // витрина «человек × элемент × запись». Нормы времени (`content_time_norms`) — PR-22.
  'learning_time_sessions',
  'learning_time_totals',
  // 31. Библиотека модулей и версии (PR-25, миграция 0081_v2_library). Тело модуля — не своя
  // таблица, а `lessons` с владельцем-модулем (`lessons_owner_ck`, П-11): базовая `lessons` в
  // этот список не входит, её RLS и индекс проверяют базовые `rls.spec.ts` и `schema-parity.spec.ts`.
  'library_modules',
  'library_module_versions',
  'library_module_usages',
  'library_module_proposals',
  // 38. Заметки и документы человека (PR-32, миграция v2_person_notes_docs). `user_notes` —
  // пакетная `person_notes` под своим именем (docs/v2/43 §1.2): таблица не новая, но пакет
  // считает её своей, и на неё распространяются те же контракты — RLS, полный tenant-first
  // индекс рядом с частичным (`40` §7.1), ключ на tenants (его у неё не было с 0019).
  'user_notes',
  'person_document_types',
  'person_documents',
  // 34. Хранилище: квота, корзина, сроки хранения (PR-36, миграция 0083_v2_storage_quota).
  // Пять таблиц `34` §3.3; шестая `storage_quota_addons` не создаётся (Р-6, сквозная 23) —
  // докупка места живёт в `tenant_addons` со `storage_pack`.
  'storage_usage_counters',
  'storage_usage_daily',
  'storage_retention_policies',
  'storage_deletion_requests',
  'storage_pending_uploads',
  // 24. Настройки тенанта и платформы (PR-39, миграция 0084_v2_settings). Первых четырёх нет
  // среди 71 тенантной таблицы `docs/v2/40` §2: их вводят патчи к базовому ТЗ, а не модульные
  // документы — П-21 (отметка прочтения объявления платформы), П-24.5 (`position_groups`),
  // П-24.1 (второй фактор входа). Сверка PR-40 «71 на длину» обязана прибавить эти четыре
  // строки (записано в `46-progress.md`). `absence_norms` — из 71 (`38` §3.6): блок норм
  // отпуска в настройках компании заводит её раньше карточки человека PR-33.
  'platform_announcement_reads',
  'position_groups',
  'user_totp',
  'user_totp_recovery_codes',
  // 38. Нормы отсутствий: уровни компании и точки (PR-39); факты и корректировка человека — PR-33
  'absence_norms',
  // 38. Факты отсутствий (PR-33, миграция v2_absences): по ним считается остаток нормы и
  // сдвигается срок обязательного назначения (`38` §7.13–7.14). Полный tenant-first индекс рядом
  // с частичным «действующие по датам» — контрактный тест 2.
  'absence_records',
  // 37. Нормы времени на контент (PR-22, миграция 0085_v2_time_norms): «Розрахунковий час»
  // элемента и агрегаты факта без людей. Под контрактным тестом 5 заодно: норма — оценка
  // плана, а не лимит, и `time_limit` в ней не появится (CLAUDE.md п. 11).
  'content_time_norms',
]

/** Платформенные таблицы пакета, вне RLS (docs/v2/40 §8 тест 6: plan_prices, plan_addons). */
export const V2_PACKAGE_PLATFORM_TABLES: string[] = [
  // 35. Тарифы и лимиты (PR-08, миграция 0059_v2_billing_plans): без tenant_id и вне RLS —
  // справочники платформы, общие для всех тенантов (docs/v2/35 §3.6, docs/25 §3.1)
  'plan_prices',
  'plan_addons',
  // Объявления платформы (PR-39, П-21, П-24.2): строка одна на платформу, адресация — её же
  // колонками; у `app_user` отозваны insert/update/delete — писать может только оператор
  'platform_announcements',
]
