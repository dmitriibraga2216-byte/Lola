# Lola LMS — ТЗ. 34. Хранилище как управляемый ресурс

## 1. Назначение и границы

Хранилище в Lola — не счётчик в углу экрана биллинга, а отдельный управляемый и тарифицируемый ресурс со своим экраном, правилами
удаления и сроком хранения. Так это устроено на эталоне Sintegrum (`/storage`, §14), и так обязано быть у нас: основную массу байтов
занимают не картинки контента, а **видеоответы сотрудников на задания**, а видеоответ, по которому выставлена оценка, — не файл, а
доказательство прохождения. Входит: реестр файлов и их классификация, экран `/storage`, фильтры и постраничный список, массовое
удаление с подтверждением, корзина, политики хранения, подсчёт потребления (оперативный и суточный), поведение при исчерпании
лимита, докупка объёма как аддона, осиротевшие файлы. Не входит: механизм загрузки и обработки медиа (`02` §2.9), тарифная сетка и
оплата (`docs/v2/35-billing-limits.md`), лимиты тенанта в целом (`25` §10), бэкапы (`06`), экспорт данных тенанта при расторжении (`25`
§8). Инвариант, унаследованный из `25` §10 и не подлежащий пересмотру: **обучение никогда не останавливается лимитами — блокируются
только загрузки**; сотрудник, упёршийся в исчерпанную квоту тенанта, не теряет ни попытку, ни записанное видео, ни срок.

## 2. Роли и скоупы

Новые скоупы: `storage.view`, `storage.delete`, `storage.policy`, `storage.addon`.

| Действие | employee | mentor | manager | author | admin |
| --- | :-: | :-: | :-: | :-: | :-: |
| Видеть свои файлы в карточке прохождения | ✓ | ✓ | ✓ | ✓ | ✓ |
| Открыть «Сховище» | — | — | ✓ (свои точки) | — | ✓ |
| Видеть сводку потребления тенанта | — | — | — | — | ✓ |
| Скачать файл из реестра | — | ✓ (своя очередь проверки) | ✓ | ✓ | ✓ |
| Удалить файл-не-доказательство \| файл-доказательство | — | — | — | ✓ (свой контент) \| — | ✓ \| ✓ (двойное подтверждение) |
| Массовое удаление, восстановление из корзины, политики, докупка объёма | — | — | — | — | ✓ |

Оператор платформы видит потребление всех тенантов (`24` §4.6), но **не имеет права удалять файлы тенанта**: удаление чужих
доказательств оператором — неприемлемый риск, для этого есть только процедура удаления тенанта целиком (`25` §8).

## 3. Сущности и поля

### 3.1 Решение по реестру: расширяем `media_assets`, параллельный реестр не заводим

`[решение]` Единственный реестр файлов — существующая `media_assets` (`02` §2.9). Обоснование: (1) файл попадает в S3 ровно одним
путём — через presigned URL и запись в `media_assets`, второй реестр дал бы вторую точку истины и расхождение «экран показывает
одно, урок ссылается на другое»; (2) ссылки на файлы по всему продукту уже ведут сюда (`lessons.body[].key`,
`workshop_submissions.files[].media_id`, `checklist_runs.answers[].photo_media_ids`, `certificates`, `courses.cover_key`), перевод
их на другую таблицу есть миграция половины продукта ради экрана статистики; (3) удаление обязано быть атомарным с пересчётом
потребления: одна таблица с триггером даёт транзакционную гарантию, две — задачу сверки. Отдельно заводим **только агрегаты и
правила**. `status` и `lifecycle` — разные оси: `status` (`uploaded | processing | ready | failed`) — техническая готовность
объекта, `lifecycle` — положение в хранилище; файл бывает `status='ready'` и `lifecycle='orphaned'` одновременно.

### 3.2 `alter table media_assets`

`[исполнено: PR-11 + PR-12, миграции 0062_v2_media_rename и 0063_v2_media_origin]` Ниже — редакция
после решений фазы 1, а не первоначальный список. Три поправки: `created_at` и `original_name`
уже были в таблице и вычеркнуты; `owner_user_id` и `checksum_sha256` **переименованы** из
`uploaded_by` и `checksum`, а не добавлены рядом (В-4) — факт «кто загрузил» переезжает в
`audit_log` событием `media.upload`, у домиграционных файлов владелец = загрузивший;
`category_id` заменён на `stage_code` (В-10). Перечень `origin` — в редакции `40` §4.2,
пятнадцать значений, и он один на всю базу (В-6).

