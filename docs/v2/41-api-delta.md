# Lola LMS — ТЗ. 41. Дельта API: сводка эндпоинтов, ошибок и уведомлений

## 1. Назначение

Этот документ — **единственный сводный указатель** по API-поверхности, которую добавляет пакет
`lola-spec-v2` к базовому ТЗ Lola. Он сводит в один список всё, что разбросано по секциям 10 и 8
одиннадцати модульных документов (`28`–`38`) и по патчам (`39`), чтобы:

- исполнитель видел всю новую поверхность разом, а не собирал её из одиннадцати файлов;
- маршрутизатор, реестр скоупов, словарь i18n-ключей ошибок и реестр шаблонов уведомлений
  можно было заполнить из одного источника;
- коллизии (один код в двух значениях, один путь в двух документах, одно понятие под двумя
  именами) были видны до начала реализации, а не после.

**Статус документа — производный.** При расхождении между этим документом и модульным
документом-владельцем **правит модульный документ**: здесь указатель, там требование. Если
расхождение обнаружено — оно не исправляется тихо здесь, а выносится в §8 и чинится правкой
модульного документа с пометкой-исправлением (правило `39` «Назначение»).

Технические рамки не переопределяются. Всё, что ниже, работает по правилам
`lola-spec/docs/04-api.md` §4.1: префикс `/api/v1`, JSON UTF-8, ISO 8601 с таймзоной, ответ
`{data}` либо `{error:{code,message,details}}`, курсорная пагинация (`cursor`, `limit ≤ 100`),
zod-схемы из `shared/schemas`, `X-CSRF-Token` на мутациях сессионного клиента, идемпотентность
мутаций по `Idempotency-Key` с хранением ключа 24 часа, тенант берётся из сессии и никогда из
тела запроса, чужой тенант — **404, не 403**. Исключения из этих правил, которые вводит пакет,
перечислены поимённо в §5 — их одиннадцать, и других быть не должно.

---

## 2. Сводная таблица всех новых эндпоинтов

Скоуп указан по **модульному документу** (его секция 2), а не по `39` П-01: перечни расходятся,
см. §8.1. Пустой скоуп означает, что документ-владелец явного скоупа для этого пути не называет.

### 2.1 Рекрутинг: кандидаты — документ `28`

| Метод | Путь | Скоуп | Назначение |
|---|---|---|---|
| GET | `/candidates` | `candidate.view` | список кандидатов с фильтрами, `meta.limit_left` — остаток лимита тарифа |
| POST | `/candidates` | `candidate.edit` | создать кандидата вручную |
| GET | `/candidates/:id` | `candidate.view` | карточка кандидата |
| PATCH | `/candidates/:id` | `candidate.edit` | правка полей карточки |
| POST | `/candidates/:id/status` | `candidate.decide` | перевод по канбану, с причиной и флагом уведомления |
| POST | `/candidates/:id/scores` | `candidate.decide` | выставить одну из трёх независимых оценок (ручная / ТЗ / ШІ) |
| GET | `/candidates/:id/scores` | `candidate.view` | оценки, опционально с историей |
| POST | `/candidates/:id/assign` | `candidate.assign` | назначить рекрутинговый контент с параметрами |
| POST | `/candidates/:id/invite` | `candidate.assign` | отправить приглашение по выбранным каналам |
| POST | `/candidates/:id/hire` | `candidate.hire` | конвертация кандидата в сотрудника без повторного ввода данных |
| POST | `/candidates/:id/reject` | `candidate.decide` | отказ с причиной и опциональным письмом |
| POST | `/candidates/:id/archive` | `candidate.decide` | ручная архивация, освобождает место в лимите |
| POST | `/candidates/:id/reopen` | `candidate.edit` | вернуть из архива, если согласие не истекло |
| DELETE | `/candidates/:id` | `candidate.delete` | удаление с обязательной причиной |
| GET | `/candidates/:id/comments` | `candidate.view` | тред комментариев по кандидату |
| POST | `/candidates/:id/comments` | `candidate.view` | комментарий с областью видимости |
| POST | `/candidates/bulk/status` | `candidate.decide` | массовая смена статуса, ответ `{changed, skipped}` |
| GET | `/candidate-statuses` | `candidate.view` | справочник статусов: 6 системных + собственные |
| POST | `/candidate-statuses` | `candidate.status.manage` | создать свой статус поверх системных |
| PATCH | `/candidate-statuses/:id` | `candidate.status.manage` | правка статуса; системный не редактируется |
| DELETE | `/candidate-statuses/:id` | `candidate.status.manage` | удалить статус; системный и используемый не удаляются |
| GET | `/reports/recruiting-funnel` | `candidate.view` | агрегаты воронки найма |

**22 эндпоинта.**

### 2.2 Рекрутинг: вакансии (закрытый контур) — документ `29`

Публичный контур этого же документа вынесен в §3 и в общий счёт этой таблицы не входит.

| Метод | Путь | Скоуп | Назначение |
|---|---|---|---|
| GET | `/vacancies` | `vacancy.view` | список вакансий с фильтрами |
| POST | `/vacancies` | `vacancy.edit` | создать вакансию-черновик |
| GET | `/vacancies/:id` | `vacancy.view` | карточка с критериями и языками |
| PATCH | `/vacancies/:id` | `vacancy.edit` | правка вакансии |
| POST | `/vacancies/:id/publish` | `vacancy.publish` | выдать публичную ссылку, зафиксировать версию курса |
| POST | `/vacancies/:id/pause` | `vacancy.publish` | приостановить набор, ссылка начинает отдавать 410 |
| POST | `/vacancies/:id/close` | `vacancy.close` | закрыть с причиной, опционально снять с площадок |
| POST | `/vacancies/:id/archive` | `vacancy.close` | архивировать; блокируется при висящих откликах |
| POST | `/vacancies/:id/rotate-token` | `vacancy.publish` | новый `public_token`, старый умирает немедленно |
| GET | `/vacancies/:id/criteria` | `vacancy.view` | критерии оценки кандидата по этой вакансии |
| POST | `/vacancies/:id/criteria` | `vacancy.criteria.manage` | добавить критерий с весом и шкалой |
| PATCH | `/vacancies/:id/criteria/:cid` | `vacancy.criteria.manage` | правка критерия |
| DELETE | `/vacancies/:id/criteria/:cid` | `vacancy.criteria.manage` | удалить критерий |
| POST | `/vacancies/:id/criteria/generate` | `vacancy.ai.use` | черновик 3–8 критериев ИИ, 1 операция оси `ai_generate_ops` |
| POST | `/vacancies/:id/ai-text` | `vacancy.ai.use` | сгенерировать текстовый блок вакансии, возвращает `generation_id` |
| POST | `/vacancies/:id/ai-text/:gid/acknowledge` | `vacancy.ai.use` | «Текст перевірено» — снимает блокировку публикации |
| POST | `/candidates/:id/criterion-scores` | `candidate.decide` | оценки кандидата по критериям вакансии, сворачиваются в `candidate_scores` |
| GET | `/vacancy-templates` | `vacancy.view` | шаблоны вакансий |
| POST | `/vacancy-templates` | `vacancy.template.manage` | создать шаблон |
| POST | `/vacancy-templates/from-vacancy/:id` | `vacancy.template.manage` | шаблон из существующей вакансии |
| POST | `/vacancies/from-template/:tid` | `vacancy.edit` | вакансия-черновик из шаблона |
| GET | `/job-board-accounts` | `jobboard.connect` | аккаунты площадок, сгруппированные по владельцу |
| GET | `/job-board-accounts/:provider/auth-url` | `jobboard.connect` | ссылка OAuth-авторизации площадки |
| GET | `/job-board-accounts/:provider/callback` | — | приём OAuth-ответа площадки, отдаёт HTML-закрывашку |
| POST | `/job-board-accounts/:id/disconnect` | `jobboard.connect` | отключить аккаунт |
| GET | `/vacancies/:id/publications` | `vacancy.view` | журнал публикаций вакансии |
| POST | `/vacancies/:id/publications` | `jobboard.publish` | опубликовать на выбранные аккаунты, `confirm:true` обязателен |
| DELETE | `/vacancies/:id/publications/:pid` | `jobboard.publish` | снять объявление с площадки |
| POST | `/vacancies/:id/publications/:pid/link-external` | `jobboard.publish` | привязать `external_id` вручную после ответа без него |
| GET | `/vacancies/:id/applications` | `vacancy.view` | отклики по вкладкам состояния |
| POST | `/vacancies/:id/applications/:aid/accept` | `candidate.edit` | принять отклик → кандидат |
| POST | `/vacancies/:id/applications/:aid/reject` | `vacancy.view` | отклонить отклик |
| POST | `/vacancies/:id/applications/:aid/spam` | `vacancy.view` | пометить отклик спамом |

**33 эндпоинта** (+ 5 публичных, §3).

### 2.3 Рекрутинг: ИИ-собеседование и Підсумок — документ `30`

| Метод | Путь | Скоуп | Назначение |
|---|---|---|---|
| GET | `/interviews/:sessionId` | — (кандидат, по ссылке) | состояние сессии и текущая реплика |
| POST | `/interviews/:sessionId/consent` | — (кандидат) | согласие на запись либо выбор альтернативы |
| POST | `/interviews/:sessionId/start` | — (кандидат) | старт; **резервирует** 1 операцию оси `ai_interview_ops` |
| POST | `/interviews/:sessionId/turns/:ordinal/upload` | — (кандидат) | метаданные аудиоответа, файл идёт в S3 напрямую |
| POST | `/interviews/:sessionId/turns/:ordinal/answer` | — (кандидат) | ответ репликой, возвращает следующую |
| POST | `/interviews/:sessionId/finish` | — (кандидат) | завершить сессию |
| POST | `/interviews/:sessionId/withdraw` | — (кандидат) | отозвать согласие, записи удаляются |
| GET | `/candidates/:id/interview` | `interview.view` | сессия, критерии, расшифровка, флаги |
| GET | `/candidates/:id/interview/media/:turnId` | `interview.listen` | подписанная ссылка на аудио реплики |
| POST | `/candidates/:id/interview/criteria/:criterionId/override` | `interview.override` | человеческая оценка поверх оценки ШІ |
| POST | `/candidates/:id/interview/rescore` | `interview.override` | переоценка сессии с причиной |
| GET | `/candidate-summaries` | `summary.view` | список Підсумків |
| POST | `/candidate-summaries` | `summary.edit` | собрать Підсумок по итогам собеседования |
| PATCH | `/candidate-summaries/:id` | `summary.edit` | правка, переводит в `generated_by='ai_edited'` |
| POST | `/candidate-summaries/:id/send` | `summary.send` | отправить кандидату, выдаёт `share_token` |
| POST | `/candidate-summaries/:id/revoke` | `summary.send` | отозвать отправленный Підсумок |
| GET | `/public/candidate-summaries/:token` | — (без сессии) | Підсумок по ссылке, без ПД третьих лиц — **см. §8.4** |
| GET | `/review-hints/:targetKind/:targetId` | `ai.review.use` | подсказка проверяющему; проставляет `shown_at` |
| GET | `/interview-scenarios` | `interview.configure` | сценарии собеседования |
| GET | `/interview-scenarios/:id` | `interview.configure` | сценарий |
| PUT | `/interview-scenarios/:id` | `interview.configure` | правка сценария; альтернатива обязательна |
| GET | `/interview-scenarios/:id/criteria` | `interview.configure` | критерии сценария |
| POST | `/interview-scenarios/:id/criteria` | `interview.configure` | добавить критерий |
| POST | `/interview-scenarios/:id/criteria/generate` | `interview.configure` | предложить критерии ИИ, `source='ai_suggested'` |
| GET | `/ai/calls` | `ai.audit` | журнал вызовов модели: стоимость, токены, задержка |
| GET | `/ai/providers` | `ai.audit` | профили провайдеров |
| GET | `/ai/providers/:id` | `ai.audit` | профиль провайдера |
| PUT | `/ai/providers/:id` | `ai.audit` | правка профиля; `provider_retention='unknown'` не допускается |
| GET | `/ai/quality-reviews` | `ai.audit` | перепроверки качества модели |
| GET | `/ai/quality-reviews/:id` | `ai.audit` | перепроверка |
| POST | `/ai/quality-reviews` | `ai.audit` | вердикт по выборке |

