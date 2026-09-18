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
| GET | `/auth/me` | профиль, роли, скоупы, настройки тенанта |

Лимиты: `/auth/otp/request` — 3 на номер / 15 мин и 30 на IP / час; `/auth/otp/verify` — 5 на код.

## 4.3 Обучение (кабинет)

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/learning/my` | назначенное: активное, просроченное, завершённое |
| GET | `/learning/catalog` | каталог с фильтрами |
| POST | `/learning/enroll` | `{courseId}` самозапись |
| GET | `/learning/enrollments/:id` | курс с деревом модулей и прогрессом |
| GET | `/learning/lessons/:id` | тело урока (только если урок доступен) |
| POST | `/learning/lessons/:id/tick` | `{seconds}` идемпотентно, окно 15 с |
| POST | `/learning/lessons/:id/complete` | завершение урока; сервер проверяет условия |
| GET | `/learning/certificates` | свои сертификаты |

## 4.4 Тесты и попытки

| Метод | Путь | Описание |
| --- | --- | --- |
| POST | `/quiz/:id/attempts` | старт попытки → снапшот, `attemptId`, дедлайн |
| GET | `/attempts/:id` | текущее состояние: вопросы (без эталонов), ответы, остаток времени |
| PUT | `/attempts/:id/answers/:questionId` | сохранить ответ (автосохранение) |
| POST | `/attempts/:id/submit` | отправка; ответ: результат или `review` |
| GET | `/attempts/:id/result` | разбор после завершения (по правилу `show_answers`) |
| POST | `/attempts/:id/reset` | сброс попыток (скоуп `review.grade`) |

Сервер никогда не отдаёт эталонные ответы до завершения попытки — проверка на уровне сериализатора,
отдельный тест `tests/integration/attempt-leak.spec.ts`.

## 4.5 Проверка (наставник)

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/review/queue` | очередь: фильтры по точке, курсу, давности |
| GET | `/review/answers/:id` | ответ с контекстом вопроса и историей попыток |
| POST | `/review/answers/:id/grade` | `{isCorrect, score, comment}` |
| POST | `/attempts/:id/confirm-offline` | подтверждение очной части |

## 4.6 Контент (методист)

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/POST | `/courses` | список / создание |
| GET/PATCH/DELETE | `/courses/:id` | карточка, правка, мягкое удаление |
| POST | `/courses/:id/versions` | новая черновая версия |
| POST | `/courses/:id/publish` | публикация версии, `{changelog}` |
| POST | `/courses/:id/duplicate` | копия |
| CRUD | `/modules`, `/lessons` | структура курса |
| POST | `/lessons/:id/reorder` | `{sort}` |
| CRUD | `/question-banks`, `/questions` | банк вопросов |
| CRUD | `/quizzes`, `/quizzes/:id/questions` | тесты |
| CRUD | `/knowledge` | база знаний |
| CRUD | `/surveys` | опросы |

## 4.7 Люди и назначения

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/POST | `/people` | список с фильтрами / создание |
| PATCH | `/people/:id` | профиль, статус |
| POST | `/people/:id/invite` | выслать приглашение повторно |
| POST | `/people/:id/placements` | точка и позиция |
| POST | `/people/:id/roles` | назначение роли в области |
| POST | `/people/import` | загрузка файла → `importJobId` |
| GET | `/people/import/:id` | статус, статистика, ссылка на отчёт об ошибках |
| POST | `/people/import/:id/apply` | применить после предпросмотра |
| GET/POST | `/assignments` | список / создание |
| DELETE | `/assignments/:id` | отмена |
| GET | `/assignments/:id/preview` | сколько человек попадёт под условие (до создания) |

## 4.8 Отчёты

| Метод | Путь | Описание |
| --- | --- | --- |
| GET | `/reports/readiness` | готовность по точкам и позициям |
| GET | `/reports/course/:id` | воронка курса |
| GET | `/reports/overdue` | просроченные |
| GET | `/reports/attempts` | результаты аттестаций |
| GET | `/reports/activity` | активность |
| POST | `/reports/:name/export` | фоновая выгрузка → уведомление со ссылкой |

## 4.9 Медиа

| Метод | Путь | Описание |
| --- | --- | --- |
| POST | `/media/upload-url` | `{filename, mime, bytes}` → presigned PUT, `mediaId` |
| POST | `/media/:id/complete` | подтверждение загрузки, запуск обработки |
| GET | `/media/:id` | статус и подписанная ссылка на чтение (10 минут) |
| DELETE | `/media/:id` | мягкое удаление |

Ограничения: изображение ≤ 15 МБ, видео ≤ 500 МБ, документ ≤ 50 МБ; mime — allowlist;
имя файла не влияет на ключ (ключ — uuid), оригинальное имя хранится в БД.

## 4.10 Настройки и служебное

| Метод | Путь | Описание |
| --- | --- | --- |
| GET/PATCH | `/settings/tenant` | бренд, языки, тихие часы, флаги модулей |
| CRUD | `/settings/roles` | роли и скоупы |
| CRUD | `/settings/notifications` | шаблоны |
| CRUD | `/settings/integrations` | Telegram, SMS, вебхуки, API-токены |
| GET | `/audit` | журнал с фильтрами |
| GET | `/health` | liveness: процесс жив |
| GET | `/ready` | readiness: БД, очередь, S3 |
| GET | `/metrics` | Prometheus |

## 4.11 Вебхуки наружу

События: `enrollment.completed`, `attempt.passed`, `attempt.failed`, `certificate.issued`,
`assignment.overdue`. Доставка: POST с подписью `X-Lola-Signature` (HMAC-SHA256 по телу),
3 повтора с экспонентой, журнал доставок в интерфейсе.

## 4.12 Телеграм-бот

- `/start <token>` — привязка `telegram_chat_id` к пользователю (токен одноразовый, 15 минут).
- Кнопки под уведомлением: «Пройти», «Відкласти на день», «Не нагадувати про це».
- Бот не ведёт обучение внутри чата: всё открывается в вебе по ссылке с автологином
  (одноразовый токен, 10 минут, привязка к chat_id).