```sql
alter table media_assets
  rename column uploaded_by to owner_user_id;   -- чей файл по смыслу, §7.1 (В-4)
alter table media_assets
  rename column checksum to checksum_sha256;    -- была мёртвой колонкой, теперь под дедупликацию
alter table media_assets
  add column origin text not null default 'other',
  add column course_id uuid references courses(id) on delete set null,
  add column stage_code text,                   -- ключ разбивки = код этапа (В-10), снимок при создании
  add column enrollment_id uuid references enrollments(id) on delete set null,
  add column source_entity text, add column source_id uuid,  -- полиморфная мягкая ссылка, без FK
  add column lifecycle text not null default 'active', add column is_evidence boolean not null default false,
  add column retention_until timestamptz, add column orphaned_at timestamptz, add column purge_after timestamptz,
  add column deleted_by uuid references users(id) on delete set null, add column delete_reason text,
  add column last_accessed_at timestamptz,
  add constraint media_assets_origin_chk check (origin in ( -- перечень `40` §4.2 целиком, 15 значений
    'content_cover','lesson_attachment','workshop_submission','video_answer','candidate_cv','certificate',
    'import','checklist_photo','avatar','brand_asset','ai_artifact','report_export',
    'interview_answer','person_document','other')),
  add constraint media_assets_lifecycle_chk check (lifecycle in ('active','orphaned','pending_delete','purged')),
  add constraint media_assets_purge_chk check (
    lifecycle <> 'pending_delete' or (deleted_at is not null and purge_after is not null)),
  add constraint media_assets_stage_code_chk check (stage_code is null or stage_code in (
    'recruiting','onboarding','integration','training','attestation','psychological','knowledge','offboarding'));
-- FK владельца пересоздаётся с `on delete set null`: §13 к. 6 требует, чтобы удаление человека
-- не упиралось в его файлы, а оставляло видеоответ с пустым owner_user_id
create index idx_media_assets_tenant on media_assets (tenant_id, lifecycle, origin);
create index idx_media_assets_tenant_created on media_assets (tenant_id, created_at desc);
create index idx_media_assets_tenant_owner on media_assets (tenant_id, owner_user_id, created_at desc);
create index idx_media_assets_tenant_course on media_assets (tenant_id, course_id);
create index idx_media_assets_tenant_stage on media_assets (tenant_id, stage_code);
create index idx_media_assets_tenant_checksum on media_assets (tenant_id, checksum_sha256, bytes) where checksum_sha256 is not null;
create index idx_media_assets_tenant_retention on media_assets (tenant_id, retention_until) where lifecycle = 'active';
create index idx_media_assets_tenant_purge on media_assets (tenant_id, purge_after) where lifecycle = 'pending_delete';
```

### 3.3 Новые таблицы: агрегаты, политики, операционные

`storage_usage_counters` — оперативный счётчик для экрана и проверки квоты; `storage_usage_daily` — суточный срез для биллинга и
графика. Ключ с `unique nulls not distinct` (Postgres 15+) обязателен: файлы вне курса имеют `category_id is null` и должны
складываться в одну строку, а не в N неразличимых. Поля политики хранения с умолчаниями и валидацией:

| Поле | Тип | Обяз. | По умолчанию | Валидация | Комментарий |
| --- | --- | :-: | --- | --- | --- |
| `origin` | text | ✓ | | из списка §3.2 | одна политика на происхождение |
| `enabled` | boolean | ✓ | `false` | | у нового тенанта выключено всё |
| `keep_months` | int | — | см. §7.3 | 1–120 | ошибка «Від 1 до 120 місяців» |
| `anchor` | text | ✓ | `graded_at` | `created_at` \| `graded_at` \| `last_accessed_at` | точка отсчёта |
| `action` | text | ✓ | `soft_delete` | `soft_delete` \| `purge` \| `notify_only` | |
| `keep_evidence` | boolean | ✓ | `true` | | не трогать `is_evidence=true` |
| `warn_days_before` / `max_batch_per_run` | int | ✓ | 14 / 500 | 0–90 / 1–5000 | предупредить заранее; не снести всё разом |

```sql
create table storage_usage_counters (
  tenant_id uuid not null references tenants(id) on delete cascade, origin text not null,
  category_id uuid references course_categories(id) on delete set null,
  bytes bigint not null default 0 check (bytes >= 0), files_count int not null default 0, updated_at timestamptz not null default now(),
  constraint storage_usage_counters_pk unique nulls not distinct (tenant_id, origin, category_id));
create index idx_storage_usage_counters_tenant on storage_usage_counters (tenant_id);
create table storage_usage_daily (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  day date not null, origin text not null, bytes bigint not null, files_count int not null, category_id uuid references course_categories(id) on delete set null,
  counter_bytes bigint, drift_bytes bigint not null default 0,  -- drift = counter_bytes - bytes
  collected_at timestamptz not null default now(),
  constraint storage_usage_daily_uq unique nulls not distinct (tenant_id, day, origin, category_id));
create index idx_storage_usage_daily_tenant on storage_usage_daily (tenant_id, day desc);
create table storage_retention_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  origin text not null, enabled boolean not null default false, keep_months int check (keep_months between 1 and 120),
  anchor text not null default 'graded_at', action text not null default 'soft_delete',
  keep_evidence boolean not null default true, warn_days_before int not null default 14, max_batch_per_run int not null default 500,
  updated_by uuid references users(id), updated_at timestamptz not null default now(),
  unique (tenant_id, origin));
create index idx_storage_retention_policies_tenant on storage_retention_policies (tenant_id, enabled);
create table storage_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  requested_by uuid not null references users(id),
  mode text not null default 'selection',  -- selection | filter | retention | orphan
  filter jsonb not null default '{}', media_ids uuid[] not null default '{}',  -- снимок фильтров экрана
  planned_files int not null default 0, planned_bytes bigint not null default 0, evidence_count int not null default 0,
  confirm_phrase text,                     -- что админ ввёл руками, §6.1
  status text not null default 'draft',    -- draft|confirmed|running|done|cancelled|failed
  confirmed_at timestamptz, finished_at timestamptz, skipped jsonb not null default '[]',  -- [{media_id, reason}]
  deleted_files int not null default 0, deleted_bytes bigint not null default 0, created_at timestamptz not null default now());
create index idx_storage_deletion_requests_tenant on storage_deletion_requests (tenant_id, status, created_at desc);
-- [решение] Отдельной таблицы докупленного объёма НЕТ. Аддоны — предмет биллинга, и их
-- владелец — `docs/v2/35-billing-limits.md` (`plan_addons` — каталог платформы, `tenant_addons` —
-- подключённые тенантом). Два независимых механизма докупки (свой здесь и свой в `35`) дают
-- две несовпадающие формулы эффективной квоты и неизбежное расхождение счёта с фактом.
-- Эффективная квота хранилища считается так (единственная формула в продукте):
--   quota_bytes = plans.limits->>'storage_bytes'
--               + сумма tenant_addons.qty * plan_addons.unit_bytes
--                 по addon_code = 'storage_pack' со status='active' на дату расчёта.
-- См. `docs/v2/40-data-model-delta.md` §9, пункт Р-6.
create table storage_pending_uploads (     -- работа сотрудника, не поместившаяся в квоту, §7.5
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  enrollment_id uuid references enrollments(id) on delete cascade,
  source_entity text not null, source_id uuid, origin text not null, declared_bytes bigint not null, attempts int not null default 0,
  client_ref text not null,                -- ключ записи в OPFS/IndexedDB на устройстве
  status text not null default 'waiting', last_error text,   -- waiting | uploading | done | abandoned
  expires_at timestamptz not null, created_at timestamptz not null default now(),
  unique (tenant_id, user_id, client_ref));
create index idx_storage_pending_uploads_tenant on storage_pending_uploads (tenant_id, status, expires_at);
```

