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
| POST | `/auth/otp/request` | `{phone}` → отправка кода; ответ всегда 200 (не раскрываем наличие номера) |
| POST | `/auth/otp/verify` | `{phone, code}` → сессия или список тенантов для выбора |
| POST | `/auth/tenant/select` | `{tenantId}` → сессия в выбранном тенанте |
| POST | `/auth/password/login` | `{email, password}` (если включено тенантом) |
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
| GET | `/me/tasks` | мои задания; `?group=new\|planned\|failed\|overdue\|done` — пять групп эталона |
| GET | `/me/tasks/:id` | карточка задания: контент, сроки, правила, прогресс |
| GET | `/me/trajectories` | мои траектории с деревом и текущим блоком |
| GET | `/me/catalog` | каталог: `?kind=tasks\|trajectories`, фильтр по категории |
| POST | `/me/catalog/:id/enroll` | самозапись (режим «Вільний доступ») |
| POST | `/me/catalog/:id/request` | заявка (режим «Подання заявки») |
| GET | `/me/development-plan` | планы развития: `?status=active\|inactive\|done` |
| GET | `/me/certificates`, `/me/badges` | достижения |
| GET | `/me/study-history` | история и динамика рейтинга (свой и внешний) |
| GET | `/me/bonuses` | баланс и книга операций |
| GET/PATCH | `/me/notifications/prefs` | свои переключатели уведомлений |
| POST | `/me/role/switch` | `{roleId}` — переключение активной роли (`01` §1.9.2) среди своих действующих; чужая, снятая или истёкшая — 403 `forbidden`, по API-токену — 400; ответ `{activeRole, changed}`, событие `role.switch` в аудите с обеими ролями |

## 4.5 Прохождение контента

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/enrollments/:id` | состояние прохождения: дерево, прогресс, доступность элементов |
| GET | `/enrollments/:id/items/:itemId` | тело урока или ресурса, если элемент доступен |
| POST | `/enrollments/:id/items/:itemId/tick` | `{seconds, scrollPct, videoPct, blocksState}` идемпотентно, окно 15 с; ответ `{secondsSpent, scrollPct, videoPct, ready, reasons, requiredSeconds}`. Сегодня — `/learning/enrollments/:id/lessons/:lessonId/tick`, рядом `/acknowledge` и `/download` |
| POST | `/enrollments/:id/items/:itemId/complete` | завершение; сервер сам проверяет условия зачёта (`11` Г-11.5) |
| POST | `/enrollments/:id/items/:itemId/acknowledge` | «Я ознайомився» для ссылок и объявлений |
| POST | `/enrollments/:id/migrate-version` | перейти на новую версию материала (`10` Г-10.1) |

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
| POST | `/review/workshops/:id/claim` | взять в работу (блокировка 30 минут) |
| POST | `/review/workshops/:id/grade` | `{decision: passed\|rework\|failed, criteria[], comment}` |
| GET | `/review/checklists` | заполненные чек-листы на согласование |

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
| GET | `/learning/resources/:id` | ресурс для ученика: текущая версия, только при доступе; иначе 404 |
| CRUD | `/tests/:id/questions`, `/question-groups` | вопросы и их группы (`12` §14.3): `GET/POST /tests/:id/question-groups`, `PATCH/DELETE /question-groups/:id` |
| POST | `/tests/:id/questions/import` | «Питання з іншого тесту» (копия) и «з банку» (ссылка) |
| CRUD | `/polls/:id/questions` | вопросы опроса (четыре типа) |
| CRUD | `/complex-tests/:id/items` | состав: тесты, сгруппированные по темам |
| CRUD | `/checklists`, `/assessments` | анкеты; параметры замораживаются после первого заполнения |
| CRUD | `/criteria-groups`, `/criteria`, `/scales` | словарь критериев и шкал (`24` Г-24.4) |

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
| POST | `/trajectories/enrollments/:id/{cancel,decide}` | снятие с причиной / решение по заявке из каталога |
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
| POST | `/people/:id/password` | смена пароля администратором (отдельный эндпоинт, отдельный скоуп) |
| POST | `/people/import` | CSV → `importJobId`, файл проверяется целиком |
| GET | `/people/import/:id` | протокол: создать N, обновить M, ошибок K с номерами строк |
| POST | `/people/import/:id/apply` | применить (всё или ничего) |
| CRUD | `/org-units`, `/locations`, `/positions`, `/position-levels`, `/cities`, `/user-groups` | справочники |
| CRUD | `/tags` | метка с обязательной областью действия (`16` §14.2) |
| GET | `/org-conflicts` | протокол конфликтов оргструктуры |

## 4.12 Развитие и оценка

| Метод | Путь | Описание |
| --- | --- | --- |
| CRUD | `/competencies`, `/competencies/:id/indicators`, `/competency-profiles` | словарь и профили должностей |
| GET | `/people/:id/competencies` | уровни с источником и датой (`19` Г-19.2) |
| POST | `/people/:id/competencies/:cid` | ручная установка с причиной |
| CRUD | `/development-plans` | планы развития |
| CRUD | `/goals`, `/goal-statuses` | цели и справочник их статусов |
| CRUD | `/requests` | заявки: `kind=external_learning\|career`, маршрут согласования (`19` Г-19.1) |
| POST | `/assessments/:id/cycles` | цикл оценки: состав оценщиков по ролям |
| GET | `/assessments/:id/cycles/:cid/report` | результат с порогом показа (`20` Г-20.2) |

## 4.13 Хаб

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/knowledge/search` | единый поиск: `?in=all\|resources\|news\|forum\|wiki` |
| CRUD | `/knowledge/access-groups` | группы доступа к ресурсам |
| POST | `/knowledge/:id/bookmark` | закладка |
| CRUD | `/news`, `/notices`, `/simple-notices` | лента и объявления |
| POST | `/notices/:id/acknowledge` | «Ознайомлений» — подтверждение (`21` §14.5) |
| GET | `/notices/:id/coverage` | кто подтвердил, кто нет |
| CRUD | `/gift-store/items` | товары магазина |
| POST | `/gift-store/items/:id/order` | покупка → резерв |
| POST | `/gift-store/orders/:id/status` | `ready` \| `issued` \| `cancelled` (`21` Г-21.1) |
| GET | `/bonuses/ledger` | книга операций с остатком в строке |
| POST | `/bonuses/adjust` | ручное начисление или списание с причиной |
| CRUD | `/guest-blocks` | гостевая страница |
| GET | `/comments` | единая лента комментариев со всех источников |
| POST | `/comments/:id/read`, `/comments/:id/reply` | пометка и ответ автору материала |

