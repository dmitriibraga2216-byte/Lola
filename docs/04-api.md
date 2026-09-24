# Lola LMS — ТЗ. Часть 4. API

## 4.1 Общие правила

- База: `/api/v1`. Формат — JSON, UTF-8. Даты — ISO 8601 с таймзоной.
- Аутентификация — сессионная cookie (`lola_sid`, httpOnly, Secure, SameSite=Lax).
  Для интеграций — `Authorization: Bearer <api_token>` (токены тенанта, скоупы те же).
  Разграничение Bearer — **по скоупам, не по путям** (`docs/v2/44` В-20, PR-39): скоуп с флагом
  `sessionOnly` (`shared/domain/roles.ts` `SCOPE_FLAGS`: `person.note.read`, `person.note.write`,
  `interview.listen`, `candidate.decide`, `candidate.hire`, `people.password`, `tenant.transfer`)
  токену не выдаётся (`422 scope_not_tokenable`), а у старого токена вычёркивается из прав —
  ручка отвечает обычным `403 forbidden`. Токену не выдаётся и право, которого нет у выдающего
  (`422 scope_not_held`). `/api/v1/platform/*` по Bearer недоступен вовсе: контур оператора
  разбирается раньше ветки Bearer и требует cookie `lola_ops`.
  Второй фактор (`24` §3.4): при подключённом TOTP или политике «двухфакторность для админов»
  вход даёт **промежуточную** сессию — ей открыты только `/auth/two-factor/*` и выход, прочее
  отвечает `401 two_factor_required`.
- Каждый запрос выполняется внутри `withTenant()`: тенант берётся из сессии, **не** из тела запроса.
- Валидация входа — zod-схемы из `shared/schemas`; те же схемы использует клиент.
- Мутации требуют заголовок `X-CSRF-Token` (double submit cookie), кроме Bearer-запросов.
- Идемпотентность мутаций, которые могут повториться (создание попытки, отметка урока):
  заголовок `Idempotency-Key`, хранение ключа 24 часа.

**Формат ответа**

```jsonc
// успех
{ "data": { … } }
{ "data": [ … ], "meta": { "total": 128, "limit": 50, "cursor": "eyJ…" } }

// ошибка
{ "error": { "code": "quiz.attempts_exhausted",
             "message": "Спроби вичерпано",
             "details": { "attemptsAllowed": 3 } } }
```

**Коды ошибок** (`error.code`, стабильные, используются клиентом)

| HTTP | code | Когда |
| --- | --- | --- |
| 400 | `validation_failed` | zod не прошёл, `details.issues` |
| 401 | `auth_required` | нет сессии |
| 401 | `otp_invalid` | неверный код |
| 403 | `forbidden` | нет скоупа |
| 404 | `not_found` | нет объекта в этом тенанте |
| 409 | `conflict` | параллельное изменение (см. `version`) |
| 422 | `course.not_publishable` | не прошли проверки публикации |
| 422 | `quiz.attempts_exhausted` | попытки исчерпаны |
| 423 | `attempt.locked` | попытка на проверке |
| 429 | `rate_limited` | превышен лимит, `Retry-After` |
| 500 | `internal` | всё остальное, с `trace_id` |

- Пагинация — курсорная (`cursor`, `limit` ≤ 100). Сортировка — параметр `sort`, whitelist полей.
- Все списки поддерживают `?fields=` (проекция) для экономии трафика на телефоне.

**Ключевой курсор** (`shared/domain/keyset.ts`, `server/utils/keyset.ts`; исправлено 24.09.2026,
`docs/v2/46-progress.md`). Курсор **непрозрачен** для клиента: это base64url от значений ключа
сортировки последней строки страницы. Клиент не строит и не разбирает курсор — только возвращает
тот, что пришёл в ответе (`meta.cursor`, `nextCursor` или `cursor`); `null` — дальше страниц нет.
Правила для сервера:

1. Ключ сортировки уникален: момент всегда в паре с `id` (`order by created_at desc, id desc`),
   иначе строки одного момента теряются на границе страниц — а у пачки строк одной транзакции
   (импорт людей, рассылка уведомлений) `created_at` один на всех.
2. Момент попадает в курсор **текстом из Postgres с микросекундами** (`keysetAt()`) и
   сравнивается в SQL (`keysetAfter()`), никогда через JS `Date`. `timestamptz` хранит
   микросекунды, `Date` — миллисекунды: курсор `…00.123Z` вместо `…00.123456Z` выбрасывал
   строки между `.123000` и `.123456` или отдавал ту же страницу по кругу.
3. Битый, чужой или устаревший курсор — `400 validation_failed` («Курсор недійсний — оновіть
   список і гортайте спочатку»), а не первая страница: первая страница вместо следующей даёт
   дубли на «Показати ще» и бесконечный цикл у клиента, листающего до `null`. Пустой `cursor=` —
   первая страница.
4. Ключи всех списков с курсором перечислены в `KEYSETS` (`shared/domain/keyset.ts`); сторож
   `tests/unit/keyset-cursor-guard.spec.ts` не пропускает курсор, собранный вручную через `Date`.

Курсор по целочисленному `id` (`/audit`, `/security-log`, `/bonuses/ledger` — книга бонусов, `id bigserial`) точен сам по себе и остаётся числом.

## 4.2 Аутентификация

| Метод | Путь | Описание |
| --- | --- | --- |
| POST | `/auth/otp/request` | `{phone, channel?: 'sms'\|'email'}` → отправка кода; ответ `{channel, maskedEmail?, devCode?}` (`channel='email'` — код ушёл письмом, `maskedEmail` вида `d***@gmail.com`); всегда 200, кроме `422 no_channel` (нет ни Telegram, ни SMS, ни почты — «Зверніться до менеджера точки») |
| POST | `/auth/otp/verify` | `{phone, code}` → сессия или список тенантов для выбора; `twoFactor: 'verify'\|'enroll'\|null` — сессия промежуточная, нужен второй фактор (`24` §3.4) |
| POST | `/auth/tenant/select` | `{tenantId}` → сессия в выбранном тенанте; `twoFactor` — как у `/auth/otp/verify` |
| POST | `/auth/password/login` | `{email, password}` (если включено политикой `passwords.loginEnabled`, иначе 403 `password_login_disabled`); ответ `{requiresTenantSelect, mustChangePassword}` либо `selectToken` + `tenants`; N неудач → 429 |
| POST | `/me/password` | `{currentPassword?, password}` — свой пароль; текущий обязателен, если он был (403 `wrong_current`), кроме восстановления (docs/33 D-021): без текущего — после входа по коду (e-mail всегда, телефон при `passwords.allowPhoneRecovery`), при `passwords.disableRecovery` — 403 `recovery_disabled`; `/auth/me` отдаёт `user.canRecoverPassword`; остальные сессии закрываются |
| POST | `/auth/invite/accept` | `{token}` → активация и сессия |
| POST | `/auth/logout` | текущая сессия |
| POST | `/auth/logout-all` | все сессии пользователя |
| GET | `/auth/me` | профиль, `activeRole`, `roles` (все действующие — для переключателя), `scopes` активной роли, настройки тенанта (с PR-39 — `tenant.contentFooter`, `tenant.logoMediaId` для колонтитула материалов) |
| GET | `/auth/two-factor` | второй фактор (`24` §3.4, PR-39): в промежуточной сессии — шаг экрана входа `step: verify\|enroll`; в полной — `enrolled`, `required` (политика требует), `confirmedAt`, `recoveryCodesLeft`, `setupPending`. Секретов в ответе нет |
| POST | `/auth/two-factor/verify` | `{code}` из приложения **или** `{recoveryCode}` → промежуточная сессия становится полной **с новым токеном** (cookie переставляется). `401 two_factor_invalid` (`details.attemptsLeft`), после `session.otpAttempts` неудач — `429 rate_limited`, блокировка на `session.blockMinutes` и отзыв промежуточных сессий; повтор принятого кода не проходит; `409 two_factor.not_pending` |
| POST | `/auth/two-factor/setup` | новый ключ приложения: `{secret, otpauthUrl, expiresAt}` (15 минут на первый код). Работает и в промежуточной сессии `enroll`; замена подключённого фактора — только с `{code}` (`422 two_factor.code_required`), старый действует до подтверждения нового; в промежуточной `verify` — `409 two_factor.verify_first` |
| POST | `/auth/two-factor/confirm` | `{code}` — фактор подключён; ответ `{recoveryCodes (10, показываются один раз), signedIn}` — в промежуточной `enroll` заодно завершается вход. `409 two_factor.no_pending` \| `two_factor.setup_expired` |
| POST | `/auth/two-factor/recovery-codes` | `{code}\|{recoveryCode}` → десять новых резервных кодов, старые гаснут (полная сессия) |
| DELETE | `/auth/two-factor` | `{code}\|{recoveryCode}` — отключить свой фактор; если политика требует его от этого человека — `409 two_factor.required_by_policy` |

Лимиты: `/auth/otp/request` — 3 на номер / 15 мин и 30 на IP / час; `/auth/otp/verify` — 5 на код.

## 4.3 Словарь ресурсов

После разбора эталона API строится вокруг двух центральных сущностей, а не вокруг курса:

| Сущность | Что это | Путь |
| --- | --- | --- |
| **Контент** | материал: курс, ресурс, тест, практикум, опрос, комплексный тест, программа, очное занятие, вебинар, чек-лист, оценка | `/content/...` |
| **Назначение** (`task`) | кому, с какими правилами, в какие сроки | `/tasks/...` |

Правила прохождения (попытки, порог, таймер, сроки, награды) живут **в назначении**
(`15` §14.3), не в контенте. Это отражено в API: у контента нет ни одного поля,
влияющего на прохождение.

`contentType` — перечисление из одиннадцати значений:
`course`, `training_program`, `resource`, `test`, `complex_test`, `workshop`,
`poll`, `assessment`, `check_list`, `meetup`, `webinar`.