Эффективный лимит тенанта (единственная формула в продукте, владелец — `docs/v2/35-billing-limits.md`):

```
quota_bytes = (plans.limits ->> 'storage_bytes')::bigint
            + coalesce((tenant_limits.overrides ->> 'storage_bytes')::bigint, 0)
            + coalesce(sum(tenant_addons.qty * plan_addons.unit_bytes)
                       filter (where plan_addons.addon_code = 'storage_pack'
                               and tenant_addons.status = 'active'), 0)
```

Персональное переопределение лимита оператором живёт в `tenant_limits.overrides` (jsonb) —
отдельной колонки `tenant_limits.storage_bytes` в продукте нет и заводить её не нужно.

## 4. Состояния и переходы

**Файл (`media_assets.lifecycle`):** `active → orphaned` (потерял родителя, §7.6) · `active | orphaned → pending_delete`
(soft-delete: `deleted_at=now()`, `purge_after=now()+30d`) · `pending_delete → active` (восстановление) · `pending_delete → purged`
(объект удалён из S3). `purged` терминально: строка `media_assets` не удаляется никогда, на неё ссылаются `audit_log` и
`workshop_submissions.files`, интерфейс показывает «Файл видалено {дата}, {хто}». **Заявка на удаление:** `draft → confirmed →
running → done`, ветки `cancelled` (до подтверждения) и `failed` (S3 недоступен; повтор не переудаляет удалённое). **Отложенная
загрузка:** `waiting → uploading → done`, ветка `abandoned` по `expires_at`.

## 5. Экраны

### 5.1 `/storage` — «Сховище»

Заголовок «Сховище», справа кнопка **«Збільшити сховище»** (скоуп `storage.addon`). **Сводка:** «Використовується: 12.4 Gb / 100 Gb»
+ полоса (бирюза до 80 %, солнце 80–95 %, коралл выше 95 %), ниже «Оновлено щойно» и мелким «Дані для рахунку зібрано {дата зрізу}»
(§7.4). **Разбивка** — горизонтальные бары по убыванию, переключатель режима: **«За походженням»** (по умолчанию, 15 значений
`origin` из §3.2 с украинскими подписями — «Відео-відповіді», «Вкладення уроків», «Резюме кандидатів» и далее по списку) и **«За
етапом»** (решение В-10: девять ключей — восемь кодов `lifecycle_stages` + `other`; подписи берутся из `lifecycle_stages.name_uk`,
тенант правит подписи, но не ключи). Первый режим существует ровно для того, чтобы «Інше» не было самой большой колонкой (§7.1).

**Фильтры:** «Походження» (multi), «Категорія», «Вибрати період» (по `created_at`), «Трек», «Співробітник», «Статус» («Активні» / «У
кошику» / «Осиротілі»), «Тільки докази» (toggle). **Таблица**, курсор по 50: чекбокс · **Файл** (`original_name`, иначе `kind` +
расширение, превью для image/video) · **Походження** · **Співробітник** · **Трек** · **Дата** · **Розмір файлу** · замок «доказ» ·
«…» (скачать, открыть источник, удалить). При выделении внизу «Обрано {n} файлів · {size}» и кнопка **«Видалити»** (коралл). Пустое:
«У сховищі поки немає файлів»; загрузка — скелет из 8 строк, сводка показывает последний известный счётчик; ошибка — «Не вдалося
завантажити список файлів» + «Спробувати ще раз». `manager` видит тот же экран без сводки и без докупки, список сужен до файлов
сотрудников своих точек.

### 5.2 `/storage/trash` — «Кошик» и `/storage/policies` — «Політики зберігання»

«Кошик»: те же колонки + «Видалено» (дата и кто) + «Буде очищено» (обратный отсчёт), кнопки «Відновити» и «Очистити зараз» (только
`admin`, с подтверждением); пустое — «Кошик порожній. Видалені файли зберігаються тут 30 днів». «Політики зберігання»: строка на
происхождение с полями формы §6.2, справа «Буде звільнено приблизно {size}» (сухой прогон), внизу «Зберегти» и «Зробити сухий
прогон»; пустого состояния нет, список происхождений фиксирован; ошибка прогона — «Не вдалося порахувати обсяг», при ней «Зберегти»
блокируется.