**31 эндпоинт.**

### 2.4 Библиотека переиспользуемых модулей — документ `31`

| Метод | Путь | Скоуп | Назначение |
|---|---|---|---|
| GET | `/library/modules` | `library.view` | каталог модулей с `usageCount`, фильтрами `onlyUnused` / `onlyStale` |
| POST | `/library/modules` | `library.publish` | создать карточку модуля (`draft`) |
| GET | `/library/modules/:id` | `library.view` | карточка + текущая версия + число мест использования |
| PATCH | `/library/modules/:id` | `library.publish` | правка карточки |
| DELETE | `/library/modules/:id` | `library.manage` | удалить; блокируется при использовании, ответ несёт `details.usages[]` |
| POST | `/library/modules/:id/archive` | `library.publish` | архивировать с причиной |
| POST | `/library/modules/:id/restore` | `library.publish` | вернуть из архива |
| POST | `/library/modules/:id/duplicate` | `library.publish` | копия модуля |
| GET | `/library/modules/:id/versions` | `library.view` | история версий |
| POST | `/library/modules/:id/versions` | `library.publish` | новая версия с `changelog`, флагами `isHotfix` / `notify` |
| GET | `/library/modules/:id/versions/:from/diff/:to` | `library.view` | разница двух версий по `block.id` |
| GET | `/library/modules/:id/usages` | `library.view` | где модуль используется |
| POST | `/library/usages` | `library.use` | подключить модуль к треку или курсу с режимом закрепления версии |
| POST | `/library/usages/:id/update-version` | `library.use` | перевести место использования на другую версию |
| POST | `/library/usages/:id/detach` | `library.use` | отвязать, опционально сделав локальную копию |
| POST | `/library/modules/:id/update-all-usages` | `library.manage` | массовый перевод всех мест на версию |
| GET | `/library/proposals` | `library.view` | предложения добавить урок в библиотеку |
| POST | `/library/proposals` | `library.use` | подать предложение |
| POST | `/library/proposals/:id/accept` | `library.publish` | принять, создаёт карточку модуля |
| POST | `/library/proposals/:id/reject` | `library.publish` | отклонить с обязательным комментарием |

**20 эндпоинтов.**

### 2.5 Оргструктура — документ `32`

| Метод | Путь | Скоуп | Назначение |
|---|---|---|---|
| GET | `/org-structure/tree` | `org.structure.view` | дерево: режим витрины либо конструктора |
| POST | `/org-structure/nodes` | `org.structure.edit` | создать узел |
| GET | `/org-structure/nodes/:id` | `org.structure.view` | узел, держатели, путь до корня |
| PUT | `/org-structure/nodes/:id` | `org.structure.edit` | правка узла |
| POST | `/org-structure/nodes/:id/move` | `org.structure.edit` | перенос ветки с защитой от цикла и переполнения глубины |
| POST | `/org-structure/nodes/:id/archive` | `org.structure.edit` | архивировать узел |
| POST | `/org-structure/nodes/:id/restore` | `org.structure.edit` | вернуть узел |
| POST | `/org-structure/nodes/:id/assignments` | `org.structure.edit` | привязать человека к узлу |
| DELETE | `/org-structure/assignments/:id` | `org.structure.edit` | снять привязку с причиной |
| GET | `/org-structure/manager/:userId` | `org.structure.view` | `resolveManager()`: руководитель, источник, цепочка |
| GET | `/org-structure/subordinates/:userId` | `org.structure.view` | подчинённые, опционально вся ветка |
| GET | `/org-structure/snapshots` | `org.structure.import` | снимки структуры |
| POST | `/org-structure/snapshots` | `org.structure.import` | снять именованный снимок |
| POST | `/org-structure/snapshots/:id/rollback` | `org.structure.import` | откат к снимку, отдаёт `job_id` |
| POST | `/org-structure/import` | `org.structure.import` | CSV с маппингом колонок |
| GET | `/org-structure/export` | `org.structure.import` | выгрузка CSV в формате импорта |
| GET | `/org-structure/conflicts` | `org.structure.view` | протокол конфликтов структуры |
| POST | `/org-structure/conflicts/:id/resolve` | `org.structure.edit` | закрыть конфликт |

**18 эндпоинтов.**

### 2.6 Жизненный цикл сотрудника и офбординг — документ `33`

| Метод | Путь | Скоуп | Назначение |
|---|---|---|---|
| GET | `/lifecycle/stages` | `lifecycle.view` | справочник этапов с набором возможностей каждого |
| PATCH | `/lifecycle/stages/:id` | `lifecycle.manage` | правка этапа; набор возможностей только для чтения |
| GET | `/lifecycle/state/:userId` | `lifecycle.view` | текущий этап человека и история переходов |
| POST | `/lifecycle/state/:userId` | `lifecycle.manage` | ручной перевод на этап с причиной |
| PATCH | `/courses/:id/stage` | `lifecycle.manage` | привязать курс к этапу |
| GET | `/offboarding` | `offboarding.start` | список случаев увольнения |
| POST | `/offboarding` | `offboarding.start` | запустить офбординг |
| GET | `/offboarding/:id` | `offboarding.start` | карточка случая с чек-листом передачи дел |
| POST | `/offboarding/:id/complete` | `offboarding.complete` | завершить, закрыть доступ |
| POST | `/offboarding/:id/cancel` | `offboarding.complete` | отменить с причиной |
| GET | `/reports/lifecycle` | `lifecycle.view` | люди по этапам и скорость прохождения |
| GET | `/reports/offboarding` | `offboarding.start` | причины и сроки увольнений |

**12 эндпоинтов.**

### 2.7 Хранилище — документ `34`

| Метод | Путь | Скоуп | Назначение |
|---|---|---|---|
| GET | `/storage/summary` | `storage.view` | занято / лимит / grace, разбивка, `driftBytes` |
| GET | `/storage/files` | `storage.view` | файлы с фильтрами — **см. §8.3** |
| GET | `/storage/trash` | `storage.view` | корзина |
| GET | `/storage/pending-uploads` | `storage.view` | отложенные загрузки с устройств |
| GET | `/storage/files/:id` | `storage.view` | карточка файла со ссылкой на источник |
| GET | `/storage/files/:id/download` | `storage.view` | 302 на подписанную ссылку, 5 минут |
| POST | `/storage/upload-intent` | — (любой загружающий) | намерение загрузить: `{uploadUrl}` либо `{deferred:true}` |
| DELETE | `/storage/files/:id` | `storage.delete` | мягкое удаление в корзину — **см. §8.3** |
| POST | `/storage/files/:id/restore` | `storage.delete` | вернуть из корзины |
| POST | `/storage/deletions` | `storage.delete` | заявка на массовое удаление, считает `evidenceCount` |
| POST | `/storage/deletions/:id/confirm` | `storage.delete` | подтверждение фразой |
| POST | `/storage/deletions/:id/cancel` | `storage.delete` | отмена заявки |
| GET | `/storage/retention-policies` | `storage.policy` | политики хранения по происхождению файла |
| PUT | `/storage/retention-policies` | `storage.policy` | сохранить политики |
| POST | `/storage/retention-policies/dry-run` | `storage.policy` | сухой прогон: сколько файлов и байт затронет — **метод в `34` §10 не указан явно, §8.5** |
| GET | `/storage/addons` | `storage.addon` | доступные и активные аддоны объёма |
| POST | `/storage/addons` | `storage.addon` | подключить аддон, отдаёт `checkoutUrl` |
| GET | `/reports/storage` | `storage.view` | отчёт по файлам, при большом объёме — `{jobId}` |

**18 эндпоинтов.**

### 2.8 Тариф, лимиты и платежи — документ `35`

| Метод | Путь | Скоуп | Назначение |
|---|---|---|---|
| GET | `/billing/summary` | `billing.view` | план, период, даты, ИИ-блок, аддоны |
| GET | `/billing/usage` | `billing.usage.view` | по каждой оси: `used`, `limit`, `pct`, источник, дата сбора |
| GET | `/billing/plans` | `billing.view` | публичные планы с ценами обоих периодов |
| POST | `/billing/plan-change/preflight` | `billing.manage` | проверка перед сменой: `{allowed, blockers[]}` |
| POST | `/billing/plan-change` | `billing.manage` | заявка на смену тарифа |
| DELETE | `/billing/plan-change/:id` | `billing.manage` | отменить заявку, пока не применена |
| GET | `/billing/addons` | `billing.view` | аддоны тенанта |
| POST | `/billing/addons` | `billing.manage` | подключить аддон |
| GET | `/billing/payments` | `billing.payments.view` | история платежей |
| GET | `/billing/notices` | `billing.view` | активные баннеры лимитов |
| POST | `/billing/notices/:id/dismiss` | `billing.view` | закрыть баннер; при `level=exceeded` запрещено |
| GET | `/storage/files` | `storage.manage` | дублирует `34` — **коллизия, §8.3** |
| DELETE | `/storage/files` | `storage.manage` | массовое удаление `{ids[]}` — **коллизия, §8.3** |
| GET | `/platform/plans/:id` | `platform.plans.manage` | тарифная сетка |
| PUT | `/platform/plans/:id` | `platform.plans.manage` | правка сетки и цен |
| GET | `/platform/tenants/:id/limits` | `platform.limits.override` | переопределения лимитов тенанта |
| PUT | `/platform/tenants/:id/limits` | `platform.limits.override` | задать переопределения, причина обязательна |
| POST | `/platform/tenants/:id/extend` | `platform.plans.manage` | продлить оплаченный период |
| POST | `/platform/tenants/:id/ai` | `platform.ai.grant` | продлить ИИ-подписку, выдать пакет операций |
| POST | `/platform/tenants/:id/payments` | `platform.payments.manage` | отметить платёж принятым вручную |

**20 эндпоинтов.** Пять последних — под префиксом `/api/v1/platform` (`04-api.md` §4.17),
администратору тенанта недоступны даже на чтение.

### 2.9 Обратная связь по качеству контента — документ `36`

| Метод | Путь | Скоуп | Назначение |
|---|---|---|---|
| POST | `/content-issues/reports` | `content_issue.report` | пожаловаться на материал или вопрос; ответ несёт `merged` |
| GET | `/content-issues` | `content_issue.view` | очередь карточек с фильтрами |
| GET | `/content-issues/:id` | `content_issue.view` | карточка с заявителями и журналом |
| PATCH | `/content-issues/:id` | `content_issue.triage` | статус, резолюция, важность, срок |
| POST | `/content-issues/:id/assign` | `content_issue.assign` | назначить ответственного |
| POST | `/content-issues/:id/comment` | `content_issue.view` | комментарий, опционально внутренний |
| GET | `/content-issues/:id/rescore-preview` | `content_issue.rescore` | сколько попыток изменится до применения |
| POST | `/content-issues/:id/rescore` | `content_issue.rescore` | пересчёт или аннулирование вопроса |
| GET | `/me/content-reports` | — (свои) | свои жалобы со статусами |
| GET | `/settings/content-issue-routing-rules` | `content_issue.triage` | правила маршрутизации жалоб |
| POST | `/settings/content-issue-routing-rules` | `content_issue.triage` | создать правило; правило-фолбэк обязательно |
| PATCH | `/settings/content-issue-routing-rules/:id` | `content_issue.triage` | правка правила |
| DELETE | `/settings/content-issue-routing-rules/:id` | `content_issue.triage` | удалить правило |
| POST | `/content-reporters/:userId/mute` | `content_issue.mute` | приостановить приём жалоб от человека |
| POST | `/content-reporters/:userId/unmute` | `content_issue.mute` | снять приостановку |
| GET | `/reports/content-quality` | `content_issue.view` | отчёт «Якість контенту» |

**16 эндпоинтов.** Четыре строки `/settings/content-issue-routing-rules` развёрнуты из записи
`CRUD` документа-владельца; методы и путь элемента там явно не названы (§8.5).

### 2.10 Проверка, делегирование и учёт времени — документ `37`