## 4.4 Обучение (кабинет сотрудника)

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/me/tasks` | мои задания; `?group=new\|planned\|failed\|overdue\|done` — пять групп эталона (старый путь: `/learning/my`, до конца R1) |
| GET | `/me/tasks/:id` | карточка задания: контент, сроки, правила, прогресс — нет вовсе, долг (docs/28 «Spec 04») |
| GET | `/me/trajectories` | мои траектории с деревом и текущим блоком |
| GET | `/me/catalog` | каталог: `?kind=tasks\|trajectories` (`tasks` — курси, `trajectories` — програми+траєкторії), `?q=&category=`; групи доступу каталогу і режим (`catalog_free`\|`catalog_request`) фільтруються сервером (Spec 10, старый путь: `/learning/catalog`, до конца R1) |
| POST | `/me/catalog/:id/enroll` | самозапис, режим «Вільний доступ через каталог навчання» (Spec 10; старый путь `/learning/enroll` с `{courseId}` в тілі остаётся) |
| POST | `/me/catalog/:id/request` | заявка, режим «Подання заявки через каталог навчання» — `{comment?}` (Spec 10) |
| GET | `/me/development-plan` | планы развития: `?status=active\|inactive\|done` (старый путь: `/development/me`, до конца R1) |
| GET | `/me/certificates`, `/me/badges` | достижения; сертифікати — старий шлях `/learning/certificates`, до кінця R1; бейджі — нема зовсім, борг (docs/28 «Spec 04») |
| GET | `/me/study-history` | история и динамика рейтинга (свой и внешний) |
| GET | `/me/bonuses` | баланс бонусов, рейтинг (баллы), книга операций человека, «Вистачить на «…»» — `gamification` (`21` §17); модуль «Бонуси і магазин» выключен — 403 `module.disabled` |
| GET | `/me/gift-store`, `/me/gift-store/orders` | витрина магазина (баланс, категории, товары с `blocked`: `out_of_stock` \| `limit_reached` \| `insufficient` — считает сервер) и свои заказы; кандидату — 403 `shop.employees_only` (`gamification`) |
| GET/PATCH | `/me/notifications/prefs` | свои переключатели уведомлений (старый путь: `/notifications/prefs`, до конца R1) |
| POST | `/me/role/switch` | `{roleId}` — переключение активной роли (`01` §1.9.2) среди своих действующих; чужая, снятая или истёкшая — 403 `forbidden`, по API-токену — 400; ответ `{activeRole, changed}`, событие `role.switch` в аудите с обеими ролями |

## 4.5 Прохождение контента

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/enrollments/:id` | состояние прохождения: дерево, прогресс, доступность элементов (старый путь: `/learning/enrollments/:id`, до конца R1) |
| POST | `/enrollments/:id/decide` | рішення по заявці на курс через каталог (`assignment.create`): `{approve, reason?}` — `reason` обов'язковий при відмові; схвалення створює призначення через `tasks.ts` з `via_catalog=true` (Spec 10, `10` §14.1) |
| GET | `/enrollments/:id/items/:itemId` | тело урока или ресурса, если элемент доступен — сегодня это `POST /learning/enrollments/:id/lessons/:lessonId/open` (иной метод и путь, не тривиальное переименование), долг (docs/28 «Spec 04») |
| POST | `/enrollments/:id/items/:itemId/tick` | `{seconds, scrollPct, videoPct, blocksState}` идемпотентно, окно 15 с; ответ `{secondsSpent, scrollPct, videoPct, ready, reasons, requiredSeconds}`. Старый путь — `/learning/enrollments/:id/lessons/:lessonId/tick`, до конца R1 (там же `/acknowledge`, `/complete`, `/download`, `/open`) |
| POST | `/enrollments/:id/items/:itemId/complete` | завершение; сервер сам проверяет условия зачёта (`11` Г-11.5) (старый путь: `/learning/enrollments/:id/lessons/:lessonId/complete`, до конца R1) |
| POST | `/enrollments/:id/items/:itemId/acknowledge` | «Я ознайомився» для ссылок и объявлений (старый путь: `/learning/enrollments/:id/lessons/:lessonId/acknowledge`, до конца R1) |
| POST | `/enrollments/:id/migrate-version` | перейти на новую версию материала (`10` Г-10.1) — нет вовсе, долг (docs/28 «Spec 04») |

Клиент никогда не решает, пройден ли элемент: он присылает факты (сколько секунд,
докуда доскроллил, сколько видео просмотрел), решение принимает сервер.

## 4.6 Попытки теста

| Метод | Путь | Описание |
| --- | --- | --- |
| POST | `/tests/:id/attempts` | старт: снапшот состава + копия `params` назначения, дедлайн |
| GET | `/attempts/:id` | вопросы без эталонов, сохранённые ответы, остаток времени |
| PUT | `/attempts/:id/answers/:questionId` | автосохранение ответа |
| POST | `/attempts/:id/answers/:questionId/files` | вложение к свободному ответу |
| POST | `/attempts/:id/submit` | отправка → результат либо `review` |
| GET | `/attempts/:id/result` | разбор по правилам назначения (протокол ошибок, скрытие верных) |
| POST | `/attempts/:id/recalculate` | **«Перерахувати»** по текущему ключу (`22` §13.7); пишет новую запись результата, снимок не трогает |
| POST | `/tests/:id/recalculate` | то же для всех завершённых попыток теста (после правки ключа одного вопроса) |
| GET | `/attempts/:id/results` | история записей результата (`attempt_results`) |
| POST | `/tests/:id/attempt-requests` | запрос дополнительной попытки |
| GET/POST | `/attempt-requests`, `/attempt-requests/:id/decide` | очередь запросов и решение |

Сервер не отдаёт эталонные ответы до завершения попытки — проверка в сериализаторе,
отдельный тест `tests/integration/attempt-leak.spec.ts`.