## 6. Формы

### 6.1 Подтверждение удаления (модальное)

| Контрол | Подсказка | Валидация | Текст ошибки |
| --- | --- | --- | --- |
| Плашка | «Серед них {k} файлів є доказом проходження. Їх видалення прибере підставу для виставлених оцінок.» | при `k>0` | — |
| «Причина» | «Навіщо видаляєте» | обязательна при `k>0`, 10–500 | «Вкажіть причину: від 10 до 500 символів» |
| Подтверждение | «Введіть ВИДАЛИТИ, щоб підтвердити» | точное совпадение, при `k>0` | «Введіть слово ВИДАЛИТИ великими літерами» |
| Чекбокс, кнопки | «Розумію, що файли можна відновити протягом 30 днів»; «Скасувати» / «Видалити» | обязателен | «Підтвердьте, що ознайомились» |

### 6.2 «Збільшити сховище» и политика хранения

Докупка: пресеты (+50 / +100 / +250 / +500 Gb), цена за месяц из `35`, срок («до кінця періоду тарифу» / «помісячно до скасування»),
итог «Новий ліміт: {X} Gb»; сумма аддонов не больше десятикратного лимита плана — «Зверніться до підтримки для індивідуального
ліміту». Политика хранения: «Увімкнено», «Зберігати» (число + «місяців», 1–120, ошибка «Від 1 до 120 місяців»), «Рахувати від»
(`anchor`), «Дія» (`action`), «Не чіпати докази», «Попередити за» (0–90 дней); при `action='purge'` — плашка «Файли будуть видалені
без кошика, відновити не вийде»; при `keep_evidence=false` — чекбокс «Розумію, що буде видалено підтвердження оцінок».

## 7. Правила и алгоритмы

### 7.1 Классификация файла: почему на эталоне «Інше» больше всех

На эталоне разбивка сделана по **категории трека**, а файл привязан к треку только когда загружен внутри него. Видеоответ, резюме,
сертификат, обложка, импорт — всё, что родилось рядом с треком, а не внутри, падает в «Інше»: 4.74 Gb из 5.27 Gb, то есть 90 %.
Категория трека — свойство *курса*, а не *файла*, и как ось отчёта по файлам она неверна по построению.

1. Основная ось — `media_assets.origin`, задаётся **при выдаче presigned URL**, а не вычисляется потом: клиент обязан передать
   `origin`, `source_entity`, `source_id`, сервер валидирует zod-схемой и отказывает `400 origin_required`. `origin='other'`
   допустим только для загрузок через публичный API-токен тенанта; доля `other` выше 5 % объёма — дефект, алерт оператору платформы.
   `stage_code` заполняется производно от `course_id` при создании (`courses.lifecycle_stage_id → code`, решение В-10) и
   **не пересчитывается** при смене этапа у курса: разбивка должна быть стабильна во времени. Файл вне курса ключа не получает
   и попадает в девятый ключ `other`. Миграция — `storage.classify_backfill`: `origin` выводится обратным поиском по ссылкам,
   остальное получает `other` и попадает в отчёт «Не вдалося класифікувати: {n} файлів». `[PR-11/12: origin задаётся на
   единственном входе загрузки; backfill уже загруженных файлов — PR-36 вместе с экраном и сводкой]`
2. **Признак доказательства** `is_evidence=true` выставляется автоматически: `video_answer` и `workshop_submission` — при сдаче в
   статусе `accepted` или `rejected` (по файлу принято решение человеком); `checklist_photo` — при завершённом прогоне;
   `certificate` — всегда; `candidate_cv` — при решении о найме или отказе. Снимается, когда исчезает основание: сдача отозвана,
   прогон отменён.

### 7.2 Правила удаления

1. **Запрещено вовсе** (`403 file_not_deletable`, кнопка неактивна с подсказкой): `certificate`; файлы со ссылкой из `audit_log` за
   последние 12 месяцев; файлы сдачи в статусе `review` или `reworking` (проверка идёт сейчас); файлы попытки с открытой апелляцией.
2. **С подтверждением** (форма §6.1: причина + фраза «ВИДАЛИТИ»): всё с `is_evidence=true`, и только ролью `admin`. **Обычное**
   (одно подтверждение): всё остальное с `is_evidence=false`.
3. Любое удаление — **soft-delete**: `lifecycle='pending_delete'`, `deleted_at=now()`, `purge_after=now()+30 days`, объект в S3
   остаётся, восстановление в один клик. Физическое удаление выполняет только `storage.purge`. Счётчик уменьшается **в момент
   soft-delete**, а не при purge: тенант платит за то, чем распоряжается, корзина не должна держать квоту заложником.
4. В `audit_log` пишутся `media.delete` (before — вся строка `media_assets`, after — `{lifecycle, deleted_at,
   delete_reason}`; имя события — по решению В-17, вместе с именем ручки `DELETE /media/:id`, а не `storage.file.delete`:
   у одного действия одно имя), `storage.file.restore`, `storage.file.purge`, `storage.bulk_delete` (entity — `storage_deletion_requests`,
   after — счётчики и пропущенные), `storage.policy.update`, `storage.addon.activate`, `storage.counter_drift`; массовое удаление —
   одна запись на заявку, пофайловый состав лежит в самой заявке. Удаление файла **никогда не меняет запись прохождения**: сдача
   остаётся, оценка остаётся, вместо превью — «Файл видалено {дата}».

### 7.3 Значения политик хранения по умолчанию