| Метод | Путь | Скоуп | Назначение |
|---|---|---|---|
| GET | `/review/queue` | — (проверяющий) | единая очередь, четыре таба, фильтры по филиалу, треку, типу субъекта |
| POST | `/review/items/:id/delegate` | `review.delegate` | передать проверку другому со сроком и причиной |
| POST | `/review/delegations/:id/revoke` | `review.delegate` | отозвать делегирование |
| POST | `/review/items/bulk-delegate` | `review.delegate` | делегировать до 25 работ разом |
| POST | `/review/items/:id/reassign` | `review.delegate.any` | переназначить чужую работу |
| GET | `/review/workload` | `review.workload.view` | загрузка проверяющих по филиалам и узлам |
| POST | `/review/absences` | `review.absence.manage` | отсутствие проверяющего с заместителем и перебросом очереди |
| DELETE | `/review/absences/:id` | `review.absence.manage` | снять отсутствие |
| GET | `/review/routing-rules` | `review.routing.manage` | правила автоназначения проверок |
| POST | `/review/routing-rules` | `review.routing.manage` | создать правило |
| PATCH | `/review/routing-rules/:id` | `review.routing.manage` | правка правила |
| DELETE | `/review/routing-rules/:id` | `review.routing.manage` | удалить правило |
| POST | `/learning/time/beat` | — (учащийся) | одно биение счётчика времени, идемпотентно по `(session_key, seq)` |
| POST | `/learning/time/beats` | — (учащийся) | пакет до 200 биений, накопленных офлайн |
| GET | `/learning/time/totals` | `time.metrics.view` | суммарное время по субъекту |
| GET | `/content/time-norms/:subjectType/:subjectId` | `time.metrics.view` | норма времени на материал и её источник |
| PUT | `/content/time-norms/:subjectType/:subjectId` | `time.metrics.view` | задать норму вручную |
| POST | `/content/time-norms/:subjectType/:subjectId/apply-observed` | `time.metrics.view` | принять наблюдённую медиану как норму |
| GET | `/reports/reviewers` | `time.metrics.view` | «Робота перевіряючих» |
| GET | `/reports/time-plan-fact` | `time.metrics.view` | «План і факт часу», обезличенный |
| GET | `/reports/delegations` | `review.workload.view` | журнал делегирований |

**21 эндпоинт.** Четыре строки `/review/routing-rules` развёрнуты из записи `CRUD` (§8.5).

### 2.11 Карточка человека: расширения — документ `38`

| Метод | Путь | Скоуп | Назначение |
|---|---|---|---|
| GET | `/people/:id/activity` | `person.activity.view_others` | лента активности за год: дни, события, уровни |
| GET | `/people/:id/rating` | `person.rating.view_others` | индекс залученості с расшифровкой слагаемых |
| POST | `/people/:id/rating/recalc` | `person.rating.view_others` | пересчёт, не чаще раза в час |
| GET | `/people/:id/notes` | `person.note.read` | заметки — **пишет в `audit_log`, §5.1** |
| POST | `/people/:id/notes` | `person.note.write` | заметка с областью видимости и категорией |
| PATCH | `/people/:id/notes/:noteId` | `person.note.write` | правка; сужение видимости запрещено |
| DELETE | `/people/:id/notes/:noteId` | `person.note.write` | удалить заметку |
| GET | `/people/:id/documents` | `person.document.view_others` | документы человека со сроками годности |
| POST | `/people/:id/documents` | `person.document.manage` | добавить документ |
| PATCH | `/people/:id/documents/:docId` | `person.document.manage` | правка срока, статуса, примечания |
| DELETE | `/people/:id/documents/:docId` | `person.document.manage` | удалить; доказательство удалить нельзя |
| GET | `/person-document-types` | `person.document.view_others` | справочник типов документов |
| POST | `/person-document-types` | `person.document.manage` | создать тип |
| PATCH | `/person-document-types/:id` | `person.document.manage` | правка; деактивация используемого блокируется |
| DELETE | `/person-document-types/:id` | `person.document.manage` | удалить тип |
| GET | `/people/:id/absences` | `person.absence.manage` | нормы, использовано, остаток, записи за год |
| PUT | `/absence-norms` | `person.absence.manage` | норма на тенант или филиал с обязательной причиной |
| POST | `/people/:id/absences` | `person.absence.manage` | запись отсутствия |
| PATCH | `/people/:id/absences/:id` | `person.absence.manage` | правка записи отсутствия |
| GET | `/reports/documents` | `person.document.view_others` | «Документи співробітників» |
| GET | `/reports/absences` | `person.absence.manage` | «Норми і залишки відсутностей» |
| GET | `/reports/activity` | `person.activity.view_others` | «Навчальна активність» |
| GET | `/reports/rating` | `person.rating.view_others` | «Індекс залученості», выгрузка только по явной галке |

**23 эндпоинта.** Четыре строки `/person-document-types` развёрнуты из записи `CRUD` (§8.5).

### 2.12 Итог

| Подсистема | Документ | Эндпоинтов |
|---|---|---|
| Кандидаты | `28` | 22 |
| Вакансии (закрытый контур) | `29` | 33 |
| ИИ-собеседование и Підсумок | `30` | 31 |
| Библиотека модулей | `31` | 20 |
| Оргструктура | `32` | 18 |
| Жизненный цикл и офбординг | `33` | 12 |
| Хранилище | `34` | 18 |
| Тариф, лимиты, платежи | `35` | 20 |
| Обратная связь по контенту | `36` | 16 |
| Проверка, делегирование, время | `37` | 21 |
| Карточка человека: расширения | `38` | 23 |
| **Итого закрытый контур `/api/v1`** | | **234** |
| Публичный контур `/api/public/v1` | `29` | 5 |
| **Итого новых эндпоинтов в пакете** | | **239** |

Оговорка к счёту: строки вида `CRUD /review/routing-rules` и `GET/PUT /interview-scenarios[/:id]`
в документах-владельцах свёрнуты, и точное число методов из них выводится, а не читается. Здесь
`CRUD` развёрнут как четыре метода (GET списка, POST, PATCH элемента, DELETE элемента), а
`[/:id]` — как список и элемент. Если исполнитель развернёт иначе, итог сдвинется на единицы;
на состав поверхности это не влияет. Места, где свёртка неоднозначна, перечислены в §8.5.

---

## 3. Публичный контур `/api/public/v1`

Это **единственная часть продукта, куда приходит запрос без сессии**. Она целиком принадлежит
документу `29` (публичная страница вакансии и форма отклика) и обязана быть видна в базовом
`04-api.md` (патч `39` П-04), а не только в модульном документе.

### 3.1 Полный список публичных эндпоинтов

| Метод | Путь | Вход | Успех | Отказы |
|---|---|---|---|---|
| GET | `/j/:token` | — | `200` карточка вакансии + `form_nonce` | `404 vacancy.not_found`, `410 vacancy.paused`, `429 rate.too_many` |
| POST | `/j/:token/apply` | `{full_name, phone?, email?, comment?, consent, form_nonce, website}` | `202 {application_id, otp_required}` | `422 consent.required`, `422 contact.required`, `429 rate.too_many`, `410 vacancy.paused` |
| POST | `/j/:token/apply/:aid/confirm` | `{code}` | `200 {status:"accepted"}` | `400 otp.invalid`, `429 otp.too_many` |
| POST | `/j/:token/apply/:aid/resume` | multipart | `200 {asset_id}` | `413 file.too_large`, `415 file.type` |
| POST | `/j/:token/subscribe` | `{email}` | `202` | `429 rate.too_many` |

Пять эндпоинтов, из них один на чтение. **Операций чтения списков в публичном контуре нет и не
появится** — это правило контура, а не свойство текущего набора.

### 3.2 Как определяется тенант в отсутствие сессии

`tenant_id` выводится из `public_token` вакансии — 22 знака base62 из криптоисточника, ≈132 бита,
уникальный в пределах платформы (`29` §3.2, индекс `uq_vacancies_public_token`). Дальше запрос
идёт через обычный `withTenant()` с **системной ролью минимальных прав** (`39` П-25.3): весь
остальной конвейер, включая RLS `enable` + `force`, работает как для сессионного запроса. Тело
запроса `tenant_id` не содержит и не может содержать — правило `04-api.md` §4.1 здесь не
ослаблено, просто источник тенанта другой.

Токен компрометируется ротацией: `POST /vacancies/:id/rotate-token` выдаёт новый, старый умирает
немедленно (`29` §7.8). Это единственный способ отозвать публичный доступ, не закрывая вакансию.

### 3.3 Ограничения частоты

Свои, отдельные от `api_rate_rpm` тенанта, и свой лог — таблица `public_apply_attempts`
(`29` §3.9, §7.4):

| Что ограничивается | Порог | Окно | При превышении |
|---|---|---|---|
| Успешные отклики с одного `ip_hash` | 3 | 1 час, на тенант | строка `public_apply_attempts` с `outcome='submit_blocked'` |
| Успешные отклики с одного `ip_hash` | 10 | 24 часа | то же |
| Отклики с одного `ip_hash` на одну вакансию | 1 | 24 часа | то же |
| Просмотры публичной страницы | 30 | 10 минут | `429` с `Retry-After: 600` |
| Отправок кода на один контакт | 3 | 1 час | `429 otp.too_many` |
| Попыток ввода кода | 5 | на код, TTL 10 минут | `400 otp.invalid` |
| Суточный потолок откликов по вакансии | `apply_daily_cap`, по умолчанию 200 | сутки | `429`, «Забагато відгуків сьогодні» |

При всплеске (более 20 заблокированных попыток по вакансии за час) пороги для этой вакансии
ужесточаются вдвое на 6 часов, уходит уведомление `vacancy.spam_burst` (`29` §7.8).

Капчи внешнего вендора нет и не будет: её заменяют подтверждение владения контактом кодом,
honeypot-поле `website`, подписанный `form_nonce` с окном 4 с – 60 мин и балл `spam_score`
(`29` §7.5–7.7). Обоснование в `29` §7.5 — внешняя капча на странице сбора ПД означает передачу
поведения посетителей третьей стороне.

### 3.4 Коды ответа и заголовки

- `200` — страница отдана; SSR, кеш 60 секунд, CSP без сторонних скриптов, индексация разрешена.
- `202` — отклик принят. **Возвращается при провале любой проверки, кроме проверки состояния
  вакансии**: суточный потолок, частота по IP, `form_nonce`, honeypot, согласие, наличие контакта,
  лимит `candidates_active` — всё даёт один и тот же `202` с текстом благодарности (`29` §7.3).
  Форма никогда не сообщает, какая проверка сработала.
- `410` — набор приостановлен (`paused`), с блоком «Повідомити, коли відкриється».
- `404` — закрытая, архивная и несуществующая вакансия, **единый ответ с выровненным временем**
  (задержка 120 мс ± 20 мс, `29` §7.2), чтобы перебор токенов не давал информации.
- `429` — превышен любой из порогов §3.3; заголовок `Retry-After` обязателен (для просмотров
  страницы — `600`).
- `413` / `415` — резюме больше допустимого размера / недопустимый тип файла.
- Тело ошибки — общий формат `{error:{code,message,details}}`; `details` в публичном контуре
  **не несёт диагностики**, по которой можно понять сработавшую проверку.

### 3.5 Что никогда не отдаётся наружу

Список закрытый, из `29` §5.6. Публичная страница и любой публичный эндпоинт **никогда** не
возвращают:

1. внутреннюю категорию вакансии;
2. курс отбора и его название;
3. рекрутера и его контакты;
4. точку и подразделение во внутренних терминах — только город;
5. критерии оценки кандидата;
6. параметры назначения;
7. число откликов по вакансии;
8. бюджет размещения (`source_budget`);
9. данные других кандидатов;
10. вилку зарплаты при `salary_visible = false`.

К ним добавляются три правила того же свойства, выведенные из других мест документа `29`:

11. **Причина отказа в приёме отклика** — ни в коде ответа, ни в тексте, ни в `details` (§7.3).
12. **Факт, что откликнулся действующий сотрудник** — человек видит обычную благодарность,
    событие уходит только рекрутеру и HR (`29` §12.6).
13. **Факт, что отклик не создал кандидата из-за исчерпанного лимита тарифа** — снаружи это
    неотличимо от успеха (`29` §12.2).

Отдельно: `vacancy_applications` — сырые данные из публичного интернета, и до подтверждения
контакта кодом они не попадают ни в воронку, ни в лимит `candidates_active` (`29` §3.9).
Неподтверждённый отклик через 24 часа переходит в `expired`, временное резюме удаляется.

---

## 4. Реестр кодов ошибок