## 4.7 Проверка вручную

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/review/queue` | **единая очередь** поверх `review_queue_items` (`v2/37` §10, решение `v2/44` В-15): `?tab=mine\|delegated_in\|delegated_out\|done&taskType&locationId&trackId&reviewerId&subjectKind&from&to&overdue&cursor&limit`; ответ `{items, total, cursor, counts}` — `counts` со счётчиками табов (PR-19) |
| GET | `/review/answers` | **узкий фильтр** поверх того же источника: очередь **ответов** (`12` §14.4) со своими фильтрами — `checked`, метки вопросов, «Поза програмами», «Поза курсами», точка, курс |
| POST | `/review/answers/:id/grade` | `{score, comment}`; наставнику видна `grader_hint` |
| GET | `/review/workshops` | **узкий фильтр**: очередь сдач практикумов, `?mine&overdue`; сортировка по времени в очереди |
| POST | `/review/workshops/:id/claim` | взять в работу (блокировка 30 минут) (старый путь: `/review/submissions/:id/claim`, до конца R1) |
| POST | `/review/workshops/:id/grade` | `{decision: passed\|rework\|failed, criteria[], comment}` (старый путь: `/review/submissions/:id/grade`, до конца R1) |
| GET/POST | `/review/submissions/:id`, `/:id/claim`, `/:id/release`, `/:id/grade`, `/:id/comments` | карточка проверки и действия над **работой**; решение принимается над работой, а не над строкой очереди — очередь обновляется тем же сервисом в той же транзакции. С PR-19 назначенную или делегированную другому работу взять нельзя: `409 review.assigned_to_other` |
| GET | `/review/items/:id` | карточка элемента очереди (`v2/37` §5.2): работа, критерии, история попыток, цепочка передач, `can` — какие действия доступны смотрящему. **Без `phone`, `email`, `resume_asset_id`** ни для кого (сквозная проверка 20); не видящему работу ни в одном табе — `404` |
| GET | `/review/items/:id/delegate-targets` | кому можно передать работу (`v2/37` §6.1) — список уже отфильтрован по праву оценки на точке, отсутствию и «приймаю делегування»; с нагрузкой `open / max` |
| POST | `/review/items/:id/delegate` | `{toUserId, reasonCode, reasonText?, dueAt, notify}` → `{delegationId, item}`; `422 review.delegate_target_forbidden \| review.delegate_target_declines \| review.delegate_cycle \| review.delegate_depth_exceeded`, `409 review.already_in_review`. Срок проверки не меняется (`v2/37` §7.5) |
| POST | `/review/items/bulk-delegate` | «Делегувати обрані»: `{itemIds[≤25], toUserId, reasonCode, dueAt}` → `{ok[], failed[{id, code, message}]}`; `422 review.bulk_limit` |
| POST | `/review/items/:id/reassign` | «Переназначити» (`review.delegate.any`): `{toUserId, reason}` — без цепочки, активные звенья закрываются `revoked_by_manager` |
| POST | `/review/delegations/:id/revoke` | `{reason?}`; автору — пока делегат не открыл карточку, иначе `409 review.delegation_in_progress`; руководителю — всегда, с причиной (`v2/37` §7.6) |
| GET | `/review/workload` | нагрузка проверяющих области (`v2/37` §5.3): `?locationId` |
| PATCH | `/review/capacity/:userId` | «Змінити ліміт» и «приймаю делегування» (`v2/37` §5.3, §7.2 (д)) |
| POST | `/review/absences` | отсутствие проверяющего (`v2/37` §6.2) → `{absence, movedCount}`; `422 reviewer_absence.range_invalid`, `422 absence.self_substitute` |
| DELETE | `/review/absences/:id` | отмена отсутствия; переехавшие работы назад не едут |
| GET/POST | `/review/routing-rules` | правила распределения (`v2/37` §3.3); `422 routing.scope_empty` — руководитель точки не заводит правило на всю сеть |
| PATCH/DELETE | `/review/routing-rules/:id` | правка и удаление правила; назначенные им работы остаются у своих проверяющих (FK `set null`) |

> [исправлено, решение `docs/v2/44-decisions.md` В-15: путь никогда не существовал, а долг
> закрывается удалением строки, а не реализацией — подтверждение чек-листа приходит в единую
> очередь табом `offline_confirm`] Ранее: «`GET /review/checklists` — заполненные чек-листы на
> согласование — нет вовсе, долг (docs/28 «Spec 04»)».

Отношение путей между собой (В-15): `/review/queue` — один список на все виды работ, три базовых
пути остаются, потому что несут фильтры, которых у очереди нет, и на них завязаны работающие
экраны. Действия не дублируются: `claim`, `release`, `grade` живут на работе, а не на очереди.

## 4.8 Контент (методист)

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/POST | `/content` | список всех типов; `?contentType=`, `?tags=`, `?authorId=` |
| GET/PATCH/DELETE | `/content/:id` | карточка (общие поля всех типов) |
| POST | `/content/:id/versions` | новая черновая версия |
| POST | `/content/:id/publish` | публикация; `{notifyAssigned: bool}` — «Сповістити про оновлення» (`11` §14.2) |
| POST | `/content/:id/duplicate` | копия |
| CRUD | `/courses/:id/sections`, `/courses/:id/items` | план курса: разделы и элементы, у теста в плане свой `passScorePct`; сегодня — `/courses/:id/modules`, `/courses/:id/lessons` (`resourceId` подключает опубликованный ресурс; без раздела — 422 `course.section_required`); `PATCH/DELETE /courses/:id/items/:id` — алиас поверх `/lessons/:id` (`debts-final-b`, docs/33 D-064); правки/удаления раздела (`/courses/:id/sections/:id`) нет вовсе — долг, docs/33 D-081 |
| GET/POST | `/resources` | библиотека ресурсов: `?status=all\|draft\|published\|archived`, `kind`, `authorId`, `tag`, `categoryId`, `q`, `page`, `perPage` (`11` §5.1) |
| GET/PATCH/DELETE | `/resources/:id` | рабочая редакция + `versions`, `accessGroupIds`, `usedInCourses`; удаление используемого — 422 `resource.in_use` |
| POST | `/resources/:id/publish` | `{changelog?, notifyAssigned}` → снимок версии; 422 `resource.not_publishable` с `checks` |
| GET | `/resources/:id/versions` | снимки (Г-11.3) |
| POST | `/resources/:id/duplicate`, `/archive`, `/restore` | копия; архив ↔ чернетка |
| CRUD | `/resource-categories`, `POST /resource-categories/reorder` | категории ресурсов с порядком (`{ids[]}`) |
| CRUD | `/access-groups` | группы доступа (`?appliesTo=knowledge\|catalog`), члены `{subjectType, subjectId}` |
| GET | `/learning/resources/:id` | ресурс для ученика: текущая версия, только при доступе; иначе 404. `?assignmentId=` — версия, закреплённая назначением (D-007) |
| CRUD | `/tests/:id/questions`, `/question-groups` | вопросы и их группы (`12` §14.3): `GET/POST /tests/:id/question-groups`, `PATCH/DELETE /question-groups/:id`; правка и удаление вопроса — по-прежнему `PATCH /questions/:id` (старый путь для списка и создания — `/questions?quizId=`, до конца R1); `PATCH/DELETE /tests/:id/question-groups/:id` и `PATCH /tests/:id/questions/:id` (вложенная форма) — тоже алиасы поверх тех же обработчиков (`debts-final-b`, docs/33 D-064); `DELETE /tests/:id/questions/:id` — сервиса удаления вопроса нет вовсе, долг, docs/33 D-082 |
| POST | `/tests/:id/questions/import` | «Питання з іншого тесту» (копия) и «з банку» (ссылка) |
| CRUD | `/polls/:id/questions` | вопросы опроса (четыре типа). Spec 20: реализовано как `GET/POST /surveys`, `GET/PATCH /surveys/:id` (вопросы в теле; после первого ответа вопросы/режим/приватность — 409 `survey.locked`), `GET /surveys/:id/report` (конфіденційно — имена только владельцу) |
| POST | `/learning/surveys/:id/start`, `/learning/surveys/:id/answer` | прохождение опроса по одному вопросу: сервер отдаёт следующий по правилам «з умовами», граф клиенту не уходит; `{questionId, answer}` → `{done:false, question}` \| `{done:true, results?}`; 422 `survey.required\|bad_option\|own_not_allowed\|bad_value` |
| CRUD | `/complex-tests/:id/items` | состав: тесты, сгруппированные по темам |
| CRUD | `/checklists`, `/assessments` | анкеты; параметры замораживаются после первого заполнения. Spec 20: `PUT /checklists` (`scaleId`, `allowSkip`, `allowItemComment`, `itemCommentRequired`, пункты с весом) и `PUT /assessment/forms` (`kind`, `scaleId`, правила комментирования, `items[{criterionId, norm, cluster}]`), `GET /assessment/forms/:id`; замороженное поле → 409 `checklist.locked` \| `form.locked` с `details.fields`; норма вне шкалы — 422 `form.bad_norm` |
| CRUD | `/criteria-groups`, `/criteria`, `/scales` | словарь критериев и шкал (`24` Г-24.4): `/scales?kind=range\|levels`, `PUT /scales/:id` пересобирает уровни целиком, диапазоны подряд 0–100 (`PATCH /scales/:id` — алиас поверх того же `PUT`, `debts-final-b`, docs/33 D-064). Spec 20: `/assessment/groups` (с `tags`, счётчики использования), `GET /assessment/groups/usage` («Де використовуються»), `DELETE /assessment/criteria/:id` из замороженной анкеты — 409 `criterion.in_use` (флоский `DELETE /criteria/:id` — алиас поверх того же обработчика, `debts-final-b`); `/rating-scales` снят — шкалы анкет живут в `scales(kind=levels)` |

## 4.9 Назначения

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/POST | `/tasks` | список / создание; `?type=manual\|auto\|catalog\|trajectory\|archive` |
| GET/PATCH | `/tasks/:id` | карточка |
| GET/PUT | `/tasks/:id/params` | правила прохождения (`assignments.params`, `02` §2.7); `GET` отдаёт `paramKeys` — состав полей формы после фильтра по типу контента и возможностям этапа курса (`docs/v2/33` §7.5, П-15), `PUT` молча отбрасывает ключ выключенной возможности |
| GET/PUT | `/tasks/:id/reminders` | расписание напоминаний (`15` Г-15.1) |
| GET | `/tasks/:id/audience` | список людей: назначенные, не назначенные, все; фильтры как в эталоне |
| POST | `/tasks/:id/audience/assign` | `{userIds[]}` или `{filter}` |
| DELETE | `/tasks/:id/audience/:userId` | снятие назначения (статус `cancelled`, не удаление) |
| POST | `/tasks/:id/audience/preview` | сколько человек попадёт под условие до применения |
| POST | `/tasks/:id/audience/import` | CSV (`15` Г-15.4) → `jobId` + предпросмотр; применение — `POST /tasks/:id/audience/import/:jobId` |
| GET | `/tasks/:id/results` | отчёт назначения (тот же экран, что отчёт по типу, `22` §13.7) |
| GET/PUT | `/tasks/:id/competencies` | «Обрати компетенції» (`15` Г-15.3) |
| GET/PUT | `/tasks/:id/parameters` | значения «Додаткових параметрів» назначения |
| GET | `/tasks/content?type=` | «Обрати з існуючих»: назначаемый контент типа (`15` §14.2) |
| GET | `/tasks/changed` | баннер «N завдань було змінено» (`15` §14.6); `POST /tasks/changed/notify` — разослать, `POST /tasks/changed/dismiss` — снять |
| CRUD | `/task-parameters` | «Додаткові параметри для завдань»: текст, список, число |

## 4.10 Правила автоматизации и траектории

| Метод | Путь | Описание |
| --- | --- | --- |
| CRUD | `/automation-rules` | правило: четыре измерения (місто, посада, підрозділ, мітка) в `dimensions[]`, каждое с режимом `any\|include\|exclude`, `assignDelayDays`, `onLeaveCondition` |
| GET | `/automation-rules/:id/preview` | «Буде призначено»: состав аудитории на сейчас, без побочных эффектов |
| POST | `/automation-rules/preview` | то же по несохранённым `dimensions` формы (живая сводка) |
| GET | `/automation-rules/:id/usages` | «Використовується для»: обратные ссылки `{kind: trajectory\|program\|assignment, id, title}` |
| CRUD | `/trajectories` | траектория: `assignMode`, `automationRuleId` (только `program.link_rule`), `stopAssignAfterFinish` |
| GET/PUT | `/trajectories/:id/graph` | полотно целиком: узлы (`kind` — `trajectory_node_kind`, новые — `tmpId`) и связи; условие — только на гілках `branch` (`17` §14.3, Г-17.1); ответ — сохранённый граф, `ids` (tmpId → id), `problems`. У опубликованной — только координаты (409) |
| POST | `/trajectories/:id/validate` | «Перевірити»: недостижимые блоки, пути к Finish, циклы, «І» с одним входом, закриття перед Finish, гілка без «інакше», пустые поля — с `nodeId` и текстом, что исправить |
| POST | `/trajectories/:id/publish` | публикация с проверками; 422 `trajectory.invalid` + `problems` |
| POST | `/trajectories/:id/duplicate` | копия (черновик) — способ перестроить опубликованную |
| GET/POST | `/trajectories/:id/audience` | кто на траектории (статус, текущий крок) / ручное назначение `{userIds}` |
| GET | `/trajectories/:id/usages` | правило, число назначений узлов, прохождения |
| GET | `/trajectories/usages?contentType=&contentId=` | траектории, где используется контент |
| GET | `/trajectories/enrollments/:id` | лента прохождения глазами руководителя |
| POST | `/trajectories/enrollments/:id/{cancel,decide}` | снятие с причиной / решение по заявке из каталога; `decide` — `{approve, reason?}`, `reason` обов'язковий при відмові (Spec 10) |
| POST | `/program-enrollments/:id/decide` | рішення по заявці з каталогу програми: `{approve, reason?}` (Spec 10) |
| GET | `/manage/catalog/requests` | «Прийом заявок на навчання» (`10` §14.1): `?kind=tasks\|trajectories` — черга заявок з людиною, датою подачі, станом (Spec 10) |
| POST | `/trajectories/enrollments/:id/nodes/:nodeId/confirm` | узел «Наставник»: подтверждение наставником (керівник точки або адмін) |
| GET | `/me/trajectories`, `/me/trajectories/:id` | мои траектории; лента шагов — только фактический путь |
| GET/POST | `/me/trajectories/catalog`, `/me/trajectories/catalog/:id/enroll` | каталог траекторий; самозапись (`catalog_free`) или заявка (`catalog_request`) |

## 4.11 Люди и справочники

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/POST | `/people` | список с фильтрами (посада, місто, підрозділ, мітки, рівень, активність); ответ `{data, meta: {cursor, limit, counts}}` |
| GET/PATCH | `/people/:id` | карточка (`16` §14.4) |
| POST | `/people/:id/roles` | роль в области: `{roleCode, scopeType, scopeId?, validUntil?, reason?}`; повтор той же роли в той же области — редактирование срока и причины |
| DELETE | `/people/:id/roles/:code` | снять роль; `?reason=` — в аудит; последний администратор — 409 `last_admin` |
| POST | `/people/:id/password` | `{password, mustChange?}` — смена пароля администратором, скоуп `people.password`; 400 `too_short` \| `weak` по политикам «Паролі» |
| DELETE | `/people/:id/two-factor` | сброс второго фактора человеку, потерявшему телефон и резервные коды (`24` §3.4, PR-39): скоуп `people.password` (`sessionOnly` — по токену никогда); закрываются все сессии человека, `two_factor.reset` (critical); себе — `409 two_factor.self` (свой снимается своим кодом), чужой тенант — 404 |
| GET/PUT | `/positions/:id/default-courses` | «Посада → курси за замовчуванням» (`v2/39` П-24.3, PR-39): `GET` (people.view \| assignment.create \| candidate.hire) → `{ruleId, items, group, effective}` — `effective` предзаполняет окно найма (`v2/28` §5.5); `PUT {items: [{courseId, dueDays}]}` (settings.tenant, до 10) — носитель **правило автоматизации**, привязанное к должности (`automation_rules.position_id`, измерение `position`, триггер `user.placement_changed`), отдельной таблицы нет; пустой список выключает правило; `422 course_not_found`, 404 |
| CRUD | `/position-groups` | группы должностей (`v2/39` П-24.5, PR-39) поверх `/refs/position-groups`; `PATCH /positions/:id {groupId}` — должность в группу (чужая группа — отказ); непустую группу не удалить — 409 `in_use`; `GET/PUT /position-groups/:id/default-courses` — курсы группы: правило с измерением `position` = текущий состав группы, пересобирается при каждой смене состава |
| GET/PUT | `/absence-norms` | нормы отпуска и больничного (`v2/38` §3.6, §10; блок настроек компании `v2/39` П-24.1, PR-39): `GET ?year=` → норма компании и переопределения точек области права; `PUT {scopeType: tenant\|location\|user, scopeId, year, vacationDays?, sickDays?, reason?}` — опущенное поле не трогается, `null` — наследовать, оба `null` снимают переопределение; скоуп `person.absence.manage`: компания — только на весь тенант, точка и человек — в области точки (`403 forbidden`); `422 reason_required` для человека; чужая точка или человек — 404 |
| POST | `/people/import` | CSV → `importJobId`, файл проверяется целиком |
| GET | `/people/import/:id` | протокол: создать N, обновить M, ошибок K с номерами строк |
| POST | `/people/import/:id/apply` | применить (всё или ничего) |
| CRUD | `/org-units`, `/locations`, `/positions`, `/position-levels`, `/cities`, `/user-groups` | справочники; у первых пяти нет отдельного `GET /:id` (старый путь для GET/POST/PATCH/DELETE первых пяти — общий `/refs/:kind`, до конца R1); `/user-groups` уже свой |
| CRUD | `/tags` | `GET ?scope=` (people.view, со счётчиком использований), `POST {name, scope, description?, color?}` / `PATCH /:id` / `DELETE /:id` (settings.tenant); 409 `duplicate` \| `in_use`; `/refs/tags?scope=user` — для форм людей |
| GET | `/org-conflicts` | `?state=open\|resolved\|all&kind=&from&to&userId` — протокол конфликтов оргструктуры (people.edit) |
| POST | `/org-conflicts/:id/resolve` | `{action: acknowledge\|close_placement, placementId?, comment?}`; 409 `already_resolved`; `GET /org-conflicts/:id/placements` — открытые размещения человека |

## 4.12 Развитие и оценка

| Метод | Путь | Описание |
| --- | --- | --- |
| CRUD | `/competencies`, `/competencies/:id/indicators`, `/competency-profiles` | словарь и профили должностей |
| GET | `/people/:id/competencies` | уровни с источником и датой (`19` Г-19.2) |
| POST | `/people/:id/competencies/:cid` | ручная установка с причиной |
| CRUD | `/development-plans` | планы развития; создание, `GET` списка (`?tab=active\|inactive\|done`) и карточки, `PATCH` (докс/28 «Spec 19 (продовження)»), переход по статусу и назначение наставника плана (`POST /:id/mentor`, `mentor_id`, docs/19 §3.4, screens-7) (старый путь: `/development/plans`, до конца R1) — удаления нет вовсе, долг (docs/28 «Spec 04») |
| CRUD | `/goals`, `/goal-statuses` | цели и справочник их статусов |
| CRUD | `/development/goals/tree` | дерево цілей «Стратегічний план» (docs/19 §14.4 `[рішення]`): `GET` — `development.team`, мутації — `development.manage`; зміна статусу — той самий `POST /development/goals/:id/transition` |
| CRUD | `/requests` | заявки: `kind=external_learning\|career`, маршрут согласования (`19` Г-19.1) |
| POST | `/assessments/:id/cycles` | цикл оценки: состав оценщиков по ролям; в коде `POST /assessment/cycles` — `raterKinds[]` из шести ролей `02` и `raterRoles[{kind, weight 0–9.99, isAnonymous}]` поверх умолчаний Г-20.1 (docs/33 D-036) |
| GET | `/assessments/:id/cycles/:cid/report` | результат с порогом показа (`20` Г-20.2) |

## 4.13 Хаб

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/knowledge/search` | единый поиск: `?q=&in=all\|resources\|news\|notices` (форума и wiki нет — `30`); результаты помечены источником и закладкой |
| GET | `/knowledge/categories` | дерево категорий `resource_categories` для витрины экрана `Knowledge` (докс/33 D-041) |
| GET | `/knowledge/categories/:id/resources` | ресурсы категории (клик по дереву) — те же правила доступа, что и в поиске, без текста запроса |
| CRUD | `/access-groups` | группы доступа к ресурсам (`?appliesTo=knowledge`); `GET/PATCH /settings/knowledge` — тумблер «Використовувати обмеження доступу» |
| POST | `/knowledge/:id/bookmark` | закладка-переключатель, тело `{contentType: resource\|article\|news\|notice}`; `GET /knowledge/bookmarks` — «Мої закладки» |
| PUT/DELETE | `/content-ratings/:contentId` | оцінка читача 1–5 (докс/33 D-042): `PUT {contentType, value}` — upsert; `DELETE ?contentType=` — забрати свою; агрегат `{count, average, myValue}` вбудований у `GET /knowledge/:id` і `GET /knowledge/resource/:id` |
| CRUD | `/news`, `/notices`, `/simple-notices` | лента и объявления; `GET/POST /news/categories`; `GET /notices/pending` — что показать при входе, `GET /notices/mine`; `POST /simple-notices/:id/view` |
| GET | `/platform-announcements` | **объявления платформы** — вторая «новость», не новости компании (`v2/39` П-21, PR-39): от оператора Lola, только чтение, по адресации (всем / по тарифу / пространствам); `{items: [{id, title, body, publishedAt, read}], unread}` — адресации наружу нет (`learn.view`) |
| POST | `/platform-announcements/:id/read` | «Прочитано»; не адресованное пространству, черновик или снятое — 404 (CLAUDE.md п. 15) |
| POST | `/notices/:id/acknowledge` | «Ознайомлений» — подтверждение (`21` §14.5); объявление назначается через `POST /tasks {subjectType: notice}` |
| GET | `/notices/:id/coverage` | кто подтвердил, кто нет, по точкам; `POST /notices/:id/remind` — «Нагадати тим, хто не підтвердив» |
| GET | `/birthdays`, `/contacts`, `/events` | дни рождения (`?tab=upcoming\|past&from=&to=`), контакты (`?q=&orgUnitId=&positionId=&cityId=`), события; `POST /events`, `PATCH /events/:id`, `POST /events/:id/register`; `PATCH /me/birthday-consent` |
| GET | `/public/guest-page` | гостевая страница без входа: тенант по поддомену `Host` или `?slug=`; неизвестный — 404; `passwordLogin`, `hideLoginForm` (политика «Приховати форму входу», действует при настроенном Google; тогда код/пароль → 403 `login_form_hidden`) |
| CRUD | `/gift-store/items` | товары магазина (`shop.manage`); удаление мягкое |
| POST | `/gift-store/items/:id/order` | покупка → резерв на 14 дней, списание строкой книги (`learn.view`); 409 `shop.out_of_stock` \| `shop.limit_reached` \| `shop.insufficient_bonuses` |
| CRUD | `/gift-store/categories` | категории товаров тенанта (`shop.manage`); с товарами — 409 `in_use` (`gamification`) |
| GET | `/gift-store/orders` | `?tab=pending\|issued\|cancelled&q=` — «До видачі» своей области (`shop.issue`) или сети (`shop.manage`), счётчики вкладок (`gamification`) |
| POST | `/gift-store/orders/:id/status` | `ready` \| `issued` \| `cancelled` (`21` Г-21.1); отмена ответственным — с `reason`, покупатель отменяет свой `reserved` сам; 409 `shop.invalid_transition` |
| GET | `/bonuses/ledger` | книга операций с остатком в строке; `?currency=&event=&userId=&q=&from=&to=&cursor=` — курсор = id строки |
| GET | `/bonuses/balances` | «Керування бонусами»: сотрудники области с текущим остатком (`gamification`) |
| POST | `/bonuses/adjust` | ручное начисление или списание с причиной (`bonus.grant`, только бонусы; себе — 409 `bonus.self_grant`, ниже нуля — 409 `bonus.insufficient`) |
| GET/PATCH | `/settings/rewards` | «Правила нарахування» по типу задания (`settings.tenant`); модулем бонусов не гасится — баллы рейтинга идут и без магазина (`gamification`) |
| GET/PUT | `/guest-blocks` | гостевая страница тенанта: три блока (`21` Г-21.3) |
| GET/POST | `/comments` | єдина лента комментариев со всех источников; `?sourceType=&isRead=read\|unread&cursor=&limit=`, ответ `{data, meta: {cursor, limit}}` (курсор выдаёт сервер, §4.1); створення — `{sourceType: task\|course\|program\|knowledge\|notice, sourceId, body}`, маршрутизація автору матеріалу рахується сервером (Spec 10, `10` §14.2) |
| POST | `/comments/:id/read`, `/comments/:id/reply` | пометка и ответ автору материала (Spec 10) |