| Происхождение | Хранить | От чего | Действие | Обоснование |
| --- | --- | --- | --- | --- |
| `video_answer`, `workshop_submission` | 12 мес. | `graded_at` | soft_delete | цикл переаттестации годовой (`14`): до следующей аттестации файл — действующее доказательство, после его заменяет новый результат |
| `checklist_photo` | 12 мес. | `created_at` | soft_delete | годовой разрез нужен отчёту «динаміка по точках» (`20` §9) |
| `candidate_cv` | 6 мес. | `created_at` | soft_delete | сцеплено с авто-архивацией отклонённых кандидатов; дольше хранить чужие ПД без основания нельзя |
| `ai_artifact` \| `other` | 12 \| 6 мес. | `created_at` \| `last_accessed_at` | soft_delete | 3Д-резюме переживает найм, но не бессрочно; для неклассифицированного единственный разумный критерий — «им никто не пользуется» |
| `import` / `report_export` | 3 мес. / 30 дн. | `created_at` | purge | исходник импорта нужен для разбора ошибок загрузки, выгрузка одноразова и пересобирается |
| `certificate` \| `content_cover`, `lesson_attachment`, `brand_asset`, `avatar` | — | — | notify_only \| выключено | сертификат не удаляется никогда (§7.2.1); остальные живут вместе с контентом, чистит только осиротение (§7.6) |

Сверх политик `storage.retention_scan` чистит два класса мусора: черновик сдачи (`workshop_submissions.status='draft'`) с файлами
старше **30 дней** удаляется вместе с файлами; незавершённая загрузка (`status='uploaded'` без ссылки на источник) старше **24
часов** уходит сразу в `purge`. Все политики **выключены у нового тенанта**; первое включение требует сухого прогона и подтверждения
объёма — молча удалять доказательства при запуске функции нельзя.

### 7.4 Подсчёт потребления: счётчик и суточный срез

`25` §10 фиксирует сбор раз в сутки, но экрану суточная цифра не годится: администратор удалил 3 Gb и обязан увидеть результат
немедленно. Совмещаем так:

1. **Оперативный счётчик.** Триггер `storage_counter_apply` на `media_assets` в той же транзакции меняет `storage_usage_counters`:
   `+bytes` при переходе в `active`, `−bytes` при переходе в `pending_delete`, перенос между строками при смене
   `origin`/`category_id`. Экран и проверка квоты читают только его: один `update` по составному ключу, конкуренции почти нет —
   ключей столько же, сколько происхождений.
2. **Суточный срез и расхождение.** `usage.collect` (00:00 по таймзоне тенанта) вызывает `storage.counter_reconcile`: полный
   пересчёт `sum(bytes) group by origin, category_id where lifecycle in ('active','orphaned')`, запись в `storage_usage_daily` и
   `tenant_usage.storage_bytes`, расчёт `drift_bytes = counter − sum`. `|drift| ≤ 10 MB` — нормальная гонка, счётчик молча
   выравнивается; больше 10 MB или 0.5 % — выравнивается, пишется `storage.counter_drift` в `audit_log` и уходит алерт оператору:
   дрейф означает путь записи мимо триггера, то есть дефект кода. Ежемесячный `storage.object_reconcile` листает префикс
   `t/<tenant_id>/`: объект без строки → `origin='other'`, `lifecycle='orphaned'`; строка без объекта → `purged`.
3. **Что идёт в счёт.** Засчитываются `active` и `orphaned`, не засчитываются `pending_delete` и `purged`. Биллинг берёт **максимум
   суточных срезов за расчётный период**, а не значение на дату счёта: иначе тенант чистит хранилище накануне счёта и платит не за
   тот пик, которым пользовался месяц.

### 7.5 Исчерпание лимита: что видит сотрудник, и докупка объёма

Квота проверяется при запросе presigned URL по оперативному счётчику. Жёсткий порог — `used + declared_bytes > limit + grace`, где
`grace` `[решение]` = 2 % лимита или 1 Gb (что меньше): буфер нужен, чтобы уже начатые загрузки досылались, а не рвались.

1. При **открытии** задания с видеоответом клиент вызывает `POST /storage/upload-intent` с оценкой размера. Квоты нет — над кнопкой
   записи коралловая плашка: «Сховище компанії заповнене. Запис збережеться на пристрої й відправиться автоматично, коли
   адміністратор звільнить місце.» Кнопка записи **остаётся активной**, запись сохраняется на устройстве (OPFS, иначе IndexedDB),
   создаётся `storage_pending_uploads` (`waiting`, `expires_at = now() + 14 днів`).
2. Сдача переводится в `submitted` с флагом `pending_upload`. **Дедлайн считается выполненным по времени записи**, а не успешной
   загрузки: сотрудник не отвечает за квоту работодателя. В очереди проверки строка видна с меткой «Очікує вивантаження», взять её
   ментор не может; сотруднику — «Відповідь збережено. Файл відправиться, щойно з'явиться місце», повторно записывать не нужно и
   нельзя.
3. Администратору уходит `storage_upload_blocked` с числом ожидающих файлов и их объёмом. `storage.pending_upload_retry` (каждые 15
   минут) выдаёт presigned URL ожидающим FIFO: при успехе `done`, сдача теряет `pending_upload` и попадает к ментору; по
   `expires_at` — `abandoned`, уведомление обоим, сдача остаётся зачтённой с пометкой «Файл втрачено»: это вина тенанта, не
   сотрудника. Не блокируется ничего из обучения: уроки, тесты, текстовые ответы, чтение, назначения, выдача сертификатов. Мягкие
   пороги: 80 % — раз в неделю, 95 % — ежедневно, 100 % — немедленно.
