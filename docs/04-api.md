# Lola LMS — ТЗ. Часть 4. API

## 4.1 Общие правила

- База: `/api/v1`. Формат — JSON, UTF-8. Даты — ISO 8601 с таймзоной.
- Аутентификация — сессионная cookie (`lola_sid`, httpOnly, Secure, SameSite=Lax).
  Для интеграций — `Authorization: Bearer <api_token>` (токены тенанта, скоупы те же).
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

## 4.2 Аутентификация

| Метод | Путь | Описание |
| --- | --- | --- |
| POST | `/auth/otp/request` | `{phone, channel?: 'sms'\|'email'}` → отправка кода; ответ `{channel, maskedEmail?, devCode?}` (`channel='email'` — код ушёл письмом, `maskedEmail` вида `d***@gmail.com`); всегда 200, кроме `422 no_channel` (нет ни Telegram, ни SMS, ни почты — «Зверніться до менеджера точки») |
| POST | `/auth/otp/verify` | `{phone, code}` → сессия или список тенантов для выбора |
| POST | `/auth/tenant/select` | `{tenantId}` → сессия в выбранном тенанте |
| POST | `/auth/password/login` | `{email, password}` (если включено политикой `passwords.loginEnabled`, иначе 403 `password_login_disabled`); ответ `{requiresTenantSelect, mustChangePassword}` либо `selectToken` + `tenants`; N неудач → 429 |
| POST | `/me/password` | `{currentPassword?, password}` — свой пароль; текущий обязателен, если он был (403 `wrong_current`), кроме восстановления (docs/33 D-021): без текущего — после входа по коду (e-mail всегда, телефон при `passwords.allowPhoneRecovery`), при `passwords.disableRecovery` — 403 `recovery_disabled`; `/auth/me` отдаёт `user.canRecoverPassword`; остальные сессии закрываются |
| POST | `/auth/invite/accept` | `{token}` → активация и сессия |
| POST | `/auth/logout` | текущая сессия |
| POST | `/auth/logout-all` | все сессии пользователя |
| GET | `/auth/me` | профиль, `activeRole`, `roles` (все действующие — для переключателя), `scopes` активной роли, настройки тенанта |

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
| GET | `/me/bonuses` | баланс и книга операций — нет вовсе, долг (docs/28 «Spec 04») |
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
| GET | `/review/answers` | очередь **ответов** (`12` §14.4); фильтры: `checked`, метки вопросов, точка, курс, давность |
| POST | `/review/answers/:id/grade` | `{score, comment}`; наставнику видна `grader_hint` |
| GET | `/review/workshops` | очередь сдач практикумов; сортировка по времени в очереди |
| POST | `/review/workshops/:id/claim` | взять в работу (блокировка 30 минут) (старый путь: `/review/submissions/:id/claim`, до конца R1) |
| POST | `/review/workshops/:id/grade` | `{decision: passed\|rework\|failed, criteria[], comment}` (старый путь: `/review/submissions/:id/grade`, до конца R1) |
| GET | `/review/checklists` | заполненные чек-листы на согласование — нет вовсе, долг (docs/28 «Spec 04») |