## 4.14 Отчёты и журналы

Единая форма: `GET /reports/:name` с общими параметрами
`?from=&to=&locationIds=&positionIds=&tagIds=&context=any|standalone|in_course|in_program`
и специфичными для отчёта. Все отчёты отдают одинаковую «левую часть» (`22` §13.3).

| Путь | Что |
| --- | --- |
| `/reports/tasks/:contentType` | по типу контента; `?taskId=` даёт отчёт назначения, `?subjectId=` — по предмету; `format=xlsx`. Четыре части: `overview`, `accesses`, `stats`, `rows` (каркас + правая часть). Все типы, кроме `notice` (422 `report.unsupported`): `course`/`training_program` — по записям, `test` — по попыткам, остальные — по записям завершения модуля (`debts-6`, D-047) |
| POST `/reports/summary` | сводный мастер: `{step: users\|tasks\|result, userFilter, taskFilter, columns, groupBy}` — каждый шаг считается сервером |
| GET/PATCH `/settings/security` | `{emailAlerts}` — «Повідомляти про зміни на E-mail» журнала безпеки (`22` §13.4) |
| `/reports/trajectory/:id` | колонка на элемент траектории |
| `/reports/assessment/:id`, `/reports/checklist/:id` | анкеты; разрез чек-листа по пунктам |
| `/reports/knowledge` | обращения к базе знаний |
| `/logs/task-status` | протокол смены статусов (`enrollment_events` ∪ `attempt_results`), фильтры `contentType`, `contentId`. Все `/logs/:kind` отвечают `{kind, retentionDays, rows, cursor}`: `cursor` — следующая страница по `(created_at, id)` (§4.1), а не момент последней строки |
| `/logs/task-access` | обращения к заданиям (IP, браузер): каждое открытие и скачивание |
| `/logs/org-conflicts` | протокол конфликтов оргструктуры (`16` §14) |
| `/logs/security` | журнал безопасности (`16` Г-16.2) |
| `/logs/sessions` | сессии |
| `/logs/sessions/daily` | графік «Середній час у системі» (D-003): середня тривалість сесії по днях, `?days=1..90` (за замовчуванням 30) |
| `/logs/notifications` | уведомления |
| `/logs/notifications/telegram` | вкладка «Telegram» (D-003): підключення `telegram_chat_id`/`telegram_blocked` по активних людях — живий знімок, не подієвий журнал |
| `/logs/imports`, `/logs/bonuses`, `/logs/goal-statuses` | остальные журналы |
| POST `/reports/:name/export` | фоновая выгрузка → уведомление со ссылкой; область — по роли, активной в момент запроса. Имена: отчёты `22` §9, `tasks-<contentType>`, `summary`, `log-<kind>`, `saved:<id>`. Колонки каркаса — первые |
| CRUD `/saved-reports` | сохранённый отчёт с расписанием (`22` Г-22.2, наш конструктор) |

## 4.15 Медиа

| Метод | Путь | Описание |
| --- | --- | --- |
| POST | `/media/upload-url` | `{filename, mime, bytes, origin, sourceEntity?, sourceId?, courseId?, enrollmentId?, resourceId?, clientRef?}` → presigned PUT, `mediaId`; **единственный** вход загрузки (`v2/44` В-17); отказ 400 `origin_required \| media.too_big \| media.mime_not_allowed \| media.resource_too_big \| media.storage_limit` до передачи. Скоуп `media.upload` — любое происхождение; `learn.attempt` — только своя работа (`workshop_submission`, `video_answer`, `issue_screenshot`), иначе 403. С `clientRef` (ключ записи на устройстве) исчерпанная квота — не отказ, а **202** `{deferred:true, pendingId, expiresAt}` (`v2/34` §7.5); повтор с тем же `clientRef` досылает файл, когда место выдано; 409 `pending_upload_done`, 410 `pending_upload_abandoned` (срок 14 дней истёк) |
| POST | `/media/:id/complete` | подтверждение загрузки, запуск обработки; учащийся без `media.upload` — только своего файла. Файл отложенной записи закрывает её (`done`), сдача получает файл вместо обещания и уходит наставнику (`v2/34` §7.5 п. 3) |
| GET | `/media/:id` | статус и подписанная ссылка на чтение: 10 минут обычному файлу, **120 секунд** доказательству (`v2/44` В-19); оригинал SVG — только после санитизации (`ready`), до этого `?redirect=1` → 409 `not_ready` (D-011) |
| DELETE | `/media/:id` | мягкое удаление, скоуп `storage.delete`; тело `{reason?, confirmPhrase?}` → `{lifecycle:'pending_delete', purgeAfter}`; 403 `file_not_deletable` (сертификат), 409 `evidence_locked` (доказательство — нужны причина и слово «ВИДАЛИТИ»), 409 `already_deleted`, 409 `under_review` (сдачу с этим файлом сейчас проверяют, `v2/34` §12) |
| GET | `/storage/summary` | `?groupBy=origin\|stage` → `{usedBytes, limitBytes, graceBytes, pct, tone, blocked, breakdown[], otherShare, otherFiles, collectedAt, driftBytes, trash, pending, stageLabels, trashDays}`; скоуп `storage.view` (`v2/34` §5.1). Лимит и допуск — из `effectiveLimits()` (`v2/44` В-5), занятое — оперативный счётчик |
| GET | `/storage/files`, `/storage/trash` | реестр и корзина: `origin` (через запятую), `stage` (девять ключей), `categoryId`, `courseId`, `userId`, `from`, `to`, `status=active\|orphaned\|failed`, `evidenceOnly`, ключевой курсор `cursor` (`KEYSETS.storageFiles`, §4.1), `limit ≤ 100` → `{items[], nextCursor}` |
| GET | `/storage/pending-uploads` | записи сотрудников, ждущие места (`v2/34` §7.5) |
| POST | `/storage/files/:id/restore` | вернуть из корзины, сверх лимита тоже; скоуп `storage.delete`; 409 `already_purged`, 409 `not_deleted` |
| POST | `/storage/deletions` | заявка на массовое удаление `{mode:'selection', mediaIds[]}` или `{mode:'filter', filter}` → черновик с `plannedFiles`, `plannedBytes`, `evidenceCount`, `notDeletableCount`; 422 `deletion.empty`, 422 `deletion.too_many` (> 5000) |
| POST | `/storage/deletions/:id/confirm`, `/cancel` | `{acknowledged:true, reason?, confirmPhrase?}` — при доказательствах причина 10–500 и «ВИДАЛИТИ» (422 `reason_required`, 422 `confirm_phrase_mismatch`); исполняет заявку, сертификаты — в `skipped` с `not_deletable`; 409 `deletion.not_draft` |
| GET/PUT | `/storage/retention-policies` | строка на `origin`, скоуп `storage.policy`; первое включение удаляющей политики — только с `dryRunConfirmed` (422 `dry_run_required`), `keepEvidence=false` — с `acknowledgeEvidence` (422 `evidence_ack_required`) |
| POST | `/storage/retention-policies/dry-run` | `{origin, keepMonths, anchor, action, keepEvidence}` → `{files, bytes, evidenceCount}` — «Буде звільнено приблизно {size}» |