Колонка «текст» — строка для интерфейса на украинском, идущая в i18n. Где документ-владелец даёт
текст дословно, он взят как есть; остальные сформулированы здесь по правилу AUTHORS.md
(«тексты ошибок сразу на украинском») и при расхождении правятся модульным документом.

Общие коды базового `04-api.md` §4.1 (`validation_failed`, `auth_required`, `forbidden`,
`not_found`, `conflict`, `rate_limited`, `internal`) в реестр не включены — пакет их не меняет,
кроме двух случаев, вынесенных в §8.2.

### 4.1 Кандидаты — `28`

| Код | HTTP | Когда | Текст (uk) |
|---|---|---|---|
| `candidate.contact_required` | 400 | ни телефона, ни e-mail | «Вкажіть телефон або e-mail» |
| `candidate.duplicate` | 409 | контакт уже есть у кандидата этого тенанта | «Такий кандидат уже існує» |
| `limit.candidates_exceeded` | 409 | исчерпан лимит `candidates_active` | «Вичерпано ліміт кандидатів за тарифом» |
| `limit.users_exceeded` | 409 | найм упирается в лимит `users_active` | «Вичерпано ліміт співробітників за тарифом» |
| `status.same` | 409 | перевод в тот же статус | «Кандидат уже в цьому статусі» |
| `assignment.exists` | 409 | этот контент уже назначен кандидату | «Матеріал уже призначено» |
| `invite.too_often` | 429 | приглашение отправлялось только что | «Запрошення вже надіслано. Спробуйте пізніше» |
| `contact.missing` | 422 | нет контакта для выбранного канала | «Немає контакту для цього каналу» |
| `candidate.not_active` | 409 | решение по неактивному кандидату | «Кандидат уже не в активному відборі» |
| `reason.required` | 422 | причина отказа не указана | «Вкажіть причину» |
| `consent.expired` | 409 | возврат из архива после истечения согласия | «Строк згоди на обробку даних минув. Кандидата не можна відновити» |
| `candidate.hired` | 409 | удаление нанятого кандидата | «Кандидата найнято. Видалення неможливе» |
| `code.exists` | 409 | код статуса занят | «Статус із таким кодом уже є» |
| `maps_to.required` | 422 | свой статус без привязки к системному | «Оберіть системний статус, якому відповідає новий» |
| `status.system` | 403 | правка или удаление системного статуса | «Системний статус не можна змінити» |
| `candidate_status.in_use` | 409 | удаление статуса, в котором есть кандидаты | «Статус використовується. Спочатку перемістіть кандидатів» |

### 4.2 Вакансии, закрытый контур — `29`

| Код | HTTP | Когда | Текст (uk) |
|---|---|---|---|
| `vacancy.link_requirements` | 422 | публикация без курса или точки | «Оберіть курс і точку, щоб створити посилання на автоматичний відбір» |
| `vacancy.ai_text_unreviewed` | 409 | есть AI-блок без правки и без подтверждения | «Перевірте згенерований текст перед публікацією: <перелік блоків>» |
| `vacancy.not_published` | 409 | пауза или ротация токена у неопубликованной | «Вакансію ще не опубліковано» |
| `vacancy.has_pending_applications` | 409 | архивация при висящих откликах | «Є необроблені відгуки. Спочатку закрийте їх» |
| `limit.ai_ops_exceeded` | 409 | исчерпана ось `ai_generate_ops` | «Ліміт ШІ-операцій вичерпано» |
| `ai.unavailable` | 503 | провайдер не отвечает | «Сервіс ШІ тимчасово недоступний. Спробуйте пізніше» |
| `criterion.out_of_scale` | 422 | оценка вне границ шкалы критерия | «Оцінка виходить за межі шкали» |
| `template.name_exists` | 409 | имя шаблона занято | «Шаблон із такою назвою вже є» |
| `jobboard.owner_forbidden` | 403 | подключение аккаунта чужого владельца | «Ви не можете підключати акаунт від імені іншого користувача» |
| `oauth.state_invalid` | 400 | `state` не совпал при возврате с площадки | «Авторизацію не завершено. Почніть заново» |
| `publication.duplicate` | 409 | вакансия уже опубликована в этот аккаунт | «Вакансію вже опубліковано в цьому акаунті» |
| `jobboard.account_revoked` | 409 | площадка отозвала токен | «Акаунт майданчика більше не авторизований. Підключіть його заново» |
| `publication.confirm_required` | 422 | публикация без `confirm:true` | «Підтвердьте публікацію: дані вакансії підуть на зовнішній майданчик» |
| `publication.not_active` | 409 | снятие неактивной публикации | «Публікація вже неактивна» |
| `publication.not_conflict` | 409 | ручная привязка `external_id` не в состоянии `conflict` | «Публікація не потребує ручної прив'язки» |

### 4.3 Вакансии, публичный контур — `29` §10

| Код | HTTP | Когда | Текст (uk) |
|---|---|---|---|
| `vacancy.not_found` | 404 | закрытая, архивная или несуществующая вакансия | «Вакансію не знайдено або її вже закрито» |
| `vacancy.paused` | 410 | набор приостановлен | «Набір тимчасово призупинено» |
| `rate.too_many` | 429 | превышен любой порог §3.3 | «Забагато відгуків сьогодні. Спробуйте, будь ласка, завтра» |
| `consent.required` | 422 | галка согласия не отмечена | «Потрібна згода на обробку даних» |
| `contact.required` | 422 | ни телефона, ни e-mail в публичной форме | «Вкажіть телефон або e-mail» |
| `otp.invalid` | 400 | неверный или истёкший код | «Невірний код. Спробуйте ще раз» |
| `otp.too_many` | 429 | превышено число отправок или попыток | «Забагато спроб. Спробуйте пізніше» |
| `file.too_large` | 413 | резюме больше допустимого | «Файл завеликий» |
| `file.type` | 415 | недопустимый тип файла резюме | «Такий тип файлу не підтримується» |

### 4.4 ИИ-собеседование и Підсумок — `30`

| Код | HTTP | Когда | Текст (uk) |
|---|---|---|---|
| `consent.required` | **409** | действие до получения согласия на запись — **коллизия, §8.2** | «Спочатку потрібна згода на запис» |
| `consent.invalid` | 422 | решение не разобрано или версия текста не та | «Згоду не збережено. Оновіть сторінку» |
| `already_decided` | 409 | повторное решение по согласию | «Рішення вже прийнято» |
| `limit.ai_interview_exhausted` | 409 | исчерпана ось `ai_interview_ops` | «Ліміт ШІ-співбесід вичерпано» |
| `limit.ai_generate_exhausted` | 409 | исчерпана ось `ai_generate_ops` при генерации критериев | «Ліміт ШІ-операцій вичерпано» |
| `file.too_large` | 413 | аудиоответ больше 25 МБ | «Файл завеликий» |
| `turn.closed` | 422 | загрузка в закрытую реплику | «Цю відповідь уже завершено» |
| `answer.empty` | 422 | пустой ответ | «Відповідь порожня» |
| `retake.limit` | 409 | превышено число перезаписей реплики | «Вичерпано спроби перезапису» |
| `no_answers` | 409 | завершение сессии без ответов | «Немає жодної відповіді» |
| `scope` | 403 | нет скоупа на просмотр собеседования — **см. §8.2** | «Немає доступу» |
| `interview.listen` | 403 | нет скоупа на прослушивание аудио | «Немає доступу до аудіозапису» |
| `media.purged` | 410 | аудио удалено по сроку хранения | «Аудіозапис уже видалено за строком зберігання» |
| `session.not_scored` | 409 | правка оценки до появления оценки ШІ | «Оцінку ще не сформовано» |
| `limit` | 409 | переоценка при исчерпанном лимите — **код неполон, §8.5** | «Ліміт вичерпано» |
| `summary.no_data` | 409 | Підсумок не из чего собрать | «Недостатньо даних для підсумку» |
| `summary.sent` | 409 | правка уже отправленного Підсумку | «Підсумок уже надіслано. Редагування неможливе» |
| `contact.missing` | 422 | нет контакта для отправки Підсумку | «Немає контакту для надсилання» |
| `consent.withdrawn` | 409 | отправка после отзыва согласия | «Кандидат відкликав згоду» |
| `expired` | 410 | ссылка на Підсумок истекла — **код неполон, §8.5** | «Строк дії посилання минув» |
| `hint.absent` | 404 | подсказки для этой работы нет | «Підказки немає» |
| `hint.degraded` | 409 | подсказки отключены из-за деградации качества | «Підказки тимчасово недоступні» |
| `scenario.alternative_required` | 422 | сценарий без альтернативы ИИ-собеседованию | «Вкажіть альтернативу для тих, хто відмовиться від ШІ» |
| `criteria.required` | 422 | сценарий без критериев | «Додайте хоча б один критерій» |
| `ai.audit` | 403 | нет скоупа на журнал ИИ | «Немає доступу до журналу ШІ» |
| `provider.retention_unknown` | 422 | провайдер с неизвестным сроком хранения на расшифровку | «Провайдер із невідомим строком зберігання не допускається для розшифровки» |

### 4.5 Библиотека модулей — `31`

| Код | HTTP | Когда | Текст (uk) |
|---|---|---|---|
| `library.forbidden` | 403 | нет доступа к библиотеке | «Немає доступу до бібліотеки» |
| `library.not_author` | 403 | правка чужого модуля | «Редагувати може лише автор модуля» |
| `library.manage_required` | 403 | массовое обновление без `library.manage` | «Потрібні права керування бібліотекою» |
| `container.forbidden` | 403 | подключение модуля к чужому контейнеру | «Немає доступу до цього треку» |
| `slug_taken` | 409 | код модуля занят | «Модуль із таким кодом уже є» |
| `module_archived` | 409 | действие над архивным модулем | «Модуль заархівовано» |
| `module_deleted` | 409 | восстановление удалённого | «Модуль видалено, відновлення неможливе» |
| `library_module.in_use` | 409 | удаление используемого модуля | «Модуль використовується у {n} місцях» |
| `version_conflict` | 409 | параллельная публикация версии | «Версію вже оновлено. Оновіть сторінку» |
| `already_attached` | 409 | модуль уже подключён к этому месту | «Модуль уже підключено» |
| `already_latest` | 409 | перевод на текущую версию | «Це вже остання версія» |
| `proposal_pending` | 409 | предложение по этому уроку уже на рассмотрении | «Пропозицію вже подано» |
| `already_decided` | 409 | повторное решение по предложению — **коллизия, §8.2** | «Рішення вже прийнято» |
| `reason_required` | 422 | архивация без причины | «Вкажіть причину» |
| `changelog_required` | 422 | версия без описания изменений | «Опишіть, що змінилося» |
| `empty_body` | 422 | версия с пустым телом | «Модуль не може бути порожнім» |
| `same_version` | 422 | сравнение версии с собой | «Оберіть дві різні версії» |
| `version_retired` | 422 | перевод на списанную версию | «Ця версія більше не підтримується» |
| `comment_required` | 422 | отклонение предложения без комментария | «Поясніть, чому пропозицію відхилено» |

### 4.6 Оргструктура — `32`

| Код | HTTP | Когда | Текст (uk) |
|---|---|---|---|
| `forbidden` | 403 | нет скоупа — **см. §8.2** | «Немає доступу» |
| `depth_exceeded` | 409 | превышена предельная глубина дерева | «Перевищено максимальну глибину структури» |
| `node_archived` | 409 | действие над архивным узлом | «Вузол заархівовано» |
| `cycle_detected` | 409 | перенос узла в собственного потомка | «Вузол не можна перенести в його власну гілку» |
| `stale_tree` | 409 | дерево изменилось между чтением и переносом | «Структуру вже змінено. Оновіть сторінку» |
| `has_children` | 409 | архивация узла с потомками | «У вузла є підлеглі вузли» |
| `has_holders` | 409 | архивация узла с держателями | «До вузла прив'язані люди» |
| `parent_archived` | 409 | восстановление узла под архивным родителем | «Батьківський вузол заархівовано» |
| `primary_exists` | 409 | второй основной держатель узла | «У вузла вже є основний виконавець» |
| `user_archived` | 422 | привязка архивированного человека | «Людину заархівовано» |
| `mapping_invalid` | 422 | маппинг колонок импорта не разобран | «Не вдалося зіставити колонки файлу» |
| `too_many_snapshots` | 429 | слишком частые снимки | «Забагато знімків. Спробуйте пізніше» |
| `rollback_in_progress` | 409 | откат уже идёт | «Відкат уже виконується» |