## 4.14 Отчёты и журналы

Единая форма: `GET /reports/:name` с общими параметрами
`?from=&to=&locationIds=&positionIds=&tagIds=&context=any|standalone|in_course|in_program`
и специфичными для отчёта. Все отчёты отдают одинаковую «левую часть» (`22` §13.3).

| Путь | Что |
| --- | --- |
| `/reports/tasks/:contentType` | по типу контента; `?taskId=` даёт отчёт назначения, `?subjectId=` — по предмету; `format=xlsx`. Четыре части: `overview`, `accesses`, `stats`, `rows` (каркас + правая часть). Пока `course`, `training_program`, `test`; остальные — 422 `report.unsupported` |
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
| `/logs/notifications` | уведомления + вкладка подключений Telegram |
| `/logs/imports`, `/logs/bonuses`, `/logs/goal-statuses` | остальные журналы |
| POST `/reports/:name/export` | фоновая выгрузка → уведомление со ссылкой; область — по роли, активной в момент запроса. Имена: отчёты `22` §9, `tasks-<contentType>`, `summary`, `log-<kind>`, `saved:<id>`. Колонки каркаса — первые |
| CRUD `/saved-reports` | сохранённый отчёт с расписанием (`22` Г-22.2, наш конструктор) |

## 4.15 Медиа

| Метод | Путь | Описание |
| --- | --- | --- |
| POST | `/media/upload-url` | `{filename, mime, bytes, resourceId?}` → presigned PUT, `mediaId`; отказ 400 `media.too_big \| media.mime_not_allowed \| media.resource_too_big` до передачи |
| POST | `/media/:id/complete` | подтверждение загрузки, запуск обработки |
| GET | `/media/:id` | статус и подписанная ссылка на чтение (10 минут) |
| DELETE | `/media/:id` | мягкое удаление |

Ограничения (`11` Г-11.4): изображение ≤ 10 МБ, документ ≤ 50 МБ, аудио ≤ 100 МБ,
видео ≤ 500 МБ, на ресурс суммарно ≤ 1 ГБ; mime — allowlist; ключ — uuid,
оригинальное имя хранится в БД. Файл чужого тенанта — **404, не 403** (`25` §10).

## 4.16 Настройки

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/PATCH | `/settings/tenant` | бренд, языки, флаги модулей (`24` Г-24.2) |
| GET/PATCH | `/settings/policies` | десять групп политик эталона (`24` §3.4.1) |
| CRUD | `/settings/roles` | роли и скоупы (`24` Г-24.1) |
| GET/PUT | `/settings/position-role-map` | правило «должность → роль»: `{items: [{positionId, roleCode, scopeType, scopeId?}]}` целиком; применяется при следующей смене должности или импорте |
| CRUD | `/settings/notification-templates` | шаблоны: `subject`, `body_text`, `body_mjml` |
| GET/PUT | `/settings/notification-schedule` | время отправки по классам событий (`23` §13.2.1) |
| GET/PUT | `/settings/email-layout` | шапка и подвал письма |
| CRUD | `/settings/integrations` | SMTP, Telegram (свой и внешний), источники людей, вебхуки, API-токены |
| CRUD | `/settings/translations` | переопределение строк интерфейса |
| GET | `/settings/usage` | потребление: активные, диск, дата последнего сбора (`24` §4.4.1) |
| GET | `/audit` | журнал изменений |
| GET | `/health`, `/ready`, `/metrics` | служебное |

## 4.17 Панель оператора платформы

Отдельный префикс `/api/v1/platform`, отдельный набор скоупов, недоступен
администратору тенанта ни на чтение (`24` Г-24.3).

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/POST | `/platform/tenants` | список и создание |
| GET/PATCH | `/platform/tenants/:id` | карточка, тариф, лимиты |
| POST | `/platform/tenants/:id/impersonate` | вход «от имени»: обязательна причина, 60 минут, запись в журнал безопасности тенанта |
| GET | `/platform/metrics` | метрики платформы |
| POST | `/platform/tenants/:id/anonymized-dump` | обезличенный слепок (`25` §16.3) |

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