Ограничения (`11` Г-11.4): изображение ≤ 10 МБ, документ ≤ 50 МБ, аудио ≤ 100 МБ,
видео ≤ 500 МБ, на ресурс суммарно ≤ 1 ГБ; mime — allowlist; ключ — uuid,
оригинальное имя хранится в БД. Файл чужого тенанта — **404, не 403** (`25` §10).

Происхождение (`origin`) — одно из пятнадцати значений `media_origin` (`02` «Перечисления»,
`v2/40` §4.2) и задаётся **при выдаче presigned URL**, а не вычисляется потом (`v2/34` §7.1):
второго пути загрузки нет, иначе копятся неклассифицированные файлы. Удаление всегда мягкое:
строка получает `lifecycle='pending_delete'`, `deleted_at`, `deleted_by`, `delete_reason` и
`purge_after = now() + trash_days` (срок корзины — строка `storage_retention_policies`, по
умолчанию 30 днів, `v2/44` §8), **объект в S3 остаётся**; задача `storage.purge` переводит
строку в `purged` и объект тоже не удаляет до решения владельца продукта (`v2/44` §8,
`v2/34` §11); квота освобождается сразу, при мягком удалении. Загрузка пишет в `audit_log` событие `media.upload`,
удаление — `media.delete`, выдача ссылки на доказательство — `media.download`.
Массовое удаление одиночной ручкой не делается: только заявкой `POST /storage/deletions`
с подсчётом доказательств и подтверждением фразой (`v2/34` §10).

## 4.16 Настройки

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/PATCH | `/settings/tenant` | простір: `name`, `slug` (409 `slug_taken` / `slug_locked` — после первого входа сотрудника не меняется, `29` Б.12), `locale`, `timezone`, `accent` только из палитры (`29` Б.14), `space`, `defaults`, `quietHours`; `GET` отдаёт ещё `slugLocked`, `plan`, `modules`. С PR-39: `logoMediaId` — логотип (`media_assets` своего тенанта, `origin='brand_asset'`, изображение; иначе `422 logo_invalid`), `space.contentFooter` — колонтитул материалов, `space.localesEnabled` — мови інтерфейсу (`v2/39` П-24.1) |
| GET/PATCH | `/settings/policies` | десять групп политик эталона (`24` §3.4.1); включить `passwords.adminTwoFactor` может только тот, у кого второй фактор уже подключён — иначе `422 two_factor_enroll_first` (`24` §3.4) |
| GET | `/settings/two-factor` | блок «Двофакторна автентифікація» (`24` §3.4, PR-39): `{required, admins: [{userId, fullName, enrolled, confirmedAt}]}` — на кого распространяется требование и кто подключил фактор (settings.tenant) |
| CRUD | `/settings/roles` | роли и скоупы (`24` Г-24.1): `GET` (people.view, со счётчиками людей и прав), `POST`, `PATCH /:id`, `DELETE /:id` (settings.tenant); 409 `code_taken` · `admin_role` · `owner_role` · `role_in_use` · `last_settings_role`, 403 `scope_not_owned` |
| GET | `/settings/roles/scope-groups` | группы прав для редактора ролей (`01` §1.3): `[{key, scopes[]}]` (people.view) |
| GET | `/settings/owner` | владелец простора (`01` §1.9.4): `{owner: {userId, fullName, email, phone, since} \| null, canClaim}` (people.view) |
| GET | `/settings/owner/candidates` | кому можно передать владение: `?q=`, действующие сотрудники кроме себя (tenant.transfer) |
| POST | `/settings/owner/claim` | «Стати власником» в просторе без владельца — одноразово (settings.tenant); 409 `already_owned` · `not_eligible` |
| POST | `/settings/owner/transfer` | «Передати володіння»: `{userId}` (tenant.transfer); 409 `same_person` · `not_eligible` · `no_owner`, 403 `not_owner`, 404 `not_found` |
| GET/PUT | `/settings/position-role-map` | правило «должность → роль»: `{items: [{positionId, roleCode, scopeType, scopeId?}]}` целиком; применяется при следующей смене должности или импорте |
| POST | `/settings/position-role-map/reapply` | «Перезібрати ролі по мережі» (`28` D-001): применяет текущую карту ко всем действующим основным размещениям тенанта сразу |
| CRUD | `/settings/notification-templates` | шаблоны: `subject`, `body_text`, `body_mjml` (старый путь: `/settings/notifications`, до конца R1; список и правка целиком — `PUT`, не `POST`/`PATCH`, как и было) |
| GET/PUT | `/settings/notification-schedule` | время отправки по классам событий (`23` §13.2.1) |
| GET/PUT | `/settings/email-layout` | шапка и подвал письма |
| CRUD | `/settings/integrations` | SMTP, Telegram (свой и внешний), источники людей, вебхуки, API-токены (`GET /settings/api-tokens` отдаёт `scopes` — только выдаваемые токену: без `sessionOnly` и без чужих прав — и `sessionOnly` для подсказки; `POST` — `422 scope_not_tokenable` \| `scope_not_held`, `docs/v2/44` В-20) |
| POST | `/settings/integrations/:provider/test` | тестовое сообщение без постановки в очередь (пока только `smtp`, `23` §13.4) |
| CRUD | `/settings/translations` | переопределение строк интерфейса: `GET ?locale&q&changedOnly&page`, `PUT {locale,key,value}`, `DELETE ?locale&key?` (без key — весь набор), `GET /export?locale`, `POST /import {locale, items}`; клиенту — `GET /translations/:locale` (любая сессия) поверх словаря |
| GET | `/settings/usage` | потребление: активные, диск, SMS, дата последнего сбора, тариф и лимиты (`24` §4.4.1); с `v2/45` PR-09 — ещё `consumption[]` по одиннадцати осям и `notices[]` для баннера |
| GET | `/billing/usage` | потребление по осям (`v2/35` §10): `axis, used, limit, pct, source (live\|counter), kind, degradation` плюс окно периода; скоуп `billing.usage.view` |
| GET | `/billing/notices` | открытые предупреждения баннера (`v2/35` §5.5, §7.9); скрытые крестиком не возвращаются, пока не истекли 24 часа; скоуп `billing.view` |
| POST | `/billing/notices/:id/dismiss` | скрыть предупреждение на 24 часа; у уровня `exceeded` крестика нет — 409 `limit_exceeded` (`v2/35` §7.9 п. 2) |
| GET/PATCH | `/settings/modules` | переключатели модулей; выключенный модуль → 403 `module.disabled` на его маршрутах (`24` §3.2) |
| CRUD | `/course-categories`, `POST /course-categories/reorder` | «Категорії каталогу навчання» с порядком (`24` §3.7.1); категория с курсами — 409 `in_use`. `ownerId` — владелец категории, адресат жалоб на материалы её курсов, когда авторы неактивны (`docs/v2/36` §7.5 в, PR-24); чужой или несуществующий — 404 |
| GET/PATCH | `/settings/catalog` | тумблер «Використовувати обмеження доступу до завдань в каталозі навчання» — `{restrictAccess}`, за замовчуванням вимкнено (`10` §14.1, Spec 10); групи доступу — той самий `/access-groups?appliesTo=catalog` |
| GET | `/certificates/summary` | сводка сертификатов по курсам для экрана Certificates |
| POST | `/auth/impersonation/stop` | выход из режима «от имени» с плашки → `impersonation.ended` |
| GET | `/audit` | журнал изменений |
| GET | `/health`, `/ready`, `/metrics` | служебное — намеренно вне `/api/v1` (health-чек не должен зависеть от версии API), `server/routes/{health,ready,metrics}.get.ts`, docs/28 «Spec 04» |
| POST | `/push/subscribe` | підписка браузера на push (докс/33 D-051, `23` §13.7): `{endpoint, keys:{p256dh,auth}}` |
| POST | `/push/unsubscribe` | зняти підписку цього браузера: `{endpoint}` |
| GET | `/push/status` | чи є в людини хоч одна активна підписка — `{subscribed}` |

## 4.17 Панель оператора платформы

Отдельный префикс `/api/v1/platform`, отдельный набор скоупов, недоступен
администратору тенанта ни на чтение (`24` Г-24.3).

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/POST | `/platform/tenants` | список и создание |
| GET/PATCH | `/platform/tenants/:id` | карточка, тариф (`plan`), триал, название, settings, `customDomain` (докс/33 D-059, `25` §16.1: собственный домен клиента, 409 `domain_taken` — занят другим тенантом); статус — только suspend/resume/purge |
| POST | `/platform/tenants/:id/impersonate` | вход «от имени»: обязательна причина, 60 минут, запись в журнал безопасности тенанта |
| GET | `/platform/metrics` | метрики платформы |
| POST | `/platform/tenants/:id/anonymized-dump` | обезличенный слепок (`25` §16.3) |
| POST | `/platform/tenants/:id/suspend` | `{reason?}` — приостановка (`25` §8): вход и API тенанта отвечают 403 `tenant_suspended`, задачи стоят, данные целы; 409 `tenant.wrong_status`. Spec 25 |
| POST | `/platform/tenants/:id/resume` | возобновление из suspended. Spec 25 |
| POST | `/platform/tenants/:id/purge` | `{confirmSlug}` — команда на удаление: только из suspended, slug должен совпасть (409 `tenant.confirm_mismatch`); `status = archived`, задача `tenant.purge` через 30 дней. Spec 25 |
| DELETE | `/platform/tenants/:id/purge` | отмена удаления до срока: archived → suspended. Spec 25 |
| GET/PUT | `/platform/tenants/:id/limits` | тариф и переопределения `tenant_limits` (`users`, `storageGb`, `smsPerMonth`, `apiPerMinute`, `webhooks`, `activeJobs`); null — вернуться к тарифу. Spec 25 |
| GET/PUT | `/platform/tenants/:id/smtp-tls` | `{ignoreTlsErrors}` — небезпечний прапорець SMTP (`09` §9.7.1 п. 3, докс/33 D-050): тенант його не бачить, лише оператор платформи; кожна зміна в `platform_audit`. Spec 23/25 |
| GET | `/platform/audit` | `?tenantId=&limit=` — журнал `platform_audit` (`25` §7 п. 5). Spec 25 |
| GET/POST | `/platform/announcements` | объявления платформы (`v2/39` П-21, П-24.2, PR-39): список с числом прочтений; создание `{title 3–200, body ≤5000, audience: all\|plans\|tenants, planCodes, tenantIds, publish}` — адресация согласована с видом (400), тариф только из `plans` (`422 announcement.unknown_plan`). Пишет только оператор: у роли приложения на таблицу — только `select` |
| PATCH | `/platform/announcements/:id` | правка текста и адресации (адресация — вместе с видом); снятое не правится — `409 announcement.archived` |
| POST | `/platform/announcements/:id/publish` | черновик — в ленту тенантов (повторная публикация ничего не меняет) |
| POST | `/platform/announcements/:id/archive` | снять с ленты: тенанты больше не видят, история и счёт прочтений остаются |
| POST | `/platform/tenants/:id/users/:userId/two-factor-reset` | `{reason 10–500}` — сброс второго фактора человеку тенанта (`24` §3.4, PR-39): последний способ вернуть вход администратору без телефона и кодов, когда другого нет; `two_factor.reset` (critical, с причиной) — в журнал безопасности тенанта, действие — в `platform_audit`; чужой или несуществующий человек — 404 |