### 4.7 Жизненный цикл и офбординг — `33`

| Код | HTTP | Когда | Текст (uk) |
|---|---|---|---|
| `capabilities.readonly` | 403 | попытка изменить набор возможностей этапа | «Набір можливостей етапу змінити не можна» |
| `lifecycle_stage.in_use` | 409 | выключение этапа, к которому привязаны курсы | «Етап використовується у {n} курсах» |
| `course.stage_locked` | 409 | смена этапа курса при идущих прохождениях | «Курс уже проходять. Зміна етапу заблокована» |
| `lifecycle.disabled` | 422 | привязка курса к выключенному этапу | «Етап вимкнено у налаштуваннях компанії» |
| `offboarding.active_exists` | 409 | второй активный случай на человека | «Звільнення вже розпочато» |
| `offboarding.before_last_day` | 409 | завершение до последнего рабочего дня | «Останній робочий день ще не настав» |
| `offboarding.completed` | 409 | отмена завершённого случая | «Звільнення вже завершено» |

### 4.8 Хранилище — `34`

| Код | HTTP | Когда | Текст (uk) |
|---|---|---|---|
| `origin_required` | 400 | намерение загрузки без происхождения файла | «Не вказано походження файлу» |
| `file.too_large` | 413 | файл больше допустимого — **коллизия написания, §8.2** | «Файл завеликий» |
| `file_not_deletable` | 403 | удаление файла, который удалять нельзя | «Цей файл не можна видалити» |
| `under_review` | 409 | удаление файла, лежащего на проверке | «Файл прикріплено до роботи на перевірці» |
| `already_purged` | 409 | восстановление уже стёртого файла | «Файл уже видалено остаточно» |
| `file_purged` | 410 | обращение к стёртому файлу | «Файл видалено за строком зберігання» |
| `confirm_phrase_mismatch` | 422 | фраза подтверждения массового удаления не совпала | «Фраза підтвердження не збігається» |
| `addon_limit` | 422 | превышено число или объём аддонов | «Досягнуто межі додаткових обсягів» |

### 4.9 Тариф и лимиты — `35`

| Код | HTTP | Когда | Текст (uk) |
|---|---|---|---|
| `limit_exceeded` | 409 | **единый** отказ по жёсткому лимиту в любом эндпоинте системы; `details:{axis, used, limit}` — **см. §8.2** | «Ліміт вичерпано» |
| `addon_not_allowed` | 422 | аддон недоступен на текущем тарифе | «Ця опція недоступна на вашому тарифі» |

### 4.10 Обратная связь по контенту — `36`

Весь набор документа `36` записан в `UPPER_SNAKE`, тогда как остальной пакет и базовое ТЗ
используют нижний регистр. Это коллизия соглашения, а не значений — §8.2.

| Код | HTTP | Когда | Текст (uk) |
|---|---|---|---|
| `validation_failed` | 400 | вход не прошёл схему — **дублирует `validation_failed`, §8.2** | «Перевірте заповнені поля» |
| `content_issue.already_reported` | 409 | повторная жалоба того же человека на то же место | «Ви вже повідомили про цю проблему» |
| `content_issue.reporter_muted` | 423 | приём жалоб от человека приостановлен | «Надсилання повідомлень призупинено до {until}» |
| `content_issue.rate_limited` | 429 | слишком много жалоб подряд | «Забагато повідомлень. Спробуйте пізніше» |
| `content_issue.resolution_required` | 400 | закрытие карточки без резолюции | «Вкажіть результат розгляду» |
| `content_issue.invalid_transition` | 409 | недопустимый переход статуса карточки | «Такий перехід статусу неможливий» |
| `content_issue.not_a_quiz_issue` | 409 | предпросмотр пересчёта для жалобы не на вопрос | «Перерахунок можливий лише для скарг на питання» |
| `content_issue.already_rescored` | 409 | повторный пересчёт по той же карточке | «Результати вже перераховано» |
| `content_issue.fallback_rule_required` | 400 | набор правил маршрутизации без правила-фолбэка | «Потрібне правило за замовчуванням» |

### 4.11 Проверка, делегирование, время — `37`

| Код | HTTP | Когда | Текст (uk) |
|---|---|---|---|
| `forbidden` | 403 | нет скоупа — **см. §8.2** | «Немає доступу» |
| `review.delegate_target_forbidden` | 422 | у получателя нет прав на эту проверку | «Ця людина не може перевіряти таку роботу» |
| `review.delegate_target_declines` | 422 | получатель отсутствует или отказался принимать | «Людина недоступна для делегування» |
| `review.delegate_cycle` | 422 | делегирование по кругу | «Роботу вже делеговано цій людині» |
| `review.delegate_depth_exceeded` | 422 | превышена глубина цепочки делегирования | «Перевищено глибину делегування» |
| `review.already_in_review` | 409 | работа уже взята в работу другим | «Роботу вже взято на перевірку» |
| `review.delegation_in_progress` | 409 | отзыв делегирования, по которому уже идёт проверка | «Перевірка вже почалася. Відкликати неможливо» |
| `review.bulk_limit` | 422 | больше 25 работ в массовом делегировании | «Не більше 25 робіт за раз» |
| `absence.range_invalid` | 422 | даты отсутствия проверяющего не согласованы — **коллизия, §8.2** | «Невірний період відсутності» |
| `absence.self_substitute` | 422 | человек назначен собственным заместителем | «Не можна призначити людину її ж заступником» |
| `routing.scope_empty` | 422 | правило маршрутизации без области действия | «Вкажіть область дії правила» |
| `time.beat_invalid` | 422 | биение счётчика времени не разобрано | «Не вдалося зарахувати час» |
| `time.replay_too_old` | 422 | пакет офлайн-биений старше допустимого | «Час занадто давній і не зараховується» |
| `norm.value_range` | 422 | норма времени вне допустимых границ | «Норма часу виходить за межі допустимого» |
| `norm.sample_too_small` | 422 | наблюдённая медиана на слишком малой выборке | «Замало вимірів, щоб прийняти норму» |

### 4.12 Карточка человека: расширения — `38`

| Код | HTTP | Когда | Текст (uk) |
|---|---|---|---|
| `activity_forbidden` | 403 | нет скоупа на чужую ленту активности | «Немає доступу до активності цієї людини» |
| `rating_forbidden` | 403 | нет скоупа на чужой рейтинг | «Немає доступу до рейтингу цієї людини» |
| `note_forbidden` | 403 | нет скоупа на заметки | «Немає доступу до нотаток» |
| `forbidden` | 403 | норма отсутствий задаётся вне своей области — **см. §8.2** | «Немає доступу до цієї області» |
| `recalc_too_often` | 429 | пересчёт рейтинга чаще раза в час | «Перерахунок можливий раз на годину» |
| `note_body_invalid` | 422 | пустая или слишком длинная заметка | «Нотатка порожня або задовга» |
| `pinned_limit` | 409 | превышено число закреплённых заметок | «Досягнуто межі закріплених нотаток» |
| `visibility_narrowing_forbidden` | 409 | сужение видимости заметки после публикации | «Видимість нотатки вже не можна звузити» |
| `document_file_not_allowed` | 422 | файл приложен к типу, где файл запрещён | «Для цього типу документа файл не додається» |
| `document_file_required` | 422 | нет файла там, где он обязателен | «Додайте скан документа» |
| `document_dates_invalid` | 422 | дата выдачи позже даты окончания | «Дата видачі пізніша за дату завершення» |
| `document_is_evidence` | 409 | удаление документа-доказательства | «Документ є доказом і не видаляється» |
| `type_in_use` | 409 | деактивация используемого типа документа | «Тип використовується у {n} документах» |
| `reason_required` | 422 | переопределение нормы без причины | «Вкажіть причину» |
| `absence_overlap` | 409 | пересечение периодов отсутствия | «Періоди відсутності перетинаються» |
| `absence_range_invalid` | 422 | даты отсутствия не согласованы — **коллизия, §8.2** | «Невірний період відсутності» |

### 4.13 Итог

| Документ | Кодов |
|---|---|
| `28` кандидаты | 16 |
| `29` вакансии, закрытый контур | 15 |
| `29` вакансии, публичный контур | 9 |
| `30` ИИ-собеседование | 26 |
| `31` библиотека | 19 |
| `32` оргструктура | 13 |
| `33` жизненный цикл | 7 |
| `34` хранилище | 8 |
| `35` тариф и лимиты | 2 |
| `36` обратная связь | 9 |
| `37` проверка и время | 15 |
| `38` карточка человека | 16 |
| **Итого вхождений** | **155** |
| Повторные вхождения одного кода в двух документах (`consent.required`, `already_decided`, `reason_required`, `contact.missing`, `file.too_large`) | −5 |
| **Итого уникальных кодов ошибок** | **150** |

Из 150 уникальных кодов **11 участвуют в коллизиях** (§8.2) и требуют решения до реализации:
`consent.required`, `already_decided`, `limit_exceeded` против пяти кодов семейства `limit.*`,
`file.too_large` / `file.too_large`, `validation_failed` против `validation_failed`,
`absence.range_invalid` / `absence_range_invalid`, и четыре написания «нет скоупа»
(`forbidden`, `forbidden`, `forbidden`, `scope`, `forbidden`).

---

## 5. Соглашения, которые вводит пакет

Одиннадцать отступлений от `04-api.md` §4.1. Каждое — сознательное, каждое объяснено одной
строкой. Других отступлений в пакете быть не должно; найденное и не перечисленное здесь —
дефект, а не фича.

**5.1. `GET /people/:id/notes` пишет в `audit_log`** (`38` §10, §7.6). Единственный `GET` в
продукте с побочным эффектом: чтение чужих заметок о человеке само по себе — событие, которое
должно быть видно в журнале.

**5.2. Лимит ИИ-собеседования резервируется при старте, а не списывается по факту** (`30` §7.12,
§4). `POST /interviews/:sessionId/start` резервирует 1 операцию оси `ai_interview_ops`;
списывается она один раз за сессию; повторная расшифровка, переоценка после нашего сбоя и
перегенерация Підсумку не тарифицируются — тенант не платит дважды за отказ нашей инфраструктуры.

**5.3. Публикация на внешнюю площадку требует и `Idempotency-Key`, и `confirm:true` в теле**
(`29` §10, §7.16). Повтор такой мутации виден снаружи, поэтому одной идемпотентности мало: нужно
явное подтверждение человека, которому перед этим показан список уходящих наружу полей.

**5.4. Единый вид отказа по жёсткому лимиту в любом эндпоинте системы** (`35` §10):
`409 {error:{code:"limit_exceeded", message:"Ліміт вичерпано", details:{axis, used, limit}}}` —
чтобы фронт показывал один и тот же диалог везде. Это правило конфликтует с именованными кодами
`limit.*` в `28`, `29` и `30`; решение — §8.2.

**5.5. `POST /learning/time/beat` идемпотентен по `(session_key, seq)` без заголовка
`Idempotency-Key`** (`37` §10). Биений счётчика времени много и они идут с ненадёжной мобильной
сети; ключ уже содержится в теле, отдельный заголовок был бы дублированием. Повтор возвращает тот
же `credited` и ничего не начисляет.

**5.6. `POST /content-issues/reports` дедуплицируется дополнительно по `dedupe_key + user_id`**
(`36` §10). `Idempotency-Key` защищает от двойного нажатия, а `dedupe_key` — от второй жалобы того
же человека на то же место через неделю: она должна слиться с существующей карточкой, а не
создать новую.

**5.7. `POST /storage/upload-intent` может вернуть не ссылку, а отложенность** (`34` §10, §7).
При исчерпанном хранилище ответ — `{deferred:true, pendingId}`, запись сохраняется на устройстве
и досылается автоматически. Это реализация правила «обучение никогда не останавливается лимитами»
(`25` §10): сдать задание можно всегда, даже когда место кончилось.

**5.8. Аудио и видео собеседования идут в S3 напрямую по предподписанной ссылке** (`30` §10).
Через API проходят только метаданные; `POST /interviews/:sessionId/turns/:ordinal/upload`
возвращает `media_id` и `duration_ms`, но тела файла не видит.

**5.9. `GET /storage/files/:id/download` отдаёт `302`, а не тело файла** (`34` §10). Редирект на
подписанную ссылку со сроком 5 минут — файл не проходит через приложение.