4. **Докупка.** Аддон — отдельная биллингуемая позиция поверх тарифа, не смена тарифа (`35` §4). После оплаты `status='active'`,
   лимит пересчитывается сразу, `storage.pending_upload_retry` запускается внеочередно. При неоплате следующего месяца аддон
   `expired`; если потребление выше лимита — **файлы не удаляются**, действует только блокировка загрузок, администратору уходит
   `storage_quota_exceeded` с предложением включить политику хранения. Автоматического удаления за неуплату нет ни в одном сценарии.

### 7.6 Осиротевшие файлы

1. **Удалён курс.** Курс в Lola архивируется, а не удаляется (`10`), его файлы остаются `active`. При явной вычистке архива они
   получают `lifecycle='orphaned'`, `orphaned_at=now()`; сирота из курса живёт **90 дней** и уходит в `pending_delete`.
2. **Удалён сотрудник.** Человек блокируется, а не удаляется (`25` §10); физическое удаление профиля возможно только по запросу на
   стирание персональных данных. Тогда `avatar` и `candidate_cv` удаляются немедленно (`purge`, это и есть требование запроса), а
   файлы-доказательства **обезличиваются**: `owner_user_id=null`, `original_name` затирается, в реестре остаётся «Співробітника
   видалено». Результат обучения — собственность работодателя, персональные данные — нет, и это разные вещи.
3. **Файл без ссылок.** `storage.orphan_scan` ежедневно ищет `active`-файлы старше 7 дней, на которые нет ссылок ни из
   `lessons.body`, ни из `workshop_submissions.files`, ни из `checklist_runs.answers`, ни из `courses.cover_key`, ни из
   `certificates` → `orphaned`. Автоматически они не удаляются: появляется фильтр «Осиротілі» и строка «Знайдено {n} файлів без
   власника, {size}», решение принимает администратор. Осиротевший файл считается в квоте, пока не удалён, — иначе появляется способ
   хранить бесплатно.

## 8. Уведомления

| Код | Событие | Канал | Шаблон | Кому |
| --- | --- | --- | --- | --- |
| `storage_quota_80` \| `_95` \| `_exceeded` | 80 % еженедельно, 95 % ежедневно, 100 % немедленно | in-app, email, Telegram (с 95 %) | «Сховище заповнене на {pct}%. Використано {used} із {limit}.» → «Сховище заповнене. Завантаження файлів зупинено, навчання триває.» | admin |
| `storage_upload_blocked` \| `storage_upload_deferred` | появилась отложенная загрузка \| запись сохранена локально | in-app, Telegram | «{n} відповідей співробітників очікують вивантаження ({size}).» \| «Відповідь збережено. Файл відправиться автоматично.» | admin \| сотруднику |
| `storage_pending_upload_done` \| `_expired` | файл дослан \| истёк срок 14 дней | in-app, email | «Ваш файл до завдання «{task}» відправлено.» \| «…не вдалося відправити за 14 днів.» | сотруднику, admin |
| `storage_retention_warning` \| `_done` | за `warn_days_before` \| политика отработала | email, in-app | «Через {days} днів політика видалить {n} файлів ({size}).» \| «Звільнено {size}, видалено {n} файлів.» | admin |
| `storage_bulk_delete_done` \| `storage_orphans_found` \| `storage_addon_activated` | заявка выполнена \| сирот больше 1 Gb \| аддон оплачен | in-app, email | «Видалено {n} файлів, звільнено {size}. Пропущено: {skipped}.» \| «Знайдено {n} файлів без власника: {size}.» \| «Ліміт сховища збільшено до {limit}.» | инициатору, admin |

`storage.counter_drift` уведомлением тенанту не является: это внутренний алерт оператору платформы.

## 9. Отчёты и выгрузки

**«Сховище: файли»** (xlsx/csv): Файл · Походження · Категорія · Трек · Співробітник · Точка · Дата створення · Дата останнього
доступу · Розмір (bytes) · Доказ · Статус · Дата видалення · Хто видалив · Причина; фильтры повторяют экран, больше 50 000 строк —
фоновой задачей (`25` §10). **«Динаміка сховища»** из `storage_usage_daily`: день · происхождение · объём · число файлов, график за
30/90/365 дней стопкой, колонка `drift_bytes` видна только `admin` и оператору. **«Журнал видалень»** из `audit_log` по действиям
`media.delete`, `media.download` и `storage.*`: дата · кто · действие · число файлов · объём · причина · заявка — это и есть ответ
на вопрос «кто снёс доказательства за прошлый квартал». Выдача ссылки на файл-доказательство пишется событием `media.download`
(В-19) — **только** для `is_evidence = true`: обложка курса скачивается при каждом открытии урока и утопила бы журнал в шуме.

## 10. API