## 4.8 Контент (методист)

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/POST | `/content` | список всех типов; `?contentType=`, `?tags=`, `?authorId=` |
| GET/PATCH/DELETE | `/content/:id` | карточка (общие поля всех типов) |
| POST | `/content/:id/versions` | новая черновая версия |
| POST | `/content/:id/publish` | публикация; `{notifyAssigned: bool}` — «Сповістити про оновлення» (`11` §14.2) |
| POST | `/content/:id/duplicate` | копия |
| CRUD | `/courses/:id/sections`, `/courses/:id/items` | план курса: разделы и элементы, у теста в плане свой `passScorePct`; сегодня — `/courses/:id/modules`, `/courses/:id/lessons` (`resourceId` подключает опубликованный ресурс; без раздела — 422 `course.section_required`) |
| GET/POST | `/resources` | библиотека ресурсов: `?status=all\|draft\|published\|archived`, `kind`, `authorId`, `tag`, `categoryId`, `q`, `page`, `perPage` (`11` §5.1) |
| GET/PATCH/DELETE | `/resources/:id` | рабочая редакция + `versions`, `accessGroupIds`, `usedInCourses`; удаление используемого — 422 `resource.in_use` |
| POST | `/resources/:id/publish` | `{changelog?, notifyAssigned}` → снимок версии; 422 `resource.not_publishable` с `checks` |
| GET | `/resources/:id/versions` | снимки (Г-11.3) |
| POST | `/resources/:id/duplicate`, `/archive`, `/restore` | копия; архив ↔ чернетка |
| CRUD | `/resource-categories`, `POST /resource-categories/reorder` | категории ресурсов с порядком (`{ids[]}`) |
| CRUD | `/access-groups` | группы доступа (`?appliesTo=knowledge\|catalog`), члены `{subjectType, subjectId}` |
| GET | `/learning/resources/:id` | ресурс для ученика: текущая версия, только при доступе; иначе 404. `?assignmentId=` — версия, закреплённая назначением (D-007) |
| CRUD | `/tests/:id/questions`, `/question-groups` | вопросы и их группы (`12` §14.3): `GET/POST /tests/:id/question-groups`, `PATCH/DELETE /question-groups/:id`; правка и удаление вопроса — по-прежнему `PATCH /questions/:id` (старый путь для списка и создания — `/questions?quizId=`, до конца R1) |
| POST | `/tests/:id/questions/import` | «Питання з іншого тесту» (копия) и «з банку» (ссылка) |
| CRUD | `/polls/:id/questions` | вопросы опроса (четыре типа). Spec 20: реализовано как `GET/POST /surveys`, `GET/PATCH /surveys/:id` (вопросы в теле; после первого ответа вопросы/режим/приватность — 409 `survey.locked`), `GET /surveys/:id/report` (конфіденційно — имена только владельцу) |
| POST | `/learning/surveys/:id/start`, `/learning/surveys/:id/answer` | прохождение опроса по одному вопросу: сервер отдаёт следующий по правилам «з умовами», граф клиенту не уходит; `{questionId, answer}` → `{done:false, question}` \| `{done:true, results?}`; 422 `survey.required\|bad_option\|own_not_allowed\|bad_value` |
| CRUD | `/complex-tests/:id/items` | состав: тесты, сгруппированные по темам |
| CRUD | `/checklists`, `/assessments` | анкеты; параметры замораживаются после первого заполнения. Spec 20: `PUT /checklists` (`scaleId`, `allowSkip`, `allowItemComment`, `itemCommentRequired`, пункты с весом) и `PUT /assessment/forms` (`kind`, `scaleId`, правила комментирования, `items[{criterionId, norm, cluster}]`), `GET /assessment/forms/:id`; замороженное поле → 409 `checklist.locked` \| `form.locked` с `details.fields`; норма вне шкалы — 422 `form.bad_norm` |
| CRUD | `/criteria-groups`, `/criteria`, `/scales` | словарь критериев и шкал (`24` Г-24.4): `/scales?kind=range\|levels`, `PUT /scales/:id` пересобирает уровни целиком, диапазоны подряд 0–100. Spec 20: `/assessment/groups` (с `tags`, счётчики использования), `GET /assessment/groups/usage` («Де використовуються»), `DELETE /assessment/criteria/:id` из замороженной анкеты — 409 `criterion.in_use`; `/rating-scales` снят — шкалы анкет живут в `scales(kind=levels)` |