**5.10. Публичный контур живёт под собственным префиксом `/api/public/v1`** (`29` §10, `39`
П-25.3). Своя авторизация (её нет), свои лимиты, свой лог, запрет операций чтения списков, тенант
из токена вакансии. Подробно — §3.

**5.11. В публичном контуре успех и отказ намеренно неразличимы** (`29` §7.3). `POST /j/:token/apply`
возвращает `202` при провале любой проверки, кроме проверки состояния вакансии. Это единственное
место в продукте, где код ответа сознательно не отражает результат операции.

Отдельно, не отступление, а следствие: две выгрузки пакета **не существуют в принципе**, и
эндпоинта для них нет — расшифровки и аудио собеседований (`30` §9.6) и заметки о людях
(`38` §9.6). Если такой эндпоинт появится, это дефект.

---

## 6. Реестр кодов уведомлений

Канал, событие и адресат — по документу-владельцу. Шаблоны регистрируются в
`notification_templates` и отправляются по `23-notifications.md` (патч `39` П-23).

### 6.1 Кандидаты — `28` (10)

| Код | Событие | Канал | Кому |
|---|---|---|---|
| `candidate.invited` | назначен контент и отправлено приглашение | e-mail, Telegram, SMS | кандидату |
| `candidate.reminder` | 2 дня до конца доступа, отбор не завершён | e-mail, Telegram | кандидату |
| `candidate.completed` | завершены все назначения | in-app, e-mail | рекрутеру |
| `candidate.review_needed` | появилась ручная проверка | in-app | наставнику |
| `candidate.rejected` | отказ при включённом «Повідомити» | e-mail | кандидату |
| `candidate.hired` | найм | e-mail, Telegram | кандидату |
| `candidate.hired.internal` | найм | in-app | керівнику точки, HR |
| `candidate.stale` | 7 дней без движения | in-app дайджест | рекрутеру |
| `candidate.consent_expiring` | 14 дней до стирания ПД | e-mail | рекрутеру, HR |
| `candidate.limit_warning` | 80 % лимита кандидатов | in-app | админу |

### 6.2 Вакансии — `29` (12)

| Код | Событие | Канал | Кому |
|---|---|---|---|
| `vacancy.apply_otp` | отправлен код подтверждения отклика | SMS, e-mail | откликнувшемуся |
| `vacancy.applied_welcome` | отклик принят, кандидат создан | e-mail, Telegram, SMS | кандидату |
| `vacancy.application_received` | новый отклик | in-app | рекрутеру вакансии |
| `vacancy.application_review` | отклик ушёл на модерацию | in-app | рекрутеру, HR |
| `vacancy.spam_burst` | более 20 блокировок по вакансии за час | in-app, e-mail | HR, админу |
| `vacancy.published_external` | успешная публикация на площадке | in-app | инициатору |
| `vacancy.publication_failed` | ошибка публикации после ретраев | in-app, e-mail | инициатору, HR |
| `vacancy.account_revoked` | площадка отозвала токен | in-app, e-mail | владельцу аккаунта, админу |
| `vacancy.publication_expiring` | объявление истекает через 3 дня | in-app | рекрутеру |
| `vacancy.closed_with_candidates` | закрытие с кандидатами в работе | in-app, e-mail | рекрутеру, HR |
| `vacancy.subscriber_reopened` | набор возобновлён | e-mail | подписавшимся на странице 410 |
| `vacancy.ai_quota` | исчерпана ось `ai_generate_ops` | in-app | админу |

### 6.3 ИИ-собеседование — `30` (11)

| Код | Событие | Канал | Кому |
|---|---|---|---|
| `interview.invited` | назначен модуль собеседования | e-mail, Telegram | кандидату |
| `interview.declined` | отказ от ИИ в пользу альтернативы | in-app, e-mail | рекрутеру |
| `interview.abandoned` | 24 часа без активности | e-mail | кандидату |
| `interview.completed` | сессия оценена | in-app, e-mail | рекрутеру |
| `interview.needs_human` | оценка не сформирована | in-app, e-mail | рекрутеру |
| `interview.consent_withdrawn` | отзыв согласия, записи удалены | in-app, e-mail | рекрутеру, HR |
| `interview.result_ready` | Підсумок отправлен | e-mail | кандидату |
| `summary.auto_send_scheduled` | сработало условие авто-отправки | in-app | рекрутеру |
| `ai.review_hint_failed` | 3 неудачи подсказки подряд | in-app | админу |
| `ai.quality_degraded` | доля `major` выше 15 % за 30 дней | e-mail, in-app | админу |
| `ai.provider_down` | 5 неудач провайдера подряд | in-app | админу |

### 6.4 Библиотека модулей — `31` (7)

| Код | Событие | Канал | Кому |
|---|---|---|---|
| `library_module_updated` | опубликована версия с «Сповістити» | in-app, Telegram | авторам контейнеров, где модуль используется |
| `library_hotfix_applied` | критическое исправление применено автоматически | in-app | авторам затронутых контейнеров |
| `library_hotfix_blocked` | исправление не применено из-за идущих прохождений | in-app | автору контейнера |
| `library_module_archived` | модуль заархивирован | in-app | авторам мест использования |
| `library_proposal_created` | подано предложение в библиотеку | in-app | носителям `library.publish` |
| `library_proposal_decided` | решение по предложению | in-app, Telegram | автору предложения |
| `library_stale_digest` | еженедельный дайджест устаревших ссылок | in-app | авторам контейнеров |

### 6.5 Оргструктура — `32` (7)

| Код | Событие | Канал | Кому |
|---|---|---|---|
| `org_node_assigned` | человека привязали к узлу | Telegram | сотруднику |
| `org_manager_changed` | сменился руководитель | Telegram | сотруднику и новому руководителю |
| `org_subordinate_added` | в ветке появился подчинённый | Telegram | руководителю |
| `org_node_vacant` | держатель снят или уволен | Telegram, e-mail | руководителю уровнем выше |
| `org_structure_conflict` | найден конфликт важности `error` | e-mail | администраторам тенанта |
| `org_structure_import_finished` | импорт завершён | e-mail | инициатору |
| `org_structure_rollback` | выполнен откат к снимку | e-mail | администраторам тенанта |

### 6.6 Жизненный цикл и офбординг — `33` (7)

| Код | Событие | Канал | Кому |
|---|---|---|---|
| `lifecycle.stage_entered` | переход на новый этап | in-app | человеку |
| `lifecycle.stage_completed` | закрыты все обязательные назначения этапа | in-app, Telegram | человеку, руководителю |
| `lifecycle.stuck` | превышена норма времени в этапе | дайджест | руководителю, HR |
| `offboarding.started` | запущен офбординг | in-app | HR, руководителю точки |
| `offboarding.handover_due` | 3 дня до последнего дня, чек-лист открыт | in-app, Telegram | ответственному |
| `offboarding.interview_ready` | назначено выходное интервью | e-mail | уходящему |
| `offboarding.completed` | офбординг завершён, доступ закрыт | in-app | HR |

### 6.7 Хранилище — `34` (12)

| Код | Событие | Канал | Кому |
|---|---|---|---|
| `storage_quota_80` | 80 % объёма, еженедельно | in-app, e-mail | админу |
| `storage_quota_95` | 95 % объёма, ежедневно | in-app, e-mail, Telegram | админу |
| `storage_quota_exceeded` | 100 % объёма, немедленно | in-app, e-mail, Telegram | админу |
| `storage_upload_blocked` | появилась отложенная загрузка | in-app, Telegram | админу |
| `storage_upload_deferred` | запись сохранена локально | in-app, Telegram | сотруднику |
| `storage_pending_upload_done` | отложенный файл дослан | in-app, e-mail | сотруднику, админу |
| `storage_pending_upload_expired` | не удалось дослать за 14 дней | in-app, e-mail | сотруднику, админу |
| `storage_retention_warning` | до срабатывания политики `warn_days_before` | e-mail, in-app | админу |
| `storage_retention_done` | политика отработала | e-mail, in-app | админу |
| `storage_bulk_delete_done` | заявка на массовое удаление выполнена | in-app, e-mail | инициатору, админу |
| `storage_orphans_found` | файлов без владельца больше 1 Gb | in-app, e-mail | админу |
| `storage_addon_activated` | аддон объёма оплачен | in-app, e-mail | админу |

`storage.counter_drift` в реестр не входит: это внутренний алерт оператору платформы, а не
уведомление тенанту.

### 6.8 Тариф и лимиты — `35` (13, из них 2 не новые)

| Код | Событие | Канал | Кому |
|---|---|---|---|
| `limit_warning` | ось достигла 80 % | in-app, Telegram, e-mail | owner, admin |
| `limit_exceeded` | ось достигла 100 % | in-app, Telegram, e-mail | owner, admin |
| `plan_expiring_soon` | 14 / 7 / 3 / 1 день до конца оплаченного периода | Telegram, e-mail | owner |
| `plan_grace_started` | начался льготный период | Telegram, e-mail | owner, admin |
| `plan_readonly` | включён режим только-чтение | Telegram, e-mail, in-app | owner, admin |
| `plan_changed` | тариф применён | in-app, e-mail | owner, admin |
| `plan_change_blocked` | заявка упёрлась в превышение | in-app | owner |
| `ai_expiring_soon` | 14 / 7 / 3 / 1 день до конца ИИ-подписки | Telegram, e-mail | owner, admin |
| `ai_expired` | ИИ-подписка завершена | Telegram, e-mail, in-app | owner, admin |
| `ai_ops_exhausted` | ИИ-ось исчерпана | in-app | owner, admin |
| `payment_received` | платёж принят | e-mail | owner |
| `addon_activated` | аддон включён | in-app, e-mail | owner |
| `addon_expiring` | 7 дней до конца аддона | in-app, e-mail | owner |

`limit_warning` и `limit_exceeded` — **не новые коды**: они уже есть в `24` §8; пакет добавляет к
ним обязательный параметр `axis` в `payload` и дедупликацию не чаще раза в 24 часа на связку
`(tenant_id, axis, level)`. В счёт новых кодов не идут.

### 6.9 Обратная связь по контенту — `36` (10)

| Код | Событие | Канал | Кому |
|---|---|---|---|
| `content_issue_created` | создана карточка жалобы | in-app, Telegram | ответственному |
| `content_issue_merged` | 3-я и каждая 5-я жалоба на то же место | in-app | ответственному |
| `content_issue_blocking` | карточка важности `blocking` | Telegram | ответственному, админу |
| `content_issue_overdue` | просрочка 1 / 3 / 7 дней | in-app, Telegram | ответственному → руководителю → админу |
| `content_issue_accepted` | карточка взята в работу | in-app | заявителям |
| `content_issue_fixed` | закрыта с исправлением | in-app, Telegram | заявителям |
| `content_issue_rejected` | отклонена | in-app | заявителям |
| `content_issue_rescore_ready` | попытки можно пересчитать | in-app, e-mail | админу |
| `content_issue_rescored` | пересчёт применён | in-app, Telegram | тем, чей результат изменился |
| `content_reporter_muted` | автоматическая приостановка приёма жалоб | in-app | человеку и его руководителю |

### 6.10 Проверка, делегирование, время — `37` (11)

| Код | Событие | Канал | Кому |
|---|---|---|---|
| `review_delegated` | работа делегирована | push, in-app | делегату |
| `review_delegation_revoked` | делегирование отозвано | in-app | делегату |
| `review_delegation_resolved` | делегат принял решение | in-app | делегировавшему |
| `review_delegation_expired` | делегат не уложился в срок | push, in-app | обоим |
| `review_assigned` | работа назначена правилом маршрутизации | in-app | проверяющему |
| `review_sla_warning` | 50 % срока проверки | push | проверяющему |
| `review_sla_breach` | 100 % срока проверки | push, e-mail | руководителю области |
| `review_escalated` | 150 % срока проверки | push, e-mail | руководителю области |
| `review_queue_moved` | переброс очереди отсутствующего | in-app | принимающему |
| `review_overloaded` | открытых работ больше `max_open_items` | in-app | руководителю |
| `content_time_deviation` | флаг отклонения времени при выборке ≥ 20 | in-app | автору материала |

### 6.11 Карточка человека: расширения — `38` (8)