| Метод | Путь | Вход | Выход | Ошибки |
| --- | --- | --- | --- | --- |
| GET | `/storage/summary` | `groupBy=origin\|category` | `{usedBytes, limitBytes, graceBytes, breakdown[], collectedAt, driftBytes}` | 403 |
| GET | `/storage/files`, `/storage/trash`, `/storage/pending-uploads` | фильтры, `cursor`, `limit≤100` | `{data[], nextCursor}` | 403 |
| GET | `/storage/files/:id`, `…/download` | | карточка + ссылки на источник; 302 на presigned URL, 10 минут (доказательство — 120 с, В-19) | 404, 403, 410 `file_purged` |
| POST | `/media/upload-url` | `{origin, sourceEntity?, sourceId?, courseId?, enrollmentId?, bytes, mime, filename}` | `{uploadUrl, mediaId}` | 400 `origin_required`, 400 `media.too_big`, 400 `media.storage_limit` |
| DELETE | `/media/:id` | `{reason?, confirmPhrase?}` | `{lifecycle, purgeAfter}` | 403 `file_not_deletable`, 409 `evidence_locked`, 409 `already_deleted` |
| POST | `/storage/files/:id/restore` | | `{lifecycle:'active'}` | 409 `already_purged` |
| POST | `/storage/deletions` \| `/:id/confirm` \| `/:id/cancel` | `{mode, filter?, mediaIds?}` \| `{reason, confirmPhrase}` | `{id, plannedFiles, plannedBytes, evidenceCount}` \| `{status}` | 400, 409, 422 `confirm_phrase_mismatch` |
| GET/PUT | `/storage/retention-policies`, `…/dry-run` | массив политик \| `{origin}` | то же \| `{files, bytes, evidenceCount}` | 422 |
| GET/POST | `/storage/addons` | `{extraBytes, term}` | `{id, status, priceMinor, checkoutUrl}` | 402, 422 `addon_limit` |
| GET | `/reports/storage` | фильтры, `format` | файл или `{jobId}` | 403 |

Все мутации идемпотентны по `Idempotency-Key`; чужой тенант — `404`, не `403` (`25` §3).

## 11. Фоновые задачи

| Задача | Расписание | Что делает |
| --- | --- | --- |
| `storage.counter_reconcile` | 00:00, внутри `usage.collect` | пересчёт, срез, `tenant_usage.storage_bytes`, дрейф |
| `storage.retention_scan` \| `storage.orphan_scan` \| `storage.purge` | 03:00 \| 03:30 \| 04:00 ежедневно | политики партиями `max_batch_per_run` \| файлы без ссылок старше 7 дней \| удаление из S3 всего с `purge_after < now()` |
| `storage.bulk_delete` \| `storage.pending_upload_retry` | по событию \| каждые 15 минут и при освобождении места | заявка партиями по 200 файлов \| дослать отложенные FIFO |
| `storage.object_reconcile` \| `storage.quota_warn` | 1-го числа месяца \| 08:00 ежедневно | сверка с бакетом \| пороги 80/95/100 % |
| `storage.classify_backfill` | однократно при миграции | проставляет `origin` существующим файлам |

## 12. Крайние случаи

- Два администратора удаляют одну выборку одновременно → второй получает в `skipped` записи с `reason='already_deleted'`, счётчик
  уменьшается один раз (`update … where lifecycle='active'`). Администратор удаляет видео, по которому ментор прямо сейчас ставит
  оценку → `409 under_review`.
- Файл восстановлен из корзины, а квота уже занята → восстановление разрешается сверх лимита (возврат оплаченного объёма), тенант
  переходит в «превышение»: загрузки блокируются, обучение идёт. Политика с `keep_months=1` на `video_answer` → сухой прогон
  покажет, что удаляется почти всё, без подтверждения объёма задача не запустится.
- Транскодинг упал, `status='failed'` → файл считается в квоте до `purge`, виден фильтром «Помилка обробки», чистится через 24 часа.
  S3 недоступен при `purge` → заявка `failed`, `purge_after` сдвигается на сутки, строка остаётся `pending_delete`, повтор не
  создаёт дублей. Тенант приостановлен (`25` §8) → `/storage` читается, удаление и докупка запрещены, retention не выполняется:
  нельзя чистить данные у клиента, который не может возразить.
- Сотрудник записал видео офлайн и уволился до появления связи → `pending_upload` доживает до `expires_at` и становится `abandoned`,
  сдача остаётся зачтённой. Один файл приложен к двум сдачам (пересдача) → одна строка `media_assets`, удаление блокируется, пока
  жива хотя бы одна ссылка. Дрейф счётчика 3 Gb за сутки → выравнивание ночным пересчётом, алерт оператору; биллинг берёт значение
  пересчёта, не счётчика.

## 13. Критерии приёмки

1. **Дано** задание с видеоответом и исчерпанная квота, **коли** сотрудник записывает ответ, **тоді** запись сохраняется на
   устройстве, сдача получает «Очікує вивантаження», дедлайн зачтён по времени записи, администратору уходит
   `storage_upload_blocked`; **коли** администратор докупил объём, **тоді** в течение 15 минут файл в S3, сдача в очереди ментора,
   сотрудник получил `storage_pending_upload_done`.
2. **Дано** видеоответ с выставленной оценкой, **коли** администратор жмёт «Видалити», **тоді** требуются причина и слово
   «ВИДАЛИТИ», без них удаление не выполняется.
3. **Дано** удалённый файл, **коли** прошло 29 дней, **тоді** он восстанавливается и снова считается в квоте; **коли** прошёл 31
   день, **тоді** объекта в S3 нет, строка `purged`, сдача показывает «Файл видалено».
4. **Дано** сертификат в выборке массового удаления, **тоді** он пропускается с `reason='not_deletable'`; **дано** тенант с файлами
   всех происхождений, **тоді** доля `origin='other'` на экране не превышает 5 % объёма.
5. **Дано** загружен и удалён файл на 1 Gb в течение часа, **коли** открыта сводка, **тоді** она показывает исходное значение, не
   дожидаясь ночного пересчёта; **дано** ночной пересчёт разошёлся со счётчиком на 50 MB, **тоді** счётчик выровнен по пересчёту и
   `storage.counter_drift` записан в `audit_log`.