## 4.9 Назначения

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/POST | `/tasks` | список / создание; `?type=manual\|auto\|catalog\|trajectory\|archive` |
| GET/PATCH | `/tasks/:id` | карточка |
| GET/PUT | `/tasks/:id/params` | правила прохождения (`assignments.params`, `02` §2.7) |
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
| GET/POST | `/people` | список с фильтрами (посада, місто, підрозділ, мітки, рівень, активність) |
| GET/PATCH | `/people/:id` | карточка (`16` §14.4) |
| POST | `/people/:id/roles` | роль в области: `{roleCode, scopeType, scopeId?, validUntil?, reason?}`; повтор той же роли в той же области — редактирование срока и причины |
| DELETE | `/people/:id/roles/:code` | снять роль; `?reason=` — в аудит; последний администратор — 409 `last_admin` |
| POST | `/people/:id/password` | `{password, mustChange?}` — смена пароля администратором, скоуп `people.password`; 400 `too_short` \| `weak` по политикам «Паролі» |
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
| CRUD | `/development-plans` | планы развития; заведены создание, переход по статусу и назначение наставника плана (`POST /:id/mentor`, `mentor_id`, docs/19 §3.4, screens-7) (старый путь: `/development/plans`, до конца R1) — списка, карточки и удаления нет вовсе, долг (docs/28 «Spec 04») |
| CRUD | `/goals`, `/goal-statuses` | цели и справочник их статусов |
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
| CRUD | `/news`, `/notices`, `/simple-notices` | лента и объявления; `GET/POST /news/categories`; `GET /notices/pending` — что показать при входе, `GET /notices/mine`; `POST /simple-notices/:id/view` |
| POST | `/notices/:id/acknowledge` | «Ознайомлений» — подтверждение (`21` §14.5); объявление назначается через `POST /tasks {subjectType: notice}` |
| GET | `/notices/:id/coverage` | кто подтвердил, кто нет, по точкам; `POST /notices/:id/remind` — «Нагадати тим, хто не підтвердив» |
| GET | `/birthdays`, `/contacts`, `/events` | дни рождения (`?tab=upcoming\|past&from=&to=`), контакты (`?q=&orgUnitId=&positionId=&cityId=`), события; `POST /events`, `PATCH /events/:id`, `POST /events/:id/register`; `PATCH /me/birthday-consent` |
| GET | `/public/guest-page` | гостевая страница без входа: тенант по поддомену `Host` или `?slug=`; неизвестный — 404; `passwordLogin`, `hideLoginForm` (политика «Приховати форму входу», действует при настроенном Google; тогда код/пароль → 403 `login_form_hidden`) |
| CRUD | `/gift-store/items` | товары магазина |
| POST | `/gift-store/items/:id/order` | покупка → резерв |
| POST | `/gift-store/orders/:id/status` | `ready` \| `issued` \| `cancelled` (`21` Г-21.1) |
| GET | `/bonuses/ledger` | книга операций с остатком в строке |
| POST | `/bonuses/adjust` | ручное начисление или списание с причиной |
| GET/PUT | `/guest-blocks` | гостевая страница тенанта: три блока (`21` Г-21.3) |
| GET/POST | `/comments` | єдина лента комментариев со всех источников; `?sourceType=&isRead=read\|unread&cursor=&limit=`; створення — `{sourceType: task\|course\|program\|knowledge\|notice, sourceId, body}`, маршрутизація автору матеріалу рахується сервером (Spec 10, `10` §14.2) |
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
| `/logs/task-status` | протокол смены статусов (`enrollment_events` ∪ `attempt_results`), фильтры `contentType`, `contentId` |
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
| POST | `/media/upload-url` | `{filename, mime, bytes, resourceId?}` → presigned PUT, `mediaId`; отказ 400 `media.too_big \| media.mime_not_allowed \| media.resource_too_big` до передачи |
| POST | `/media/:id/complete` | подтверждение загрузки, запуск обработки |
| GET | `/media/:id` | статус и подписанная ссылка на чтение (10 минут); оригинал SVG — только после санитизации (`ready`), до этого `?redirect=1` → 409 `not_ready` (D-011) |
| DELETE | `/media/:id` | мягкое удаление |

Ограничения (`11` Г-11.4): изображение ≤ 10 МБ, документ ≤ 50 МБ, аудио ≤ 100 МБ,
видео ≤ 500 МБ, на ресурс суммарно ≤ 1 ГБ; mime — allowlist; ключ — uuid,
оригинальное имя хранится в БД. Файл чужого тенанта — **404, не 403** (`25` §10).