| Код | Событие | Канал | Кому |
|---|---|---|---|
| `person_document_expiring` | документ перешёл в «истекает» | push, Telegram | человеку, руководителю точки, HR |
| `person_document_expired` | документ просрочен | push, Telegram | тем же |
| `person_document_missing` | обязательный тип отсутствует 7 дней после приёма | Telegram | руководителю точки, HR |
| `person_note_shared` | заметкой поделились с человеком | push | человеку |
| `person_note_flagged` | заметка сохранена с признаками чувствительного содержания | внутреннее | админу |
| `absence_norm_exceeded` | остаток нормы отсутствий стал отрицательным | Telegram | HR |
| `absence_deadline_shifted` | дедлайн сдвинут из-за отсутствия | push | человеку, руководителю |
| `rating_formula_changed` | смена версии формулы рейтинга | внутреннее | админу |

### 6.12 Итог

| Документ | Кодов | Из них новых |
|---|---|---|
| `28` | 10 | 10 |
| `29` | 12 | 12 |
| `30` | 11 | 11 |
| `31` | 7 | 7 |
| `32` | 7 | 7 |
| `33` | 7 | 7 |
| `34` | 12 | 12 |
| `35` | 13 | 11 |
| `36` | 10 | 10 |
| `37` | 11 | 11 |
| `38` | 8 | 8 |
| **Итого** | **108** | **106** |

**106 новых кодов уведомлений**, плюс два существующих (`limit_warning`, `limit_exceeded`),
которым пакет добавляет обязательный параметр `axis` и правило дедупликации.

Коллизий имён в строгом смысле (один код — два разных события) не найдено. Найдены три пары
**дублирующих кодов на одно событие** и одна несогласованность соглашения об именах — §8.6.

---

## 7. Влияние на базовый `04-api.md`

Что меняется в уже описанных эндпоинтах базового ТЗ. Источник — `39-patches.md`.

| Эндпоинт базового ТЗ | Что меняется | Патч | Приоритет |
|---|---|---|---|
| `GET /people`, `GET /people/:id`, `POST /people/import`, `/tasks/:id/audience`, все адресные выборки | **Ни одна выборка людей не выполняется без явного фильтра `users.kind`.** До пакета `users` содержала только сотрудников; после миграции те же запросы начнут возвращать кандидатов — в списке сотрудников, в адресатах рассылки, в отчётах по штату, в подсчёте лимита `users_active`, в выгрузках. Реализация — два репозиторных метода или два представления, не ручной фильтр в каждом запросе | П-16.1 | блокирующий |
| `GET/PUT /tasks/:id/params` | Форма назначения читает возможности этапа курса и **не сохраняет** ключи `params`, соответствующие выключенным возможностям. Не сохраняет со значением по умолчанию, а не сохраняет вовсе — иначе у курса базы знаний в `params` окажется `deadline_mode`, и отчёт «нарушены сроки» начнёт считать нарушения там, где сроков нет | П-15 | блокирующий |
| `CRUD /settings/roles`, `POST /people/:id/roles` | Регистрируются новые скоупы пакета. Их фактическое число — **68**, а не 24, как записано в П-01, и четыре имени из П-01 в модульных документах не существуют (§8.1) | П-01 | блокирующий |
| `GET /review/answers`, `/review/workshops`, `/review/checklists` | В очередях появляются работы **кандидатов**, а не только сотрудников (`review_queue_items.subject_kind`); появляются четыре таба вместо одного списка; метрики времени собираются биениями (`/learning/time/beat`), а не разницей «открыл/закрыл». Отдельно: `review_queue_items` повышается из витрины в полноценную таблицу с собственным состоянием — перестроение «с нуля» запрещено | П-13 | обязательный / блокирующее замечание |
| `POST /content`, `CRUD /courses/:id/items` | `lessons.module_id` становится nullable; урок может быть телом библиотечного модуля. Без этого исполнитель поставит `not null` по базовому тексту | П-11 | обязательный |
| `GET/PUT /trajectories/:id/graph` | Узел траектории может ссылаться на библиотечный модуль с закреплённой версией (`trajectory_nodes.library_version_id`). Модель ветвления (`and / or / delay / stop_delay`) **сохраняется** — второй эталон её не имеет, это не повод упрощать граф | П-17 | обязательный |
| `CRUD /tests/:id/questions`, `/polls/:id/questions` | Восьмой тип вопроса «Лінійна шкала»; у опроса — переключатель «Анонімне опитування» (влияет на хранение, а не только на показ) и «Підказка для відповіді» у открытого вопроса | П-12.1, П-12.2 | обязательный |
| `POST /attempts/:id/recalculate` | Второй вход в ту же логику пересчёта — из карточки жалобы (`POST /content-issues/:id/rescore`). Логика одна, точек входа две | П-12.4 | обязательный |
| `GET/PATCH /settings/tenant` | Шесть новых блоков: брендирование контента колонтитулом, 2FA (TOTP) на уровне тенанта, API-токен тенанта (хранится в `tenant_secrets`, показывается один раз), выбор доступных языков интерфейса, поведение таблиц (**настройка на браузер, не на аккаунт**), нормы отпуска и больничного по умолчанию с переопределением на точке | П-24.1 | обязательный |
| `CRUD /settings/notification-templates` | Регистрируются 106 новых кодов уведомлений пакета (§6). Отдельное правило: уведомления кандидатам идут **вне** тихих часов тенанта, но внутри окна 09:00–20:00 по локальному времени кандидата — тихие часы настроены под сотрудников одной сети, кандидат к ней не принадлежит | П-23 | обязательный |
| `GET/PUT /settings/notification-schedule`, дайджест руководителю | Адресат дайджеста берётся из `resolveManager()` (`GET /org-structure/manager/:userId`), а не из `locations.manager_id` | П-23, П-16.4 | обязательный |
| `CRUD /locations`, `/org-units` | `locations.manager_id` понижается до **резервного** источника руководителя; основной — оргструктура. Переключение по флагу тенанта `org_structure_is_source_of_truth` | П-16.4 | блокирующий |
| `CRUD /positions` | Появляется `position_groups` — необязательная группировка справочника должностей (4 поля, ссылка из `positions`). Появляется связь «посада → курси за замовчуванням», реализуемая как правило автоматизации, привязанное к должности, — отдельной таблицы не заводится | П-24.5, П-24.3 | обязательный |
| `CRUD /automation-rules` | Принимает привязку к должности как носитель правила «посада → курси за замовчуванням» | П-24.3 | обязательный |
| `GET /reports/:name` | Регистрируются двенадцать новых отчётов пакета, и все они должны быть доступны конструктору выгрузок, а не только как готовые экраны | П-22 | желательный |
| `POST /notices/:id/acknowledge`, лента хаба | Разводятся две сущности: новости компании (пишет админ тенанта) и объявления платформы (`platform_announcements` — таблица без `tenant_id`, вне RLS, только чтение у тенанта). Публичная оргструктура хаба заменяется витриной `GET /org-structure/tree?mode=view` — две реализации дерева не нужны | П-21 | обязательный |
| `POST /platform/tenants/:id` (лимиты) | Оси лимитов заменяются перечнем из `35` §7.1 — **одиннадцать осей вместо трёх** | П-25.1 | обязательный |
| Весь `04-api.md` | Добавляется раздел со ссылкой на этот документ и на публичный контур `/api/public/v1`, который не проходит через `withTenant()` в обычном виде | П-04 | обязательный |
| `POST /media/upload-url`, `POST /media/:id/complete` | Пакет вводит `POST /storage/upload-intent` с классификацией происхождения и режимом отложенной загрузки. Соотношение двух входов в документах не зафиксировано — §8.3 | — | **не закрыто** |
| `POST /reports/:name/export` | Ось `export_rows` деградирует мягко: выгрузка сверх порога уходит в фоновую задачу со ссылкой на файл, а не отклоняется | `35` §7.1 | обязательный |

---

## 8. Найденные противоречия и открытые вопросы

Всё перечисленное — расхождения между документами пакета, обнаруженные при сведении. Ни одно из
них не исправлено здесь: этот документ производный (§1), чинить нужно документ-владелец правкой
с пометкой-исправлением.

### 8.1 П-01 расходится с секциями 2 модульных документов — блокирующее

Патч `39` П-01 объявляет «24 новых скоупа» и приводит таблицу на 35 имён. Фактический перечень из
секций 2 модульных документов — **68 скоупов**. Расхождение и по числу, и по именам.

| Документ | Скоупов в §2 документа | В П-01 | Имена в П-01, которых в документе нет |
|---|---|---|---|
| `28` | 7 | 7 | — |
| `29` | 9 | 4 | `vacancy.integration.manage` |
| `30` | 9 | 3 | `interview.scenario.edit` |
| `31` | 4 | 2 | — |
| `32` | 3 | 3 | — |
| `33` | 4 | 4 | — |
| `34` | 4 | 1 | `storage.manage` |
| `35` | 9 | 2 | — |
| `36` | 6 | 3 | — |
| `37` | 6 | 2 | `review.capacity.manage` |
| `38` | 7 | 4 | `person.note.view`, `absence.manage` |
| **Итого** | **68** | 35 строк при заявленных 24 | 6 несуществующих имён |

Отдельно: `35` §2 выдаёт экран хранилища и удаление файлов по скоупу **`storage.manage`**, тогда
как `34` §2 разбивает то же самое на четыре — `storage.view`, `storage.delete`, `storage.policy`,
`storage.addon` — и `storage.manage` не упоминает вовсе. Два документа описывают один экран под
разными правами.

**Что нужно:** привести П-01 к фактическим перечням модульных документов (68 имён), решить
коллизию `storage.manage` против `storage.*` в пользу одного из двух документов, и пересчитать
заявленное число. Пока этого нет, реестр скоупов заполнить нечем.

### 8.2 Коллизии кодов ошибок

**8.2.1. `consent.required` — один код, два значения и два статуса. Настоящая коллизия.**
В `29` §10 (публичный контур) это `422` — не отмечена галка согласия на обработку данных в форме
отклика. В `30` §10 это `409` — действие над сессией собеседования до получения согласия на
запись голоса. Документ `30` §7.4 прямо говорит, что это **разные согласия** и одно не заменяет
другое, — тем более их коды не должны совпадать. Предлагается развести:
`consent.form_required` (422) и `interview.consent_required` (409); решать документу-владельцу.

**8.2.2. `limit_exceeded` против семейства `limit.*` — противоречие правила и практики.**
`35` §10 постановляет: отказ по жёсткому лимиту **в любом эндпоинте системы** возвращает
`409 limit_exceeded` с `details.axis`, «чтобы фронт показывал один диалог везде». При этом
`28` §10 возвращает `limit.candidates_exceeded` и `limit.users_exceeded`, `29` §10 —
`limit.ai_ops_exceeded`, `30` §10 — `limit.ai_interview_exhausted`, `limit.ai_generate_exhausted`
и просто `limit`. Пять именованных кодов против одного унифицированного. Либо правило `35`
ошибочно и коды остаются именованными, либо именованные коды заменяются на `limit_exceeded` с
`details.axis` в `candidates_active` / `users_active` / `ai_generate_ops` / `ai_interview_ops`.
Второе выглядит верным (ось уже есть, диалог один), но решение за `35` и `28`/`29`/`30`.

**8.2.3. `already_decided` — один код в двух подсистемах.** `30` (повторное решение по согласию
на собеседование) и `31` (повторное решение по предложению в библиотеку). Оба `409`, смысл
«решение уже принято», но сущности разные и тексты разные. Мягкая коллизия: работать будет, но
i18n-ключ один на два текста. Предлагается `interview.consent.already_decided` и
`library.proposal.already_decided`.

**8.2.4. `file.too_large` против `file.too_large`.** `29` и `30` пишут через точку, `34` — через
подчёркивание. Один и тот же смысл, один и тот же `413`, два i18n-ключа. Чинится выбором одного
написания.

**8.2.5. `validation_failed` против `validation_failed`.** `36` §10 вводит `400 validation_failed` при том, что
базовое ТЗ уже имеет `400 validation_failed` с `details.issues`. Это не новый код, это второе имя
существующего. Весь набор `36` записан в `UPPER_SNAKE`, тогда как базовое ТЗ и остальные десять
документов пакета — в нижнем регистре с точкой или подчёркиванием. Девять кодов документа `36`
требуют приведения к общему соглашению.