## 4.18 Вебхуки наружу

> [исправлено, `docs/v2/44-decisions.md` В-18] Ранее: «`certificate.revoked`, `task.overdue`,
> `notice.acknowledged`, `user.created`» — отзыв сертификата случается (`docs/28-implementation-
> notes.md`, «Spec 12»: откат `passed → failed` при пересчёте пишет `audit_log
> certificate.revoke`), но **события вебхука** `certificate.revoked` в `WEBHOOK_EVENTS` нет и не
> было; рабочее событие для просрочки называется `assignment.overdue`, не `task.overdue`.
> Список приведён к фактическому составу `WEBHOOK_EVENTS` (`server/services/webhooks.ts`) плюс
> три новых события пакета `docs/v2`.

События (10): `enrollment.completed`, `attempt.passed`, `attempt.failed`, `certificate.issued`,
`assignment.overdue`, `user.created`, `notice.acknowledged`, `candidate.hired`,
`vacancy.application_received`, `offboarding.completed`.
Доставка: POST с подписью `X-Lola-Signature` (HMAC-SHA256 по телу), три повтора
с экспонентой, журнал доставок с телом запроса и ответом, ручной повтор из интерфейса.

**Payload без персональных данных** (докс/v2/44 В-18): `data` несёт идентификаторы и время,
не ФИО/e-mail/телефон/резюме — правило действует на все десять событий, включая существующий
`user.created`. Получатель добирает подробности через API под своими скоупами:

| Событие | `data` |
|---|---|
| `candidate.hired` | `{userId, vacancyId, hiredAt}` |
| `vacancy.application_received` | `{vacancyId, applicationId, receivedAt}` |
| `offboarding.completed` | `{userId, caseId, completedAt}` |

## 4.19 Телеграм-бот

- `/start <token>` — привязка `telegram_chat_id` (токен одноразовый, 15 минут).
- Кнопки под уведомлением: «Пройти», «Відкласти на день», «Не нагадувати про це».
- Бот не ведёт обучение в чате: всё открывается в вебе по ссылке с автологином
  (одноразовый токен, 10 минут, привязан к `chat_id` и коду уведомления).
- Ошибки: 403 — бот заблокирован, канал переключается на SMS; 429 — `retry_after`;
  400 «chat not found» — сброс привязки.

## 4.20 Заняття, вебінари — сесії на призначенні (Spec 18)

Базовий `CRUD /meetups`, `/meetups/checkin` (`18` §10) лишається без змін — обслуговує стару
однораундову картку та `kind=event` (Spec 21). Нове — сесії, прив'язані до призначення
(`18` §14.1), окремою моделлю поверх картки:

**33 D-029** (`debts-final-a`): щойно в картки meetup|webinar з'явилась хоч одна сесія, картка
перестає брати участь у записі/QR/відмітці/звіті/нагадуваннях/Calendar-Zoom-синку — усе це веде
відповідна сесія; `POST/PATCH/DELETE .../register`, `.../attendance`, `.../qr`, `.../checkin`
на СТАРИХ карткових шляхах (`/meetups/:id/...`) для такої картки повертають `has_sessions`
(409) або 404 замість того, щоб мовчки писати в порожню (нечинну) реєстрацію картки. `GET
/meetups` (розклад, `?from=&to=&mine=&kind=&locationId=`) тепер зводить старі картки
(`kind=event`, немігровані) з рядком на кожну сесію (`meetupId` — для переходу на картку, `id` —
унікальний в об'єднаному списку). Calendar/Zoom-синк для сесії — та сама пара функцій
(`syncSessionToCalendar`/`createZoomMeetingForSession`), викликана автоматично з
`createSession`/`updateSession`/`cancelSession`, з окремим `external_event_id`/
`external_meeting_id` на кожній сесії.

| Метод | Путь | Комментарий |
| --- | --- | --- |
| GET/POST | `/meetups/:id/sessions` | список / нова сесія заняття-вебінару (`?taskId=` — тільки одного призначення) |
| GET/PATCH | `/meetup-sessions/:id` | картка сесії з учасниками (`manage`), «Мій статус» |
| POST | `/meetup-sessions/:id/cancel` | `{reason, notify}` — знімає реєстрації, сповіщає |
| POST/DELETE | `/meetup-sessions/:id/register` | запис / відписка на сесію; `{enrollmentId, lessonId}` — з уроку курсу (Б.3) |
| POST | `/meetup-sessions/:id/register-others` | `{userIds[]}` |
| GET | `/meetup-sessions/:id/qr` | поточний токен тренера, 30 с |
| POST | `/meetup-sessions/checkin` | `{token}` → 410 `qr.expired`, 403 `not_registered` |
| POST | `/meetup-sessions/:id/attendance` | `{userId, status, reason?}` — заднім числом (сесія завершена) причина обов'язкова, вікно 7 днів, лише керівник точки/`meetup.manage` → 422 `reason_required`, 409 `window_passed`, 403 `forbidden` |
| POST | `/meetup-sessions/:id/tick` | `{seconds}` — тік перегляду вебінару, зачёт по `webinarMinWatchPct` з `assignments.params` |
| POST | `/meetup-sessions/:id/participations` | дані участі від провайдера/вручну |
| GET | `/meetup-sessions/:id/ics` | файл календаря сесії |

`GET /reports/attendance` тепер віддає й розділ `sessions` (звіт по сесіях) поряд зі старим
`meetups` (події, docs/28 «Spec 18»), а з `debts-6` (docs/33 D-030) — ще `people`: рядки
«людина × сесія» на єдиному каркасі звітів (docs/22 §13.3) з колонками Г-18.2; фільтри
`?from=&to=&meetupId=&sessionId=`, область видимості — як у всіх звітів.

## 4.21 Пакет `docs/v2`

> Патч `docs/v2/39-patches.md` П-04. Полный перечень новых путей, скоупов и кодов ошибок
> одиннадцати модулей пакета — `docs/v2/41-api-delta.md`; здесь — только то, что касается
> основного контракта API.

### Жизненный цикл и офбординг (`docs/v2/33-lifecycle.md` §10, PR-07)

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/lifecycle/state/:userId` | текущий этап человека, история и прошлые периоды работы (`lifecycle.view`); `404` — человека нет |
| POST | `/lifecycle/state/:userId` | ручной перевод HR: `{stageId, reasonCode, reasonText?}` (`lifecycle.manage`); `422 lifecycle.disabled`, `409 lifecycle.same_stage` |
| GET | `/offboarding` | список случаев: фильтры `state`, `active`, `reasonCode`, `locationId`, `from`, `to` (`offboarding.start`) |
| POST | `/offboarding` | запуск по форме `33` §6.2 (`offboarding.start`); `409 offboarding.active_exists`, `409 people.last_admin`, `422 validation_failed` («Дата надто давня» — дальше 30 дней назад) |
| GET | `/offboarding/stage` | этап «Офбординг» и его курсы — предзаполнение поля «Курси офбордингу» |
| GET | `/offboarding/:id` | карточка случая; чужой тенант — `404` |
| POST | `/offboarding/:id/handover` | передача дел закрыта: `{done: true}` → переход `handover → interview` |
| POST | `/offboarding/:id/complete` | завершение: `{confirm: true}` (`offboarding.complete`); `409 offboarding.before_last_day` |
| POST | `/offboarding/:id/cancel` | отмена: `{reasonText}`; после `done` — `409 offboarding.completed` |
| POST | `/people/hire` | найм и **повторный** найм одним путём (`people.invite`): человек ищется по `userId`/`phone`/`externalId` и второй записи `users` не получает (`33` §7.8) |

Назначение курса этапа, у которого выключен `applies_to_candidate`, кандидату — `422
lifecycle.not_for_candidate` на `POST /assignments` и `POST /tasks` (`33` §7.9).

### Оргструктура: дерево подчинения (`docs/v2/32-org-structure.md` §10, PR-30)

Дерево подчинения — третья сущность рядом с `/org-units` («до якого шматка компанії
належить») и `/positions` («як називається робота»): оно отвечает на «хто кому
підпорядкований». Единственный публичный ответ о руководителе — `GET
/org-structure/manager/:userId` (патч П-16.4): читать `locations.manager_id` мимо него
запрещено, проверка 9 в `scripts/v2-crosschecks.sh`.

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/org-structure/tree` | `?mode=admin\|view&includeArchived&includeVacant` — дерево (`org.structure.view`; `mode=admin` требует `org.structure.edit`). В ответе `canEditAll` и `branches` — ветки, которые человек вправе править |
| POST | `/org-structure/nodes` | создание узла по форме `32` §6.1 (`org.structure.edit`); корневой — только с тенантным скоупом. `409 depth_exceeded`, `409 too_many_roots`, `409 parent_archived`, `422 validation_failed` |
| PUT | `/org-structure/nodes/:id` | правка узла; `409 node_archived`, `422 validation_failed`; чужая ветка — `403 forbidden` с текстом «Ви можете змінювати лише свою гілку» |
| POST | `/org-structure/nodes/:id/move` | `{parentId, sort?, keepChildren?}`; `409 cycle_detected`, `409 depth_exceeded` — дерево при отказе не меняется |
| POST | `/org-structure/nodes/:id/archive` | архивация (физического удаления узла нет); `409 has_children`, `409 has_holders` |
| POST | `/org-structure/nodes/:id/restore` | восстановление в течение 90 дней; `409 parent_archived` |
| POST | `/org-structure/nodes/:id/assignments` | привязка человека: `{userId, isPrimary?, roleInNode?, startedAt?, makeNamed?, transferPrimary?}`; `409 primary_exists` (в деталях — узел, где основное подчинение уже есть), `422 user_archived`, `422 validation_failed` (`detail=kind` — кандидата в дерево не ставят) |
| DELETE | `/org-structure/assignments/:id` | снятие с узла: `{endedReason?}`; строка журнала не удаляется, а закрывается |
| GET | `/org-structure/manager/:userId` | `{managerUserId, source, nodeId, chain}` — ответ `resolveManager()`; заодно пишет `unit_missing`, `no_manager` и `manager_mismatch` в `org_conflicts` |
| GET | `/org-structure/subordinates/:userId` | `?deep=true` — подчинённые по проекции `org_manager_map` |
| GET/POST | `/org-structure/snapshots` | список и создание снимка (`org.structure.import`). **Откат к снимку и импорт CSV — PR-31**, в этом контракте их пока нет |

### Кандидаты и воронка (`docs/v2/28-recruiting-candidates.md` §10, PR-13)

Кандидат — это `users` с `kind='candidate'` (`docs/v2/44` В-8), поэтому отдельного
`/people`-подобного контура у него нет: тот же человек, другой вид записи. Пути ниже
показывают и меняют ровно то, чего у сотрудника не бывает.

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/candidates` | реестр: фильтры `q`, `statusId`, `state`, `recruiterId`, `source`, `from`, `to`, `limit` (`candidate.view`); в `meta` — счётчик «Кандидатів: N із M» по общей формуле лимита |
| POST | `/candidates` | создание по форме `28` §6.1 (`candidate.edit`); `400 candidate.contact_required`, `409 candidate.is_employee`, `409 candidate.duplicate` (в деталях — карточка найденного), `409 candidate.contact_taken`, `409 limit_exceeded` (`axis=candidates_active`) |
| GET | `/candidates/duplicates` | поиск того же человека по телефону и почте до сохранения (`candidate.edit`); контакты найденного в ответ не отдаются |
| GET | `/candidates/:id` | карточка (`candidate.view` или `review.queue` — наставнику без контактов, резюме и комментариев); чужой тенант и чужая область — `404` |
| PATCH | `/candidates/:id` | правка карточки (`candidate.edit`); `409 conflict` — оптимистическая блокировка по `updatedAt` |
| POST | `/candidates/:id/status` | перенос по колонкам воронки (`candidate.decide`); `409 status.same`, `409 candidate.transition_not_allowed` (из `hired` переходов нет), `422 reason.required` |
| GET | `/candidates/:id/history` | лента смен колонки: кто, когда, почему (`candidate.view`) |
| GET/POST | `/candidates/:id/scores` | четыре независимых вида оценки, `?history=true` — вместе со снятыми; вид `ai` ставит только авто-собеседование |
| GET/POST | `/candidates/:id/comments` | тред рекрутеров; кандидату не виден никогда |
| GET/POST | `/candidate-statuses` | справочник колонок канбана со счётчиком кандидатов; создание — `candidate.status.manage`, `409 code.exists` |
| PATCH/DELETE | `/candidate-statuses/:id` | правка и удаление; `403 status.system`, `409 candidate_status.in_use` со списком кандидатов внутри |
| GET | `/candidates/board` | канбан: активные колонки, в каждой страница по 50 карточек, общее число и курсор; с `statusId` и `cursor` — следующая страница **одной** колонки (`candidate.view`); чужая колонка — `404` |
| POST | `/candidates/:id/hire` | найм одной транзакцией: `kind='employee'`, размещение, наставник, этап онбординга, курсы (`candidate.hire`); `409 candidate.not_active`, `409 limit.users_exceeded` (в деталях — продлённое на 14 дней право входа, `28` §12.5) |
| POST | `/candidates/:id/reject` | отказ с причиной из перечня (`candidate.decide`); `422 reason.required`, `409 candidate.not_active` |
| POST | `/candidates/:id/archive` | архивация вручную; `?withdraw=true` — самоотвод кандидата (`candidate.decide`) |
| POST | `/candidates/:id/reopen` | возврат в воронку с причиной (`candidate.delete` — решение администратора); `409 consent.expired`, из `hired` — `404`: сотрудник уже не кандидат |
| POST | `/candidates/bulk/status` | массовый перенос колонок (`candidate.decide`); в ответе `changed` и поимённый `skipped` с причиной; найм пачкой не делается |
| GET | `/reports/recruiting-funnel` | отчёт по воронке: колонки, доли, среднее время и конверсия плюс люди единым каркасом колонок `docs/22` §13.3 (`candidate.view`); `format=xlsx` требует `report.export` |
| GET/PATCH | `/settings/recruiting` | включение рекрутинга тенанту (`tenants.candidates_enabled`) и его сроки: авто-архивация и согласие (`settings.tenant`) |

Все пути воронки закрыты флагом тенанта: при `candidates_enabled = false` они отвечают
`403 candidates.disabled` — так же, как выключенный модуль (`docs/24` §3.2), данные остаются.

Приглашение кандидата и назначение ему контента отдельной ручкой — PR-16 вместе с публичным
контуром отклика: назначение кандидату делается обычным `POST /tasks` (инвариант 1).

### Вакансии (`docs/v2/29-vacancies.md` §10, PR-15)

Вакансия **не носитель правил прохождения** (инвариант 1, CLAUDE.md п. 11): она хранит шаблон
параметров (`assignmentTemplate`), а применяется созданием обычной `assignments`. Ни одна
ручка ниже не меняет уже созданного назначения — такого пути нет и не будет (`29` §7.12).

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/vacancies` | реестр: фильтры `q`, `state`, `locationId`, `orgUnitId`, `recruiterId`, `categoryId`, `courseId`, `from`, `to`, `limit` (`vacancy.view`); в каждой строке — «кандидати в роботі» |
| POST | `/vacancies` | создание черновика по форме `29` §6.1 (`vacancy.edit`); состояние и токен телом не задаются — их выдаёт публикация |
| GET | `/vacancies/:id` | карточка с критериями и языками (`vacancy.view`); чужой тенант и чужая область — `404`, не `403` |
| PATCH | `/vacancies/:id` | правка (`vacancy.edit`); в ответе `candidatesInProgress` для строки «Зміни вплинуть лише на нові відгуки»; `409 conflict` — блокировка по `updatedAt`; `409 vacancy.archived` |
| POST | `/vacancies/:id/publish` | публикация и переоткрытие (`vacancy.publish`); `422 vacancy.link_requirements` со списком незаполненного, `409 vacancy.ai_text_unreviewed` с перечнем блоков, `409 vacancy.reopen_expired` (позже 90 дней) |
| POST | `/vacancies/:id/pause` | приостановка (`vacancy.edit`); токен и внешние публикации сохраняются; `409 vacancy.not_published` |
| POST | `/vacancies/:id/close` | закрытие с причиной из перечня (`vacancy.close`); в ответе `candidatesInWork` — прохождение не прерывается; `422 reason.required` |
| POST | `/vacancies/:id/archive` | в архив (`vacancy.close`); `409 vacancy.has_pending_applications` с числом кандидатов в работе |
| POST | `/vacancies/:id/rotate-token` | «Оновити посилання»: старый токен умирает немедленно (`vacancy.publish`); `409 vacancy.not_published` |
| GET/POST | `/vacancies/:id/criteria` | критерии оценки кандидата со шкалой и весом (`vacancy.view` / `vacancy.criteria.manage`) |
| PATCH/DELETE | `/vacancies/:id/criteria/:cid` | правка и удаление критерия (`vacancy.criteria.manage`); `404` на чужой |
| POST | `/candidates/:id/criterion-scores` | баллы пачкой; ответ — **одна** свёрнутая `candidate_scores` с `kind='recruiter'` и предупреждением по критическим критериям; `422 criterion.out_of_scale` |
| GET/POST | `/vacancy-templates` | шаблоны вакансий (`vacancy.template.manage`); `409 template.name_exists` |
| POST | `/vacancy-templates/from-vacancy/:id` | «Зберегти шаблон» из формы: без точки и рекрутера, вместе с критериями и языками |
| POST | `/vacancies/from-template/:tid` | вакансия-черновик из шаблона: точка и рекрутер приходят телом (`vacancy.edit`) |

| GET | `/vacancies/:id/applications` | отклики вакансии, фильтр `state` (`vacancy.view`); вкладка «На модерації» — это `state=pending_review` |
| POST | `/vacancies/:id/applications/:aid/accept` | принять придержанный отклик вручную (`candidate.edit`): создаётся кандидат и назначение; `409 limit.candidates_exceeded`, `409 application.wrong_state` |
| POST | `/vacancies/:id/applications/:aid/reject` | отказ с причиной (`candidate.edit`); `422 validation_failed` |
| POST | `/vacancies/:id/applications/:aid/spam` | пометка «спам» (`candidate.edit`): человеку ничего не уходит |

**Публичный контур вакансии** (`29` §10, решение `docs/v2/44` В-9) — префикс `/api/v1/public/*`,
без сессии, тенант из токена ссылки, правило контура — `docs/27-gateway-public.md` §27.8.1.

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/public/j/:token` | публичная страница вакансии и `formNonce`; вилка — только при `salary_visible`, курса, рекрутера и внутренних идентификаторов в ответе нет. `404 vacancy.not_found` (чужой и несуществующий токен неразличимы, время выровнено), `410 vacancy.paused`, `429 rate.too_many` |
| POST | `/public/j/:token/apply` | отклик: `{fullName, phone?, email?, comment?, consent, formNonce, website, s?}`. **`202` при любом исходе проверок §7.6–§7.7** — форма не сообщает отправителю, какая сработала; `422 consent.required` и `422 form.stale` — единственные исключения, оба про человека, а не про спам |
| POST | `/public/j/:token/apply/:aid/confirm` | подтверждение контакта кодом: `200 {status:"accepted"}`; `400 otp.invalid`, `429 otp.too_many`, `410 application.expired` |

AI-генерация текста и критериев, площадки и журнал публикаций — PR-17 плана
`docs/v2/45-plan.md`. Приём резюме из публичного контура — там же (`29` §6.3, пометка PR-16).

### Жалоба на материал (`docs/v2/36-content-feedback.md` §10, PR-23)

| Метод | Путь | Описание |
| --- | --- | --- |
| POST | `/content-issues/reports` | подача жалобы (`content_issue.report`): `{targetType, targetId, blockId?, issueType, comment?, screenshotMediaId?, source, enrollmentId?, lessonId?, attemptId?, context}`. Ответ — `{issueId, reportId, merged, deadlineShiftSec, reportsToday, limitPerDay}`; `merged=true` — жалоба приклеилась к открытой карточке. Ошибки: `400 validation_failed`, `404` (чужой тенант, чужая попытка, скриншот не с `origin='issue_screenshot'`), `409 content_issue.already_reported`, `423 content_issue.reporter_muted`, `429 content_issue.rate_limited` (в `details` — `reason`, `used`, `limit`) |
| GET | `/me/content-reports` | «Мої повідомлення про помилки»: свои жалобы со статусом и ответом автора |
| GET | `/content-issues` | очередь «Звіт про помилки» (`content_issue.view`, PR-24): `tab=new\|in_progress\|fixed\|rejected\|all`, фильтры `issueType`, `targetType`, `courseId`, `authorId`, `assigneeId`, `locationId`, `from`, `to`, `affectsScoring`; `limit` (10/25/50/100) и ключевой курсор `cursor` (§4.1, ключ `reports_count, trusted, last_reported_at, id` по убыванию), в ответе `{items, total, limit, nextCursor}`. Видимость — из роли: администратор всё, методист свой контент, керівник точки — скарги со своих точек |
| GET | `/content-issues/:id` | карточка: заявители с контекстом, журнал (внутренние заметки — только тем, кто разбирает), «Вплив на результати», `actions` — кнопки этого человека. Чужая или невидимая — `404` |
| PATCH | `/content-issues/:id` | разбор (`content_issue.triage`): `{status?, resolution?, resolutionComment?, dueAt?, affectsScoring?, internalNote?}`. `400 content_issue.resolution_required`, `400 validation_failed` (резолюция не к переходу, отказ без комментария, срок вне 1–180 дней), `403` (закрыть и переоткрыть — только администратор), `409 content_issue.invalid_transition` с актуальной карточкой в `details.card` |
| POST | `/content-issues/:id/assign` | переназначить (`content_issue.assign`): `{userId}` — действующий сотрудник с правом разбора, иначе `400` |
| POST | `/content-issues/:id/comment` | комментарий в журнал (`content_issue.view`): `{comment, isInternal}` |
| GET | `/content-issues/:id/rescore-preview` | предпросмотр пересчёта (`content_issue.rescore`): `{mode, attemptsTotal, attemptsChanged, toPassed, toFailedSkipped, worseSkipped, avgDelta}`; `409 content_issue.not_a_quiz_issue` |
| POST | `/content-issues/:id/rescore` | «Перерахувати результати» из карточки — второй вход в «Перерахувати» теста (П-12.4): `{mode?: recalc\|void\|skip, reason}`. Ответ — `{mode, attemptsTotal, rescoredAttempts, toPassed, unchanged, worse[]}`: ухудшения не применяются и перечислены отдельно. `400 content_issue.resolution_required`, `409 content_issue.already_rescored` |
| GET/POST | `/settings/content-issue-routing-rules` | правила адресации (`content_issue.triage` — чтение, `content_issue.assign` — создание); непустой набор без запасного правила — `400 content_issue.fallback_rule_required` |
| PATCH/DELETE | `/settings/content-issue-routing-rules/:id` | правка и удаление правила (`content_issue.assign`); запасное правило выключить или удалить раньше остальных нельзя |
| POST | `/content-reporters/:userId/mute` \| `/unmute` | приостановить и вернуть приём жалоб (`content_issue.mute`): `{until, reason}`; снятие обнуляет серию `spam` |
| GET | `/reports/content-quality` | «Якість контенту» (`content_issue.view`): `groupBy=element\|course`, фильтры §9, `drillKey` — заявители строки единым каркасом, `format=xlsx` (`report.export`) |

Контекст жалобы собирает **сервер** (`36` §7.1): клиент присылает только то, чего сервер знать
не может (позиция плеера, прокрутка, вьюпорт, время на устройстве), а версию материала, версию
вопроса из снапшота попытки, заголовок карточки и `request_context` дописывает сам. Жалоба
во время попытки её не прерывает и таймер не съедает: `deadline_at` сдвигается на время формы,
до 60 секунд на жалобу и не больше 180 за попытку (§7.7). Очередь «Звіт про помилки», карточка
жалобы, маршрутизация и пересчёт результатов — PR-24 (строки выше с `/content-issues` без `reports`).

### Библиотека модулей (`docs/v2/31-module-library.md` §10, PR-25)

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/library/modules` | список и палитра (`library.view`): `?q=&kind=&categoryId=&tag=&ownerId=&status=active\|draft\|published\|archived\|all&onlyUnused=&onlyStale=&cursor=&limit=25\|50\|100`; по умолчанию `active` — архив скрыт, палитра просит `published`. Ответ — `{items, nextCursor, total}`, у карточки `usageCount`, `staleUsages`, `currentVersion` |
| POST | `/library/modules` | создать черновик (`library.publish`): поля `31` §6.1 плюс `body`/`mediaId`/`externalUrl` тела. `422 validation_failed` (текст — из формы §6.1), `409 slug_taken`, `422 owner_forbidden` («У цієї людини немає прав на бібліотеку») |
| GET/PATCH/DELETE | `/library/modules/:id` | карточка + черновик тела + `canEdit`; правка — автор из `author_ids` или `library.manage` (иначе `403 forbidden`, `details.reason = 'not_author'`), архивный — `409 module_archived`; удаление — только `library.manage`, используемый модуль — **`409 library_module.in_use`** с `details = {reason, usages[≤50], total, detached, versions, suggest: 'archive'}`; удалён — `204`. Чужой тенант — `404` |
| POST | `/library/modules/:id/archive`, `/restore`, `/duplicate` | архив `{reason}` (без причины — `422 reason_required`), возврат из архива, копия-черновик `{title?}` |
| GET/POST | `/library/modules/:id/versions` | список версий (changelog, `isHotfix`, `diff` с предыдущей, мест на версии); публикация `{changelog, isHotfix, notify, expectedVersion?}` — места на прежних версиях помечаются `isStale`, не переключаются. `422 changelog_required`, `422 empty_body`, `409 module_archived`, `409 version_conflict` |
| GET | `/library/modules/:id/versions/:version` | тело закреплённой версии — им читает себя место на v2, когда вышла v3 |
| GET | `/library/modules/:id/usages` | «Де використовується»: `{active, detached}` (`?includeDetached=true`), у места — `version`, `latestVersion`, `isStale`, `pinMode` |
| POST | `/library/usages` | вставить модуль (`library.use` + `course.edit` для урока / `program.manage` для узла, иначе `403 container.forbidden`): `{libraryModuleId, holderType, holderId, containerType, containerId, pinMode}`. `409 already_attached`, `409 module_archived`, `409 module_not_published`, `409 container.published`, `422 holder_not_content` |
| POST | `/library/usages/:id/detach` | отвязать: урок курса получает копию тела закреплённой версии (`{lessonId}`), у узла трека до PR-26 закрывается строка реестра |
| GET/POST | `/library/proposals` | предложения (куратор видит все, остальные — свои); подать `{sourceLessonId, proposedTitle?, proposedCategoryId?, comment}` (`library.use`) — `pending`, модуль не создаётся; повтор — `409 proposal_pending` |
| POST | `/library/proposals/:id/accept`, `/reject`, `/withdraw` | принять `{categoryId?, ownerId?}` → `{libraryModuleId}` (черновик с копией тела урока), отклонить `{decisionComment}` (`422 comment_required`), отозвать своё; повторное решение — `409 proposal.already_decided` |

Урок-ссылка на библиотеку в плане курса: `PATCH /lessons/:id` с `body` — `409 lesson.library_reference`
(тело читает закреплённую версию); урок-тело модуля по `/lessons/:id` — `404`. Файл, который
держит опубликованная версия модуля: `DELETE /media/:id` — `409 media.in_library_version` со
списком версий. Обновление мест до новой версии, массовое обновление, `diff` между версиями,
хотфикс и поиск по телу — PR-26.

### Заметки и документы человека (`docs/v2/38-people-extensions.md` §10, PR-32)

Права решает сервис, а не список скоупов на входе: свои заметки (только открытые) и свои
документы человек читает без `person.note.read` и `person.document.view_others`; руководитель
точки — в области своей роли и только уровня `manager` / типов `visible_to_manager`; HR — на весь
тенант. Чужой тенант и кандидат — `404`.

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/people/:id/notes` | лента заметок, видимых смотрящему, страницами: `?cursor=&limit=` (≤ 100, по умолчанию 30), порядок `is_pinned desc, created_at desc, id desc`, ключевой курсор `KEYSETS.personNotes`; ответ — `data` (заметки) и `meta: {cursor, limit, total, canCreate}`; **каждая страница пишет `person_note.read`** в `audit_log` с `{user_id, note_ids, count}` и без текста — единственный `GET` с побочным эффектом (`v2/41` §5.1); `403 forbidden`, битый курсор — `400 validation_failed` |
| GET | `/people/:id/notes/count` | число для свёрнутой секции «Нотатки (N)» и `canCreate`; содержания не читает, журнала не пишет |
| POST | `/people/:id/notes` | `{body, category, visibility, isPinned, confirmSensitive?}` (`person.note.write` в области точки человека); `422 note_body_invalid` (3–2000), `409 pinned_limit` (≤ 3), `409 note_sensitive_suspected` с `details.signs` — повтор с `confirmSensitive: true` сохраняет и ставит `flagged_at`, `409 person_archived`, `403 forbidden` (в т. ч. о себе) |
| GET | `/people/:id/notes/:noteId` | заметка по прямой ссылке; архивная — только администратору (`person.note.write` + `audit.view` на тенант); пишет `person_note.read` |
| PATCH | `/people/:id/notes/:noteId` | правка своей (администратор — любой); `409 visibility_narrowing_forbidden` — открытую человеку не сузить, `409 note_archived` |
| DELETE | `/people/:id/notes/:noteId` | свою — автор; чужую — администратор с `reason` (5–300), иначе `422 reason_required` |
| GET | `/people/:id/documents` | `{items, missing, total, types}`: документы, заглушки отсутствующих обязательных типов по посадам человека, типы для формы |
| POST | `/people/:id/documents` | `{typeId, mediaId?, number?, issuedAt, expiresAt?, title?, note?}`; тип «лише факт» с `mediaId` — `422 document_file_not_allowed`, без файла у остальных — `422 document_file_required`, `422 document_dates_invalid` (`details.reason`), `422 document_file_invalid`; истёкший — `201` с `meta.warnings: ['already_expired']` |
| PATCH | `/people/:id/documents/:docId` | `{expiresAt?, status?: 'revoked', reason?, note?}`; отмена необратима и только с причиной; `409 document_revoked` |
| DELETE | `/people/:id/documents/:docId` | обязательный тип — `409 document_is_evidence`; файл остального — в корзину, как `DELETE /media/:id` |
| GET | `/people/:id/documents/:docId/file` | подписанная ссылка на файл тем же правам, что документ (`?redirect=1` — 302); доказательство — 120 секунд и `media.download` в журнал |
| GET | `/person-document-types` | справочник: HR — все со счётчиком документов, руководитель — активные `visible_to_manager`, остальные — активные `self_upload` |
| POST | `/person-document-types` | новый тип — только HR (`person.document.manage` на тенант); без `code` сервер выдаёт свой `custom_…`; `409 code.exists` |
| PATCH/DELETE | `/person-document-types/:id` | правка и удаление — только HR; выключить используемый можно (`isActive: false`), удалить — `409 type_in_use`, системный — `409 type_is_system` |

Файл документа грузится единственным входом `POST /media/upload-url` с `origin='person_document'`
(PDF, JPG, PNG до 20 МБ); `media.upload` для этого не нужен — свой документ `self_upload`
загружает и сотрудник. Общий `GET /media/:id` такие файлы не отдаёт — только через документ.

**Публичный контур — единственное место в продукте, где запрос приходит без сессии.** Он уже
работает и обслуживает три сценария базового ТЗ и пакета под общим префиксом
`server/api/v1/public/` → `/api/v1/public/*` (префикс задаёт дерево каталогов Nitro, а не
строка в коде):

- `GET /api/v1/public/guest-page` — гостевая страница тенанта;
- `POST /api/v1/public/signup` — самостоятельная регистрация (лимит `signup:<ip>`, 3/час);
- `GET /api/v1/public/mystery/[token]`, `POST /api/v1/public/mystery/[token]` — чек-лист
  тайного гостя (`docs/14-certification.md`);
- `GET /api/v1/public/j/:token`, `POST /api/v1/public/j/:token/apply` и производные —
  публичная страница вакансии и отклик без сессии (`docs/v2/29-vacancies.md` §10);
- `GET /api/v1/public/candidate-summaries/[token]` — итог кандидата для человека вне тенанта
  (`docs/v2/30-ai-interview.md` §10).

Изоляция тенанта без сессии устроена одинаково для всех ручек контура: тенант выводится из
токена ссылки (`hash(token)` → поиск на admin-подключении → `withTenant(tenant_id, created_by,
…)` с ролью минимальных прав), а не из тела запроса. Каждая ручка обязана: (а) выводить тенанта
из токена или хоста, (б) идти через `withTenant()`, (в) иметь `hitRateLimit`, (г) отвечать на
несуществующий токен `404`, выровненным по времени.

### Учёт времени биениями (`docs/v2/37-review-delegation.md` §7.10–7.15, §10, PR-21)

| Метод | Путь | Описание |
| --- | --- | --- |
| POST | `/learning/time/beat` | одно биение экрана прохождения (`learn.view`): `{sessionKey, seq, kind, subjectType, subjectId, enrollmentId?, activeMs, visible, clientTs, device?, resume?, end?}`. Ответ — `{credited, dailyLeft, segmentNo, capped, stillHere, duplicate}`. Идемпотентен по `(sessionKey, seq)` без `Idempotency-Key`: повтор возвращает тот же `credited`. Ошибки: `422 time.beat_invalid` (не разобрано, смена вида в сеансе, чужой `sessionKey`), `404` (элемент или запись на курс не найдены, в том числе чужого тенанта), `429 rate_limited` (больше 20 биений человека за 30 секунд) |
| POST | `/learning/time/beats` | пакет до 200 биений, накопленных без связи: `{beats, sentAt?}`. Ответ — `{credited, discarded, accepted, duplicates, rejected, stillHere}`; биения удалённого за это время элемента отбрасываются поштучно. `422 time.replay_too_old` — старейшее биение старше 24 часов, его время записано в выброшенное (`details.discarded`); `429` — больше 6 пакетов в минуту |
| GET | `/learning/time/totals` | «Час на контент» и «Час на випробування» по элементам: `?userId&subjectType&subjectId&enrollmentId`. Своё — всем с `learn.view`; чужое — `time.metrics.view` в области роли (`403 forbidden` вне её); человек другого тенанта или несуществующий — `404` |

Время считает **сервер**: за биение — не больше заявленной активности, не больше прошедшего
по его часам и не больше 30 секунд; пауза дольше 120 секунд не засчитывается, сегмент дольше
90 минут ждёт «Продовжити», больше 8 часов в сутки не засчитывается (`37` §7.11). Биения пишут
только сегменты `learning_time_sessions`; витрину, прогресс урока, попытку, сдачу и колонки
времени очереди проверки пересчитывает фоновая `time.rollup` (раз в 10 минут). Колонки времени
попытки — учёт, а не правило: срок попытки по-прежнему только `deadline_at`.