6. **Дано** сотрудник удалён по запросу на стирание ПД, **тоді** его аватар и резюме отсутствуют, а видеоответы присутствуют с
   пустым `owner_user_id` и подписью «Співробітника видалено».
7. **Дано** аддон не оплачен и потребление выше базового лимита, **коли** наступил следующий период, **тоді** ни один файл не
   удалён, загрузки заблокированы, обучение доступно полностью.

## 14. Сверено с эталоном

Проверено 19.09.2026, `/storage` и `/payment` (`(зовнішній пакет аудиту Sintegrum)/docs/10-settings.md` §10.7, `08-payment.md` §8.1).
**Экран `/storage`:** заголовок «Сховище»; кнопка **«Збільшити сховище»** — прямое подтверждение того, что объём из тарифа
расширяется отдельной опцией, а не переходом на другой тариф (отсюда аддон `storage_pack` в `docs/35` и §7.5); сводка **«Використовується:
5.27 Gb / 100 Gb»** — формат переносим дословно; разбивка по категориям треков Рекрутинг · Інтеграція · Онбординг · Офбординг ·
Атестація · **Інше**, где «Інше» — 4.74 Gb из 5.27 Gb; фильтры «Категорія» и «Вибрати період»; кнопка **«Видалити»**; таблица на 172
файла с колонками **Файл · Співробітник · Трек · Дата · Розмір файлу**. Имена файлов — UUID-подобные `.mp4`, «Трек» — конкретные
онбординг-треки должностей: хранилище состоит в основном из видеоответов сотрудников. Взято дословно: состав колонок, оба фильтра,
формат сводки, обе кнопки. Добавлено `[решение]`: переключатель разбивки «за походженням», фильтры «Походження», «Трек»,
«Співробітник», «Статус», «Тільки докази», колонка «Походження», корзина, политики хранения, признак доказательства, отложенные
загрузки. **Лимит в тарифе:** «Сховище» — одна из четырёх строк лимита рядом со «Співробітників», «Кандидатів» и «Треків», **100 Gb
на всех девяти тарифах** без роста по тиру; отсюда для Lola лимит хранилища — самостоятельная ось тарификации (не производная от
числа людей), расширяется он аддоном, иначе кнопка «Збільшити сховище» бессмысленна при одинаковых 100 Gb. **Чего на эталоне нет:**
корзины, политик хранения, признака доказательства, предупреждений о заполнении, разбивки по происхождению и любого следа того, что
происходит при исчерпании 100 Gb; массовое удаление — кнопка без видимого подтверждения. Всё это наше добавление, §7.2–§7.6.

## 15. Гипотезы и принятые по ним решения

**Г-34.1 Что попадает в «Інше».** *Гипотеза:* 90 % объёма — видеоответы без привязки к категории трека, плюс резюме кандидатов
(`progress-item/cv-list` из API эталона) и служебные файлы контента. *Чем проверяется:* загрузить на эталоне файл известного типа
внутрь трека известной категории и посмотреть, в какую колонку он попал. *Решение `[решение]`:* основная ось — `origin` при выдаче
presigned URL (§7.1), категория трека — второй режим разбивки.

**Г-34.2 Подтверждение массового удаления.** *Гипотеза:* кнопка «Видалити» удаляет выбранное без подтверждения — диалога не
зафиксировано, но выборка была пуста. *Чем проверяется:* выделить один файл и нажать «Видалити». *Решение `[решение]`:* независимо
от эталона — двухуровневое подтверждение (§6.1) и soft-delete на 30 дней: удаление видеоответа с оценкой одним кликом есть
уничтожение доказательной базы, копировать такое нельзя.

**Г-34.3 Единица тарификации объёма.** *Гипотеза:* 100 Gb одинаковы на всех девяти тарифах — возможно, неполнота аудита. *Чем
проверяется:* открыть карточку старшего тарифа и сверить строку «Сховище». *Решение `[решение]`:* базовый объём **растёт по тиру**
(10 / 100 / 500 Gb, как в `25` §10), аддон поверх любого тира: расход места линеен по числу сотрудников, сдающих видео, а число
сотрудников и есть ось тарифа.

**Г-34.4 Срок хранения видеоответов.** *Гипотеза:* на эталоне срок не настраивается, файлы копятся бессрочно — косвенно
подтверждается тем, что 172 файла занимают 90 % квоты без признаков чистки. *Чем проверяется:* найти в настройках эталона любое поле
со сроком хранения файлов. *Решение `[решение]`:* 12 месяцев от даты оценки, политика выключена по умолчанию, включение требует
сухого прогона (§7.3).

**Г-34.5 Поведение при 100 %.** *Гипотеза:* эталон показывает баннер «Незабаром буде досягнуто ліміту» (`08-payment.md` Г-08.3), но
что происходит после достижения — не снято. *Чем проверяется:* довести тестовый тенант эталона до лимита. *Решение `[решение]`:*
§7.5 целиком — блокируется выдача presigned URL, запись хранится на устройстве, сдача засчитывается по времени записи, файл
досылается автоматически; обучение не останавливается.

**Г-34.6 Кто видит `/storage`.** *Гипотеза:* экран лежит в «Налаштуваннях» рядом с тарифом, значит доступен администратору компании;
доступ руководителя точки не проверен. *Чем проверяется:* войти под ролью уровня филиала и открыть `/storage`. *Решение
`[решение]`:* полный экран — `admin`; `manager` получает список файлов своих точек без сводки и без докупки (§2): квота общая на
тенант, повлиять на неё он не может, а чистить чужие доказательства — вполне.