**8.2.6. `absence.range_invalid` против `absence_range_invalid`.** `37` §10 и `38` §10, оба `422`,
оба «неверный период отсутствия». Но это **разные сущности**: в `37` отсутствие проверяющего
(с заместителем и перебросом очереди), в `38` — кадровая запись отпуска или больничного. Два
разных понятия под почти одинаковыми кодами — худший из возможных вариантов: их спутают. Нужно и
развести коды, и явно записать в обоих документах, что сущности разные (см. 8.3.4).

**8.2.7. Пять написаний «нет скоупа».** Базовое ТЗ: `403 forbidden`. `32`: `403 forbidden`.
`37`: `403 forbidden`. `30`: `403 scope` и `403 interview.listen`, `403 ai.audit`. `38`:
`403 forbidden`, `403 note_forbidden`, `403 activity_forbidden`, `403 rating_forbidden`.
`31`: `403 library.forbidden`, `403 library.not_author`, `403 library.manage_required`.
Базовое ТЗ уже дало для этого код `forbidden`; уточняющие коды оправданы там, где интерфейс
показывает разный текст, но пять разных написаний одного и того же «доступ закрыт» — нет.
Предлагается: `forbidden` для общего случая, уточнения только там, где текст действительно
отличается, в едином написании `<домен>.<что>_forbidden`.

**8.2.8. Неполные коды.** `30` §10 содержит `409 limit` и `410 expired` — это не коды, а обрывки.
Нужны полные имена (`limit.ai_*_exhausted` или `limit_exceeded`; `summary.share_expired`).

### 8.3 Несогласованные и пересекающиеся пути

**8.3.1. `/storage/files` объявлен в двух документах с разными контрактами.** `34` §10:
`GET /storage/files` (фильтры, курсор), `DELETE /storage/files/:id` (одиночное мягкое удаление в
корзину, с `reason`, возвращает `{lifecycle, purgeAfter}`), а массовое удаление идёт через заявку
`POST /storage/deletions` с подсчётом доказательств и подтверждением фразой. `35` §10:
`GET /storage/files` и `DELETE /storage/files` с телом `{ids[]}`, возвращающий освобождённые
байты, под скоупом `storage.manage`. Это второй, обходной путь массового удаления — без подсчёта
`evidenceCount`, без подтверждения фразой, под другим скоупом. Учитывая, что `34` §9 прямо
называет журнал удалений «ответом на вопрос, кто снёс доказательства за прошлый квартал»,
обходной путь недопустим. **Решение нужно от `35`:** убрать обе строки из `35` §10 и оставить
ссылку на `34`, либо обосновать второй контракт.

**8.3.2. `GET /public/candidate-summaries/:token` живёт не в публичном контуре.** `30` §10
объявляет его в общей таблице под `/api/v1`, тогда как `29` §10 и `39` П-25.3 постановляют, что
запрос без сессии приходит **только** в `/api/public/v1`, где тенант выводится из токена, а §1
этого документа и `39` П-04 называют публичный контур «единственным местом в продукте без
сессии». Либо этот эндпоинт переезжает в `/api/public/v1/candidate-summaries/:token` и получает
собственные лимиты частоты и правило «что никогда не отдаётся наружу», либо правило единственности
публичного контура перестаёт быть верным. Первое предпочтительно: Підсумок уходит кандидату,
то есть человеку вне тенанта, ровно как публичная страница вакансии. **Сейчас у этого эндпоинта
не описаны ни ограничения частоты, ни поведение при переборе токенов** — в отличие от `/j/:token`,
где перебор закрыт выровненным по времени 404.

**8.3.3. Два входа в загрузку файла.** Базовое ТЗ: `POST /media/upload-url` → `POST /media/:id/complete`.
`34` §10: `POST /storage/upload-intent` с обязательным `origin`, классификацией источника и
режимом `{deferred:true}`. Ни `34`, ни `39` не говорят, заменяет ли новый вход старый.
Учитывая сквозную проверку `39` П-07.3 («перечень `media_assets.origin` в БД совпадает со списком
`40` §4»), скорее всего `upload-intent` должен заменить `upload-url` целиком — иначе останется
путь загрузки файла без `origin`, и проверка будет проходить, а данные копиться неклассифицированные.
**Нужен явный патч к `04-api.md` §4.15.**

**8.3.4. Два реестра отсутствий под одним словом.** `37` вводит `POST /review/absences` —
отсутствие проверяющего: вид, заместитель, переброс открытых работ. `38` вводит
`POST /people/:id/absences` и `PUT /absence-norms` — кадровый учёт отпусков и больничных с
нормами и остатками. Это разные сущности с разной жизнью, но одно украинское слово
«відсутність», почти одинаковые коды ошибок (8.2.6) и никакой перекрёстной ссылки между
документами. Как минимум нужно: взаимная ссылка в обоих документах, разные коды ошибок, и ответ
на вопрос — **создаёт ли одобренное кадровое отсутствие из `38` запись отсутствия проверяющего
из `37` автоматически.** Логика подсказывает, что должно: человек в отпуске не должен получать
работы на проверку. В документах этого нет.

**8.3.5. Кросс-документное владение путями.** Три документа пишут в пространство имён
`/candidates/*`, принадлежащее `28`: `29` объявляет `POST /candidates/:id/criterion-scores`,
`30` объявляет четыре пути `/candidates/:id/interview*`. Это не ошибка — так и должно быть, поле
кандидата принадлежит рекрутингу целиком, — но в `28` §10 эти пути не упомянуты, и читающий
только `28` решит, что видит всю поверхность кандидата. **Нужна строка-отсылка в `28` §10.**

**8.3.6. `35` §10 пишет пути с префиксом, остальные — без.** `35` §10 записывает
`GET /api/v1/billing/summary`, все прочие документы — `GET /billing/summary`, подразумевая
префикс. Косметика, но при машинной сборке маршрутов даст `/api/v1/api/v1/billing/summary`.

**8.3.7. Отношение `GET /review/queue` к трём базовым очередям не определено.** `37` §10 вводит
единую очередь с четырьмя табами; базовое ТЗ `04-api.md` §4.7 имеет `/review/answers`,
`/review/workshops`, `/review/checklists`. `39` П-13 говорит о «четырёх табах вместо одного
списка», но не говорит, остаются ли три базовых пути, становятся ли они фильтрами `/review/queue`
или отменяются. Без ответа исполнитель построит и то и другое.

### 8.4 Секции 10, неполные по существу

Ни одна из перечисленных ниже неполнот здесь не дописана — это работа документа-владельца.

| Документ | Чего не хватает в §10 |
|---|---|
| `29` | §9 описывает шесть отчётов — ни для одного нет эндпоинта. `/reports/vacancy-*` не объявлены |
| `30` | §9 описывает шесть отчётов, включая «Стоимость ИИ» и «Качество модели» — эндпоинтов нет |
| `31` | §9 описывает три отчёта («Використання бібліотеки», «Застарілі посилання», «Пропозиції до бібліотеки») — эндпоинтов нет |
| `32` | §9 описывает пять отчётов — есть только `GET /org-structure/export`, который выгружает структуру, а не отчёты |
| `33` | §9.4 «Курси без етапу» — отчёта в §10 нет; `/reports/lifecycle` и `/reports/offboarding` покрывают §9.1–9.3 |
| `35` | §9 описывает четыре отчёта тенанта и три платформенных — эндпоинтов нет ни для одного; кроме того у четырёх строк §10 колонка ошибок пуста |
| `36` | §9 описывает пять отчётов — эндпоинт есть только у одного (`/reports/content-quality`) |
| `37` | §9.1 «Черга перевірки» как выгрузка экрана — отдельного эндпоинта выгрузки нет |
| `34` | Метод `…/dry-run` явно не назван: строка озаглавлена `GET/PUT`, но сухой прогон с телом `{origin}` — это `POST` |
| `30` | `GET/PUT /interview-scenarios[/:id]`, `GET/POST /ai/providers[/:id]`, `GET/POST /ai/quality-reviews[/:id]` — свёртка `[/:id]` не разворачивается однозначно; DELETE сценария не объявлен вовсе |
| `32` | Строка `POST/GET/PUT /org-structure/nodes \| /nodes/:id` не даёт `GET` списка узлов и не говорит, есть ли `DELETE` (есть `archive`, но это другое) |
| `36`, `37`, `38` | Записи `CRUD /settings/content-issue-routing-rules`, `CRUD /review/routing-rules`, `CRUD /person-document-types` не разворачивают методы и путь элемента |
| `35` | Нет эндпоинта отмены или возврата платежа — только `POST /platform/tenants/:id/payments` на приём |

### 8.5 Расхождения в объявленных числах

| Где | Заявлено | Фактически |
|---|---|---|
| `39` П-01 | «24 новых скоупа» | 35 строк в таблице П-01; **68** в секциях 2 модульных документов |
| `39` П-23 | «Их 57» (кодов уведомлений) | **108** вхождений, из них **106** новых (§6.12) |
| `39` П-04 | ссылка на этот документ | документ создан; ссылку в `04-api.md` ещё нужно поставить |
| `39` П-22 | «двенадцать новых отчётов» | в §9 одиннадцати документов описано существенно больше сорока отчётных форм; двенадцать — это те, что П-22 перечисляет поимённо, остальные не зарегистрированы |

Числа в `39` нужно пересчитать по факту. Расхождение в кодах уведомлений почти двукратное — если
реестр шаблонов заполнят по П-23, половина уведомлений пакета не получит шаблона и не уйдёт.

### 8.6 Дублирующие коды уведомлений

Коллизий имён нет, но есть три пары кодов на одно событие и одно расхождение соглашения.

1. **`storage_addon_activated` (`34`) и `addon_activated` (`35`)** — оба про «аддон оплачен и
   объём увеличен», оба в in-app и e-mail. `34` шлёт админу, `35` — владельцу. Скорее всего это
   одно событие с двумя адресатами, а не два события.
2. **`vacancy.ai_quota` (`29`) и `ai_ops_exhausted` (`35`)** — оба про исчерпание оси
   `ai_generate_ops`, оба in-app. `29` шлёт админу, `35` — owner и admin. То же самое.
3. **`candidate.limit_warning` (`28`) и `limit_warning` с `axis=candidates_active` (`35`)** —
   оба про 80 % лимита кандидатов. `35` §8 явно вводит дедупликацию на связку
   `(tenant_id, axis, level)`; отдельный код `28` эту дедупликацию обходит и даст второе
   сообщение о том же.
4. **Два соглашения об именах.** `28`, `29`, `30`, `33` пишут через точку
   (`candidate.invited`, `lifecycle.stage_entered`); `31`, `32`, `34`, `35`, `36`, `37`, `38` —
   через подчёркивание (`library_module_updated`, `review_sla_breach`). Реестру шаблонов это
   безразлично, но словарю i18n-ключей и группировке в настройках уведомлений — нет.

### 8.7 Открытые вопросы, не относящиеся к коллизиям

1. **Ограничения частоты для закрытого контура.** Ось `api_rate_rpm` (`35` §7.1) даёт `429` с
   `Retry-After`, но ни один документ не называет значение по умолчанию и не говорит, считается
   ли окно на тенант, на пользователя или на токен интеграции. Для публичного контура пороги
   выписаны поимённо (§3.3), для закрытого — нет.
2. **Bearer-токен тенанта и новые эндпоинты.** `04-api.md` §4.1 допускает
   `Authorization: Bearer <api_token>` с теми же скоупами; `39` П-24.1 добавляет выдачу такого
   токена в настройки. Ни один документ пакета не говорит, какие из 234 новых эндпоинтов
   доступны по Bearer, а какие только по сессии. Очевидные кандидаты на запрет — всё под
   `/platform/*`, `GET /people/:id/notes` (§5.1), `GET /candidates/:id/interview/media/:turnId`.
3. **Вебхуки наружу.** `04-api.md` §4.18 перечисляет восемь событий. Пакет вводит события,
   которые интеграциям явно нужны (`candidate.hired`, `vacancy.application_received`,
   `offboarding.completed`), но ни один документ не добавляет их в список вебхуков.
4. **`GET /storage/files/:id/download` и доказательства.** `34` отдаёт `302` на подписанную
   ссылку 5 минут. Пишется ли факт скачивания файла-доказательства в `audit_log`, документ не
   говорит; по логике §9 («кто снёс доказательства») — должен, как `GET /people/:id/notes`.