## 4.16 Настройки

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/PATCH | `/settings/tenant` | простір: `name`, `slug` (409 `slug_taken` / `slug_locked` — после первого входа сотрудника не меняется, `29` Б.12), `locale`, `timezone`, `accent` только из палитры (`29` Б.14), `space`, `defaults`, `quietHours`; `GET` отдаёт ещё `slugLocked`, `plan`, `modules` |
| GET/PATCH | `/settings/policies` | десять групп политик эталона (`24` §3.4.1) |
| CRUD | `/settings/roles` | роли и скоупы (`24` Г-24.1): `GET` (people.view, со счётчиками и группами скоупов), `POST`, `PATCH /:id`, `DELETE /:id` (settings.tenant); 409 `code_taken` · `admin_role` · `role_in_use` · `last_settings_role`, 403 `scope_not_owned` |
| GET/PUT | `/settings/position-role-map` | правило «должность → роль»: `{items: [{positionId, roleCode, scopeType, scopeId?}]}` целиком; применяется при следующей смене должности или импорте |
| POST | `/settings/position-role-map/reapply` | «Перезібрати ролі по мережі» (`28` D-001): применяет текущую карту ко всем действующим основным размещениям тенанта сразу |
| CRUD | `/settings/notification-templates` | шаблоны: `subject`, `body_text`, `body_mjml` (старый путь: `/settings/notifications`, до конца R1; список и правка целиком — `PUT`, не `POST`/`PATCH`, как и было) |
| GET/PUT | `/settings/notification-schedule` | время отправки по классам событий (`23` §13.2.1) |
| GET/PUT | `/settings/email-layout` | шапка и подвал письма |
| CRUD | `/settings/integrations` | SMTP, Telegram (свой и внешний), источники людей, вебхуки, API-токены |
| POST | `/settings/integrations/:provider/test` | тестовое сообщение без постановки в очередь (пока только `smtp`, `23` §13.4) |
| CRUD | `/settings/translations` | переопределение строк интерфейса: `GET ?locale&q&changedOnly&page`, `PUT {locale,key,value}`, `DELETE ?locale&key?` (без key — весь набор), `GET /export?locale`, `POST /import {locale, items}`; клиенту — `GET /translations/:locale` (любая сессия) поверх словаря |
| GET | `/settings/usage` | потребление: активные, диск, SMS, дата последнего сбора, тариф и лимиты (`24` §4.4.1) |
| GET/PATCH | `/settings/modules` | переключатели модулей; выключенный модуль → 403 `module.disabled` на его маршрутах (`24` §3.2) |
| CRUD | `/course-categories`, `POST /course-categories/reorder` | «Категорії каталогу навчання» с порядком (`24` §3.7.1); категория с курсами — 409 `in_use` |
| GET/PATCH | `/settings/catalog` | тумблер «Використовувати обмеження доступу до завдань в каталозі навчання» — `{restrictAccess}`, за замовчуванням вимкнено (`10` §14.1, Spec 10); групи доступу — той самий `/access-groups?appliesTo=catalog` |
| GET | `/certificates/summary` | сводка сертификатов по курсам для экрана Certificates |
| POST | `/auth/impersonation/stop` | выход из режима «от имени» с плашки → `impersonation.ended` |
| GET | `/audit` | журнал изменений |
| GET | `/health`, `/ready`, `/metrics` | служебное — намеренно вне `/api/v1` (health-чек не должен зависеть от версии API), `server/routes/{health,ready,metrics}.get.ts`, docs/28 «Spec 04» |

## 4.17 Панель оператора платформы

Отдельный префикс `/api/v1/platform`, отдельный набор скоупов, недоступен
администратору тенанта ни на чтение (`24` Г-24.3).

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/POST | `/platform/tenants` | список и создание |
| GET/PATCH | `/platform/tenants/:id` | карточка, тариф (`plan`), триал, название, settings; статус — только suspend/resume/purge |
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

## 4.18 Вебхуки наружу

События: `enrollment.completed`, `attempt.passed`, `attempt.failed`, `certificate.issued`,
`certificate.revoked`, `task.overdue`, `notice.acknowledged`, `user.created`.
Доставка: POST с подписью `X-Lola-Signature` (HMAC-SHA256 по телу), три повтора
с экспонентой, журнал доставок с телом запроса и ответом, ручной повтор из интерфейса.

## 4.19 Телеграм-бот

- `/start <token>` — привязка `telegram_chat_id` (токен одноразовый, 15 минут).
- Кнопки под уведомлением: «Пройти», «Відкласти на день», «Не нагадувати про це».
- Бот не ведёт обучение в чате: всё открывается в вебе по ссылке с автологином
  (одноразовый токен, 10 минут, привязан к `chat_id` и коду уведомления).
- Ошибки: 403 — бот заблокирован, канал переключается на SMS; 429 — `retry_after`;
  400 «chat not found» — сброс привязки.

## 4.20 Заняття, вебінари — сесії на призначенні (Spec 18)

Базовий `CRUD /meetups`, `/meetups/schedule`, `/meetups/checkin` (`18` §10) лишається без змін —
обслуговує стару однораундову картку та `kind=event` (Spec 21). Нове — сесії, прив'язані до
призначення (`18` §14.1), окремою моделлю поверх картки:

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
