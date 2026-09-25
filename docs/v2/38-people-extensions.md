# Lola LMS — ТЗ. 38. Карточка человека: активность, заметки, документы, нормы отсутствий

## 1. Назначение и границы

Документ **дополняет** `lola-spec/docs/16-people.md` (профиль, размещения, справочники, импорт, журналы) четырьмя блоками карточки,
снятыми с эталона Sintegrum (`04-employees.md` §4.2, `10-settings.md` §10.1), и пятым — выведенным из находки «колонка «%» со значениями 101 и 102».

**Что добавляется:** (1) **лента активности** «Активність за рік» — тепловая карта обучающей активности по дням; в базовом ТЗ есть
только карта «день × година» за **неделю** в личном профиле (`21` §14.4), здесь — год, чужая карточка, закрытый список событий,
локальный день; (2) **Нотатки** — в базовом ТЗ есть вкладка «Нотатки» (`16` §5.2 п.6) и поле `users.comment`, но **нет модели**: ни
видимости, ни срока хранения, ни ограничений на содержание, ни аудита чтения; (3) **Документи** — отсутствуют в базовом ТЗ вовсе;
(4) **Норми відсутностей** (24 дня отпуска, 5 больничного) с наследованием компания → точка → человек — отсутствуют вовсе;
(5) **рейтинг человека** — в базовом ТЗ есть надпись «Поточний рейтинг: N» (`21` §14.4) без формулы, здесь — формула, потолок,
экран расшифровки и правила показа.

**Что уже есть и здесь не переопределяется:** «Дата народження» = `users.birth_date`, «Дата працевлаштування» = `users.hired_at`
(обе колонки уже в `02` §2.3 — новых полей не нужно); роли и скоупы (`01-roles.md`); группировка назначенного **по этапам
жизненного цикла** — перечень этапов берётся из `docs/v2/33-lifecycle.md`, здесь только правило отрисовки; метрики **«Плановий час» /
«Час проходження»** — алгоритм подсчёта в `docs/v2/37-review-delegation.md`, здесь только место на экране; хранение и удаление файлов —
`docs/v2/34-storage.md`; баллы и бейджи — `21` §3.7, `02` §2.10.

**Не входит:** кадровый учёт, приказы, расчёт зарплаты и табель — см. §7.12, граница обоснована явно; оценка кандидата
(`docs/v2/28-recruiting-candidates.md`); обратная связь по контенту (`docs/v2/36-content-feedback.md`).

## 2. Роли и скоупы

Новые скоупы: `person.activity.view_others`, `person.note.read`, `person.note.write`, `person.document.view_others`,
`person.document.manage`, `person.absence.manage`, `person.rating.view_others`.

| Действие | employee | mentor | manager | hr | author | admin |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| Видеть свою ленту активности, свой рейтинг и расшифровку | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Видеть чужую ленту активности | — | ✓ (свой список проверки, 90 дней) | ✓ (свои точки) | ✓ | — | ✓ |
| Видеть чужой рейтинг и расшифровку | — | — | ✓ (свои точки) | ✓ | — | ✓ |
| Читать заметки о человеке | — | — | ✓ (`visibility='manager'`) | ✓ | — | ✓ |
| Создавать и править свою заметку \| удалять чужую | — | — | ✓ \| — | ✓ \| — | — | ✓ \| ✓ |
| Открыть человеку заметку (`shared_with_person`) | — | — | ✓ | ✓ | — | ✓ |
| Видеть свои документы \| чужие | ✓ \| — | ✓ \| — | ✓ \| ✓ (типы `visible_to_manager`) | ✓ \| ✓ | ✓ \| — | ✓ \| ✓ |
| Загружать документ себе \| другому, править срок | ✓ (типы `self_upload`) \| — | ✓ \| — | ✓ \| ✓ | ✓ \| ✓ | ✓ \| — | ✓ \| ✓ |
| Править справочник типов документов | — | — | — | ✓ | — | ✓ |
| Видеть норму и остаток отсутствий | ✓ (свои) | — | ✓ (свои точки) | ✓ | — | ✓ |
| Править норму компании \| точки \| человека | — | — | — \| ✓ \| ✓ | ✓ \| ✓ \| ✓ | — | ✓ \| ✓ \| ✓ |
| Вносить факт отсутствия | — | — | ✓ | ✓ | — | ✓ |

Роль `hr` отдельной системной ролью в базовом ТЗ не выделена; здесь под ней понимается носитель скоупов `person.note.*` +
`person.document.manage` + `person.absence.manage` в области тенанта. Новой системной роли не требуется — скоупы навешиваются
на кастомную роль (`02` §2.3, `roles.scopes text[]`).

> [уточнено, PR-34: строка «Видеть чужую ленту активности»] `person.activity.view_others` получает системный
> `manager` (в области своей роли — «свои точки»: роль на точку или подразделение, покрывающая **текущую** точку
> человека; при переводе доступ прежнего руководителя пропадает в тот же день, как у заметок). HR — носитель скоупа
> на весь тенант, `admin` — тоже. **Ментору скоуп не выдаётся** `[решение]` (Р-34.5): его право уже — «свой список
> проверки, 90 дней» — и это право по данным, а не по роли. Проверяющий (`review.grade`) видит ленту человека, пока
> работа этого человека у него в очереди: назначена ему, делегирована ему, эскалирована на него или открыта им
> (`review_queue_items`, статус не `done`); видит последние 90 дней, клетки раньше — приглушены. Скоуп на точку
> открыл бы ментору ленты всей точки на всю глубину. Токен интеграции прав по данным не получает — только скоуп.

## 3. Сущности и поля

### 3.1 `alter table users` — проверка на конфликт с `28-recruiting-candidates.md`

`docs/v2/28-recruiting-candidates.md` §3.2 уже добавляет в `users`: `kind`, `candidate_state`, `candidate_status_id`, `source`,
`source_detail`, `vacancy_id`, `recruiter_id`, `access_until`, `comm_language`, `resume_asset_id`, `hired_at`,
`converted_from_candidate_at`, `consent_given_at`, `consent_expires_at`. **Ни одно из этих имён здесь не переиспользуется.**
Базовое ТЗ (`02` §2.3) уже содержит `birth_date`, `hired_at`, `position_since`, `comment`, `last_seen_at` — «Дата народження»
и «Дата працевлаштування» с эталона ложатся в существующие колонки, добавлять нечего.

> [исправлено фазой 1, `43` §5 Р-2] Ранее: «Конфликт, который надо развести на уровне миграции…
> Верное поведение миграции `28` — не добавлять колонку, а менять тип существующей (`alter
> column hired_at type timestamptz using hired_at::timestamptz`). Фиксируется правкой в `28`».
> Правка в `28` уже сделана до пакета: `users.hired_at` в `main` имеет тип `date`, и `28`
> **не переопределяет** его. Ниже — только констатация, чтобы третий документ не добавил
> колонку в третий раз: `hired_at` остаётся `date`, менять тип не нужно.

```sql
alter table users
  add column rating_pct        numeric(5,1),   -- колонка «%» списка, §7.1; null = не рассчитан
  add column rating_updated_at timestamptz,
  add column timezone          text;           -- override над таймзоной точки, §7.10
create index idx_users_tenant_rating on users (tenant_id, rating_pct desc nulls last)
  where kind = 'employee' and status = 'active';
```

| Поле | Тип | Обяз. | По умолч. | Валидация | Комментарий |
|---|---|:-:|---|---|---|
| `rating_pct` | numeric(5,1) | нет | — | 0…130 | Денормализованный снимок для сортировки списка; источник истины — `person_rating_snapshots` |
| `rating_updated_at` | timestamptz | нет | — | — | Старше 48 ч → цифра серая с подсказкой «Дані оновлюються» |
| `timezone` | text | нет | — | IANA tz | Только для удалённых; иначе берётся из точки (§7.10) |

### 3.2 `alter table media_assets` — новое происхождение файла

`docs/v2/34-storage.md` §3.2 задаёт закрытый `check` по `origin`. Документ человека — новый вид происхождения
(`person_document`).

[решение] Этот документ **не пересоздаёт constraint самостоятельно**. Перечень `origin` — общий узел, который
затрагивают четыре документа (`34` владеет реестром, `30` добавляет `interview_answer`, этот документ добавляет
`person_document`, `28` и `29` используют `candidate_cv`). Самостоятельное пересоздание из любого документа
молча стирает значения, добавленные соседями: порядок применения решает, какие виды файлов выживут.

Поэтому единый итоговый перечень и единственный `alter … drop constraint … add constraint` живут в
`docs/v2/40-data-model-delta.md` §4 и применяются одной отдельной миграцией **после** всех документов пакета.
Здесь фиксируется только требование: значение `person_document` обязано присутствовать в итоговом реестре.

Политика хранения для `person_document` — `notify_only` строкой в таблице `34` §7.3: обязательный документ не удаляется
автоматически никогда, истёкший — тоже, он нужен как доказательство того, что инструктаж когда-то был проведён.

### 3.3 Лента активности

```sql
create table user_activity_events (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null, ref_entity text, ref_id uuid,       -- enrollments | attempts | lessons | ...
  location_id uuid references locations(id),              -- где человек работал в момент события
  tz text not null, local_date date not null,             -- снимок таймзоны и локальный день, §7.10
  seconds_spent int not null default 0,
  occurred_at timestamptz not null default now(),
  constraint user_activity_events_kind_chk check (kind in (
    'lesson_completed','attempt_submitted','attempt_graded','enrollment_started','enrollment_completed',
    'workshop_submitted','checklist_run_completed','knowledge_read','survey_submitted','certificate_issued',
    'review_graded','content_issue_accepted'))
);
create index idx_user_activity_events_tenant on user_activity_events (tenant_id, user_id, local_date desc);
create table user_activity_daily (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  local_date date not null, events_count int not null default 0, seconds_spent int not null default 0,
  kinds jsonb not null default '{}',                      -- {"lesson_completed":3,"attempt_graded":1}
  level smallint not null default 0,                      -- 0…4, §7.10
  recalced_at timestamptz not null default now(),
  unique (tenant_id, user_id, local_date)
);
create index idx_user_activity_daily_tenant on user_activity_daily (tenant_id, user_id, local_date desc);
```

> [исправлено, реализация PR-34, миграция `v2_user_activity`] Отступления от DDL выше (Р-34.1–Р-34.4,
> `46-progress.md`): (1) **`user_activity_events.seconds_spent` нет** — время обучения уже измеряет учёт времени
> биениями (`learning_time_sessions`, `37` §7.10–7.15, PR-21), копия в событии завела бы второй источник времени;
> секунды дня в `user_activity_daily.seconds_spent` сводит из сегментов задача `activity.aggregate` (§11).
> (2) `user_activity_events.created_at` — момент записи рядом с `occurred_at` — моментом действия самого человека
> (§7.10). (3) `location_id … on delete set null` — удаление точки не упирается в историю ленты, снимок `tz`
> остаётся. (4) Индекс `idx_user_activity_events_purge (tenant_id, occurred_at)` — под ночную уборку. (5) Второго
> индекса агрегата нет: уникальный ключ `(tenant_id, user_id, local_date)` уже он, btree читается и в обратном
> порядке. (6) Check `level between 0 and 4`, `events_count >= 0 and seconds_spent >= 0`. (7) `request_context` в
> событиях нет: лента — производная проекция уже зажурналированных действий (`enrollment_events`,
> `task_status_log`, `attempt_results`, `audit_log` пишут контекст сами), а не журнал доказательства «кто и откуда»;
> копия IP и браузера на 400 дней — лишние ПД (CLAUDE.md п. 14 касается журналов `02` «Формат поля
> request_context»). Ранее: `seconds_spent int not null default 0` в событии, без `created_at`, без индекса уборки,
> с отдельным `idx_user_activity_daily_tenant`.

### 3.4 Заметки

```sql
create table person_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,   -- о ком
  author_id uuid not null references users(id),                    -- кто написал
  body text not null, visibility text not null default 'manager', category text not null default 'general',
  is_pinned boolean not null default false,
  flagged_at timestamptz, flagged_terms text[] not null default '{}',   -- скрин чувствительного, §7.5
  shared_at timestamptz, archived_at timestamptz,                       -- §7.4, §7.6
  updated_at timestamptz not null default now(), created_at timestamptz not null default now(),
  constraint person_notes_visibility_chk check (visibility in ('hr','manager','shared_with_person')),
  constraint person_notes_category_chk check (category in (
    'general','onboarding','performance','training_plan','incident','agreement')),
  constraint person_notes_body_chk check (char_length(body) between 3 and 2000),
  constraint person_notes_self_chk check (author_id <> user_id)
);
create index idx_person_notes_tenant on person_notes (tenant_id, user_id, created_at desc) where archived_at is null;
```

| Поле | Тип | Обяз. | По умолч. | Валидация | Комментарий |
|---|---|:-:|---|---|---|
| `visibility` | text | да | `manager` | 3 значения | Уровня «тільки автор» нет — §7.4 |
| `category` | text | да | `general` | 6 значений | Определяет срок хранения (§7.6) |
| `is_pinned` | boolean | да | false | ≤3 на человека | Договорённость о развитии, не теряется при ротации руководителя |
| `flagged_at` | timestamptz | нет | — | — | Ставит скрин, сохранение не блокирует (§7.5) |

> [исправлено, сверка `43` §1.2, реализация PR-32] Ранее: `create table person_notes (…)` —
> отдельная таблица. Заметки уже жили в `user_notes` (миграция `0019`), это одна сущность, поэтому
> реализовано **`alter table user_notes`** на те же семь колонок и четыре констрейнта
> (`user_notes_visibility_chk`, `_category_chk`, `_body_chk`, `_self_chk`) плюс ключ на `tenants`,
> которого у таблицы не было. Индексы: частичный `idx_user_notes_tenant (tenant_id, user_id,
> created_at desc) where archived_at is null` и полный `idx_user_notes_tenant_all` рядом (`40`
> §7.2, контрактный тест №2). `author_id` остаётся nullable: заметки, написанные до PR-32 о самом
> себе, получили `author_id = null` (прежний автор сохранён в `audit_log` записью
> `person_note.author_cleared`), иначе `self_chk` не встал бы на живые данные; текст короче трёх
> знаков добит пробелами по той же причине. Ни одна заметка не удалена.

### 3.5 Документы человека

```sql
create table person_document_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null, name text not null,                  -- «Інструктаж з охорони праці»
  is_system boolean not null default false, is_required boolean not null default false,
  required_positions uuid[] not null default '{}',         -- пусто = для всех посад
  validity_months int,                                     -- null = бессрочный
  remind_days int[] not null default '{30,7,0}',
  is_fact_only boolean not null default false,             -- файл запрещён, §7.7
  self_upload boolean not null default false, visible_to_manager boolean not null default true,
  is_active boolean not null default true,
  unique (tenant_id, code)
);
create index idx_person_document_types_tenant on person_document_types (tenant_id, is_active);
create table person_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  type_id uuid not null references person_document_types(id) on delete restrict,
  media_id uuid references media_assets(id) on delete set null,   -- null для is_fact_only
  title text, number_masked text,                                 -- последние 4 знака, §7.7
  issued_at date, expires_at date, status text not null default 'valid',
  uploaded_by uuid not null references users(id), note text,
  created_at timestamptz not null default now(),
  constraint person_documents_status_chk check (status in ('valid','expiring','expired','revoked')),
  constraint person_documents_dates_chk check (expires_at is null or issued_at is null or expires_at > issued_at),
  constraint person_documents_number_chk check (number_masked is null or char_length(number_masked) <= 8)
);
create index idx_person_documents_tenant on person_documents (tenant_id, user_id, status);
create index idx_person_documents_tenant_expiry on person_documents (tenant_id, expires_at)
  where status in ('valid','expiring');
```

> [исправлено, реализация PR-32: §4 требует причину отмены, а хранить её негде] В
> `person_documents` добавлены `revoked_at`, `revoke_reason`, `replaced_by_id` (ключ на тот же
> `person_documents`, `on delete set null`) и `check ((status = 'revoked') = (revoked_at is not
> null))`: §4 требует «`revoked` — вручную с причиной» и «с причиной «Замінено документом від
> {дата}»», а `note` — примечание загрузившего, затирать его отменой нельзя. Обе таблицы получили
> `created_at`/`updated_at` по общему правилу `docs/02` (преамбула).

Системные типы, создаваемые при инициализации тенанта: `employment_contract` («Трудовий договір», обяз., бессрочный),
`labor_safety_briefing` («Інструктаж з охорони праці», обяз., 12 мес.), `fire_safety_briefing` («Інструктаж з пожежної безпеки»,
обяз., 12 мес.), `medical_book` («Медична книжка», обяз. для посад из `required_positions`, 12 мес., `is_fact_only=true`),
`nda` («Угода про нерозголошення», обяз., бессрочный), `external_certificate` («Сертифікат стороннього навчання», не обяз.,
`self_upload=true`), `other` («Інше»).

### 3.6 Нормы и факты отсутствий

> [дополнено, PR-39] `absence_norms` заведена раньше карточки — миграцией настроек компании
> (`docs/v2/45` PR-39, блок «Кількість днів відпустки», §5.4). Отличия от DDL ниже: общие поля
> `updated_at` (правка перезаписывает строку года, §4) и `set_by` nullable с `on delete set null`
> (как у прочих «кто правил»: стирание человека по GDPR не должно упираться в справочную норму);
> уникальность — `unique nulls not distinct`, иначе строк компании (`scope_id is null`) на год
> могло бы быть несколько. `absence_records` — по-прежнему PR-33.

```sql
create table absence_norms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  scope_type text not null, scope_id uuid,                 -- tenant (scope_id null) | location | user
  year int not null,
  vacation_days numeric(4,1), sick_days numeric(4,1),      -- null = наследовать с уровня выше, §7.13
  reason text,                                             -- обязателен для scope_type='user'
  set_by uuid not null references users(id), created_at timestamptz not null default now(),
  constraint absence_norms_scope_chk check (scope_type in ('tenant','location','user')),
  constraint absence_norms_scope_id_chk check ((scope_type = 'tenant') = (scope_id is null)),
  constraint absence_norms_year_chk check (year between 2020 and 2100),
  constraint absence_norms_days_chk check ((vacation_days is null or vacation_days between 0 and 365)
    and (sick_days is null or sick_days between 0 and 365)),
  constraint absence_norms_reason_chk check (scope_type <> 'user' or char_length(coalesce(reason,'')) >= 5),
  unique (tenant_id, scope_type, scope_id, year)
);
create index idx_absence_norms_tenant on absence_norms (tenant_id, year, scope_type);
create table absence_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null, date_from date not null, date_to date not null,
  days_count numeric(4,1) not null,                        -- календарные дни диапазона, §7.13
  status text not null default 'approved', source text not null default 'manual',  -- manual|import|api
  comment text, created_by uuid not null references users(id), created_at timestamptz not null default now(),
  constraint absence_records_kind_chk check (kind in ('vacation','sick','unpaid','other')),
  constraint absence_records_status_chk check (status in ('planned','approved','cancelled')),
  constraint absence_records_range_chk check (date_to >= date_from)
);
create index idx_absence_records_tenant on absence_records (tenant_id, user_id, date_from);
create index idx_absence_records_tenant_range on absence_records (tenant_id, date_from, date_to)
  where status in ('planned','approved');
```

> [дополнено, PR-33] `absence_records` заведена миграцией `v2_absences`. Отличия от DDL выше, каждое
> с причиной: `created_at`/`updated_at` — общие поля (запись правится `PATCH`); `created_by`
> nullable с `on delete set null` — как `absence_norms.set_by`; `absence_records_source_chk` —
> перечень `absence_source` в `docs/02`; `absence_records_range_chk` дополнен пределом 366 дней и
> `absence_records_days_chk` держит `days_count = date_to − date_from + 1` — `numeric(4,1)`
> переполнился бы на многолетнем периоде, а норма живёт календарным годом (длинное отсутствие
> вносится записями по годам); `absence_records_comment_chk` — «коментар (≤300)» §6.4.
> Пересечение действующих записей одного человека держит сервис под advisory-lock на человека
> (`409 absence_overlap`): исключающему ограничению нужен `btree_gist`. Сдвиг дедлайна пишется
> не в назначение целиком, а в **запись на курс**, которую назначение создало:
> `enrollments.deadline_shifted_reason` (`deadline_shift_reason: absence`, `docs/02`) — срок у
> людей одного назначения разный, отпуск — у одного (§7.14). Не путать с `reviewer_absences`
> (`docs/v2/37` §3.4): там отсутствие проверяющего с заместителем и перебросом очереди, здесь —
> отпуск и больничный для карточки и планирования (`41` §8.3.4); автоматической связи между
> ними PR-33 не заводит — см. `46-progress.md`, запись PR-33.

### 3.7 Снимки рейтинга

```sql
create table person_rating_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  calc_date date not null,
  base_pct numeric(5,1) not null,                          -- 0…100
  bonus_early numeric(4,1) not null default 0, bonus_streak numeric(4,1) not null default 0,
  bonus_help numeric(4,1) not null default 0,              -- каждый 0…10
  total_pct numeric(5,1) not null,                         -- min(130, сумма), §7.1
  breakdown jsonb not null default '{}',                   -- числа, подставленные в формулу, для §5.3
  window_from date not null, window_to date not null, is_current boolean not null default true,
  created_at timestamptz not null default now(),
  constraint person_rating_total_chk check (total_pct between 0 and 130),
  unique (tenant_id, user_id, calc_date)
);
create index idx_person_rating_snapshots_tenant on person_rating_snapshots (tenant_id, user_id, calc_date desc);
```

Все восемь новых таблиц получают RLS по образцу `02` §2.12 (`enable` + `force`, политика `tenant_isolation` с `using` и `with check`).
Доступ — только через `withTenant`.

## 4. Состояния и переходы

**Документ** (`person_documents.status`): `valid` → `expiring` (за `remind_days[0]` дней до `expires_at`) → `expired` (после даты).
`revoked` — вручную с причиной, необратимо (инструктаж проведён формально, сертификат отозван выдавшим). Документ без `expires_at`
остаётся `valid` всегда. Загрузка нового документа того же типа переводит предыдущий в `revoked` с причиной «Замінено документом
від {дата}» — активным остаётся ровно один.

> [исправлено, реализация PR-32: правило без оговорок отменяло бы сертификаты и исторические
> записи] Уточнено двумя оговорками. (1) Замена действует для типа-«состояния» — обязательного или
> со сроком действия: у человека один действующий инструктаж, одна медкнижка, один договор. Тип
> без того и другого («Сертифікат стороннього навчання», «Інше») — коллекция: второй сертификат
> за другой курс первый не отменяет. (2) Действующим остаётся более свежий **по дате выдачи**:
> историческая запись, внесённая после текущей (§12 — «HR вносит исторические записи»), сама
> становится заменённой (`replaced_by_id` — текущий документ) и текущую не отменяет.

**Заметка**: `active` → `archived` (автоматически по сроку §7.6) → физическое удаление только при `gdpr.erase`. `visibility`
меняется в обе стороны, кроме `shared_with_person → manager|hr` — **однонаправленный**: открытое человеку нельзя закрыть обратно,
он это уже прочитал.

**Отсутствие** (`absence_records.status`): `planned` → `approved` → `cancelled`. В остаток (§7.13) входит только `approved`;
в блокировку дедлайнов (§7.14) — `planned` и `approved`.

> [уточнено, PR-33] Переходы только вперёд: `planned → approved`, `planned → cancelled`,
> `approved → cancelled`; иначе `409 absence_status_invalid`, отменённая запись не правится вовсе
> (`409 absence_cancelled`). Подтверждённое не становится снова «Заплановано» — иначе остаток
> (он считает только `approved`) менялся бы задним числом.

**Норма** состояний не имеет: правка перезаписывает строку года через `insert … on conflict do update`, прежнее значение целиком
уходит в `audit_log.before`.

## 5. Экраны

### 5.1 Карточка человека — новые блоки

Порядок, как на эталоне: шапка → «Активність за {рік}» → «Призначені треки» → личные данные → «Нотатки (N)» → «Документи (N)» →
«Відсутності».

**«Активність за {рік}»** — сетка 53 недели × 7 дней, селектор года (доступны годы с первого события), 5 уровней заливки бирюзой
`#2BBFAE` от бледного к насыщенному, легенда «Немає · Невелика · Середня · Висока · Дуже висока». Подсказка на клетке:
«{дата}: {N} подій, {HH:MM} у навчанні» + разбивка по типам. Пусто: бледная сетка и «Ще немає навчальної активності за {рік}».
Загрузка — скелетон сетки. Ошибка — «Не вдалося завантажити активність» + «Повторити».

**«Призначені треки»** — группировка по **этапам жизненного цикла**; перечень и порядок этапов берутся из `33-lifecycle.md`.
Внутри этапа — карточки: обложка, название, круговой индикатор «{N}%», «Призначено: DD.MM.YY», «Дедлайн: DD.MM.YY» со светофором
(§7.15), «Пройдено модулів: X/Y», «Плановий час: HH:MM:SS», «Час проходження: HH:MM:SS» (обе метрики — по
`37-review-delegation.md`). Этап без назначений сворачивается в строку «{Етап} — немає призначень» со ссылкой «Управління треками».

**«Нотатки (N)»** — свёрнутая секция; N — число заметок, видимых **смотрящему**. Развёрнутая: лента сверху вниз, в строке автор,
дата, чип категории, значок видимости, текст; кнопка «Додати нотатку». Над лентой постоянная плашка: «Нотатки — службові записи
про співробітника. Співробітник має право отримати їх копію за запитом. Пишіть лише факти, повʼязані з роботою та навчанням.»
Пусто: «Нотаток немає». В **своей** карточке employee видит счётчик и только заметки `shared_with_person` (§7.4).

**«Документи (N)»** — таблица: Тип · Назва · Виданий · Дійсний до · Статус-чип · Хто завантажив · «⋮». Обязательный отсутствующий
тип показывается строкой-заглушкой с красным чипом «Відсутній» и кнопкой «Завантажити» — иначе отсутствие документа невидимо.
Для `is_fact_only` вместо ссылки на файл — «Зафіксовано факт наявності», без превью.

**«Відсутності»** — по каждому виду три числа: «Норма: 24 · Використано: 11 · Залишок: 13», под ними источник нормы
(«Норма компанії» / «Норма точки» / «Індивідуально, HR, {дата}») и кнопка «Скоригувати» (по скоупу), ниже список записей за год.
Постоянная строка: «Дані про відсутності — довідкові. Вони впливають лише на планування навчання й не замінюють кадровий облік.»

> [дополнено, PR-33] Блок — компонент `PersonAbsences.vue`: вкладка «Відсутності» карточки
> `/admin/people/:id` (носителям `person.absence.manage`; порядок блоков одной страницей — PR-35)
> и та же секция только для чтения в своём профиле `/learn/profile` (§2 — «свои»). Сверх
> описанного: селектор года; «Індивідуально, {хто}, {дата}» — имя того, кто поставил норму
> (`absence_norms.set_by`), и её причина строкой ниже; перерасход — «Перевищено на {X} дн.»
> красным (§7.14); `unpaid` и `other` без нормы — строкой «Використано»; список «Дедлайн минув під
> час відсутності» с «Перенести» (§12). Во вкладке «Навчання» у сдвинутого срока — пометка
> «перенесено: відсутність».

### 5.2 Список сотрудников — колонка «%»

Колонка «%» справа от «Останній вхід»: число, цвет чипа, сортировка. Значения выше 100 показываются как есть — «101 %», «102 %».
Заголовок кликабелен, поповер: «Це індекс навчальної залученості, а не відсоток проходження. Може перевищувати 100 % за рахунок
бонусів. Довідкова величина.» Значение старше 48 часов — серым.

### 5.3 Экран расшифровки рейтинга — `/people/:id/rating`

Обязательный экран: человек должен понимать, откуда взялась его цифра. Заголовок «Звідки взявся мій відсоток», крупная цифра, дата
расчёта, окно («з DD.MM.YYYY по DD.MM.YYYY»). Четыре карточки, каждая с подставленными числами:
1. «Основа: {base} зі 100» — «Виконано {a} із {b} призначених модулів з урахуванням ваги. Обовʼязкові важать удвічі.» + раскрываемый список назначений окна с их вкладом.
2. «Достроковість: +{x} з 10» — «У середньому ви завершували на {d} % раніше дедлайну.»
3. «Регулярність: +{y} з 10» — «Найдовша серія днів з навчанням: {n} з 30.»
4. «Внесок у колег: +{z} з 10» — «Зараховано {k} з 20 дій: перевірені роботи, прийняті зауваження до контенту.»

Внизу «Разом: {total} % (максимум 130 %)» и плашка «Показник довідковий. Він не є підставою для кадрових рішень і не впливає на
оплату праці.» Пусто (нет назначений в окне): «Показник не розраховується: у вас немає призначень за останні 12 місяців».

### 5.4 Настройки компании — блок «Кількість днів відпустки»

Внутри единой формы `/company-settings` (не отдельный экран): подпись «Норма днів відпустки на рік за промовчанням для
співробітників. Індивідуально залишок може скоригувати HR у картці співробітника.», два степпера — «Днів відпустки на рік» (24)
и «Лікарняний» (5), ссылка «Перевизначення по точках ({N})» → `/branches`, колонка «Включено відпустки».

## 6. Формы

### 6.1 «Додати нотатку»

| Поле | Контрол | Обяз. | Валидация | Текст ошибки (uk) |
|---|---|:-:|---|---|
| Категорія | селект, 6 значений | ✓ | из списка | «Оберіть категорію» |
| Текст | текстовая область, счётчик 2000 | ✓ | 3–2000 | «Нотатка має містити від 3 до 2000 символів» |
| Видимість | радио: «HR» · «Керівник і HR» · «Показати співробітнику» | ✓ | — | — |
| Закріпити | переключатель | — | ≤3 на человека | «Не більше трьох закріплених нотаток» |

Постоянная подсказка под полем «Текст»: «Не фіксуйте у нотатках стан здоровʼя, діагнози, вагітність, особисте життя, релігійні чи
політичні погляди, національність, членство у профспілці, фінансовий стан. Це чутливі дані — зберігати їх у LMS заборонено.»
При срабатывании скрина (§7.5) — модалка «Текст схожий на чутливі дані ({перелік ознак}). Переконайтеся, що нотатка стосується
роботи й навчання.» с кнопками «Змінити текст» / «Все одно зберегти»; второй вариант ставит `flagged_at`.

### 6.2 «Додати документ»

| Поле | Контрол | Обяз. | Валидация | Текст ошибки (uk) |
|---|---|:-:|---|---|
| Тип документа | селект из `person_document_types` | ✓ | тип активен | «Оберіть тип документа» |
| Файл | drag-and-drop, pdf/jpg/png, ≤20 МБ | ✓, если не `is_fact_only` | mime + размер | «Дозволені формати: PDF, JPG, PNG, до 20 МБ» |
| Назва | текст | — | ≤120 | |
| Номер | текст | — | ≤32, хранятся последние 4 | «Номер задовгий» |
| Виданий | дата | ✓ | ≤ сегодня | «Дата видачі не може бути в майбутньому» |
| Дійсний до | дата | ✓, если у типа есть `validity_months` | > «Виданий» | «Дата закінчення має бути пізніше дати видачі» |
| Примітка | текст | — | ≤300 | |

Для `is_fact_only` поле «Файл» скрыто, вместо него плашка: «Для цього типу документа в системі фіксується лише факт наявності та
строк дії. Скан або фото завантажувати не можна.» Попытка загрузить через API → `422 document_file_not_allowed`.

### 6.3 «Скоригувати норму відсутностей»

Поля: вид («Відпустка» / «Лікарняний»), рівень («Компанія» / «Точка {назва}» / «Цей співробітник»), рік (текущий или следующий),
значення (степпер 0–365, шаг 0.5), **причина** (5–300 символов, обязательна для уровня человека, «Вкажіть причину індивідуального
коригування»). Под формой живой расчёт: «Норма {N} → Використано {U} → Залишок {R}». Если новое значение меньше использованного —
предупреждение, не блокировка: «Використано більше днів, ніж нова норма. Залишок стане відʼємним: −{X}».

> [дополнено, PR-33] Уровни в форме — только доступные смотрящему: «Компанія» — грант
> `person.absence.manage` на весь тенант, «Точка» и «Цей співробітник» — в области его точки (та же
> проверка, что у `PUT /absence-norms`). Пустое значение — «успадковувати» (`null`, §7.13). Живой
> расчёт показывает норму, которая **станет у этого человека**: правка точки не меняет её, если у
> человека своя корректировка. Рік формы — год карточки, текущий или следующий.

### 6.4 «Внести відсутність»

Вид, період (диапазон дат), статус («Заплановано» / «Підтверджено»), коментар (≤300).
Проверка пересечений: «Відсутність перетинається з наявним записом {DD.MM}–{DD.MM}».

> [дополнено, PR-33] Пересекаются только действующие записи (`planned`, `approved`); отменённая
> место освобождает. Период — не длиннее 366 дней (`422 absence_record.range_invalid`,
> `reason: too_long`). Правка — та же форма; у подтверждённой записи выбора «Заплановано» нет (§4).
> Под формой — «Дедлайни обовʼязкового навчання, що припадають на ці дні, перенесуться…»: запись
> сдвигает сроки сразу, ответ несёт `meta.shifted`.

## 7. Правила и алгоритмы

### 7.1 Формула рейтинга

Рейтинг — **індекс навчальної залученості**, не процент прохождения. Окно — скользящие 365 дней от даты расчёта; учитываются
`enrollments`, у которых в окно попадает `due_at` либо `completed_at`, и все активные на дату расчёта.

```
R = min(130, B + E + S + H)

B (основа, 0…100)       = 100 × Σ(wᵢ × cᵢ) / Σ(wᵢ)
      wᵢ = 2 для обязательного назначения, 1 для добровольного
      cᵢ = 1.0 при status='completed'; 0 при 'failed', 'not_started', 'expired' (остаётся в знаменателе);
           progress_pct/100 при 'in_progress'
E (достроковість, 0…10) = 10 × avg(max(0, (due_at − completed_at) / (due_at − assigned_at)))
                          по завершённым в срок назначениям окна, у которых есть дедлайн
S (регулярність, 0…10)  = 10 × min(1, макс_серія_днів_з_level>0 / 30)
H (внесок, 0…10)        = 10 × min(1, зачтённых_действий / 20)
```

Действия для `H` — закрытый список: проверенная чужая сдача (`review_graded`), принятое замечание к контенту
(`content_issue_accepted`, `36-content-feedback.md`), завершённое менторское сопровождение новичка. Больше ничего.
**Потолок 130** `[решение]`: на эталоне сняты 101 % и 102 % — шкала действительно уходит выше 100, но не в разы; 130 = 100 основы
+ три бонуса по 10. Потолок нужен не ради вида: без него достаточно одного неограниченного бонуса, чтобы индекс перестал быть
сравнимым между людьми. Пол — 0, отрицательных значений нет: рейтинг ничего не отнимает.

**Связь с `points_ledger` и бейджами** — разные сущности с общей событийной шиной, не пересчитываемые друг из друга:

| | Рейтинг (`%`) | Баллы (`points_ledger`) | Бейджи (`user_badges`) |
|---|---|---|---|
| Природа | индекс, пересчитывается целиком | валюта, копится и тратится | факт, выдаётся один раз |
| Ручное начисление \| уменьшается | **невозможно** \| да, при сдвиге окна | возможно (`granted_by`) \| только тратой | возможно \| нет |
| Входит в формулу рейтинга | — | **нет** | **нет** |

`[решение]` Баллы **не входят** в формулу: иначе администратор, начисливший 500 бонусов за корпоратив, поднимает человеку учебный
индекс, и индекс перестаёт что-либо значить. Бейджи тоже не входят — «3 роки в компанії» не учебная активность. Общее одно:
событие `enrollment_completed` порождает и строку `points_ledger` по `point_rules`, и строку `user_activity_events`, из которой
позже соберётся компонент рейтинга.

### 7.2 Пересчёт, объяснимость, когда не рассчитывается

Рейтинг считается **раз в сутки** целиком, из первичных данных — инкрементальных доначислений нет. Это и есть механизм
объяснимости: любое число воспроизводится из `enrollments` и `user_activity_daily` на дату расчёта, а `breakdown jsonb` хранит
подставленные в формулу числа, а не только результат. Формула версионируется (`breakdown.formula_version`); при смене версии экран
расшифровки показывает «Формулу змінено {дата}. Показники до цієї дати рахувалися інакше.» — молча переписывать историю нельзя.
Для `kind='candidate'` рейтинг не считается вовсе (у кандидата своя тройка оценок, `28-recruiting-candidates.md`). Для сотрудника
без назначений в окне — `rating_pct = null`, в списке «—», **не «0 %»**: ноль означал бы «всё провалил», а не «нечего было
проходить». Для `status='archived'` фиксируется последнее значение. При `is_hidden=true` рейтинг считается, но человек не попадает
в распределения и сравнения (`16` §7.5).

### 7.3 Что видит сотрудник и что руководитель — защита от накрутки

Рейтинг, используемый для наказания, немедленно превращается в инструмент накрутки: человек начинает проходить лёгкие
добровольные треки ради `B`, сдавать тест в первый час ради `E` и заходить каждый день на минуту ради `S`. Поэтому правила показа —
часть требований, а не оформление.

| | Сотрудник о себе | Руководитель / HR о подчинённом |
|---|---|---|
| Цифра и полная расшифровка (§5.3), своя динамика за 12 месяцев | ✓ | ✓ |
| Распределение по точке (гистограмма, без имён) | ✓ | ✓ |
| Место в ранжированном списке, «топ» и «антитоп» | **—** | **—** |
| Сравнение с конкретным коллегой по имени | — | ✓, только внутри карточки одного человека |

Запреты, проверяемые кодом: (1) `rating_pct` **нельзя сделать единственным условием** массового «Архівувати» и «Заблокувати» —
API отклоняет фильтр `{rating_pct:{lt:N}}` без второго условия с `422 rating_only_filter_forbidden`; (2) колонка «%» **не входит**
в выгрузку «Люди» по умолчанию — только явной галкой «Включити індекс залученості» с подтверждением «Показник довідковий і не
призначений для кадрових рішень»; (3) публичной доски лидеров по рейтингу нет — доска, если тенант её включает, строится по баллам
(`21` §3.7), которые тратятся и потому не копятся вечно.

Защита внутри самой формулы: `E` не начисляется, если между `started_at` и `completed_at` прошло меньше `Плановий час × 0.5`
(`37-review-delegation.md`) — сдача «за минуту» досрочностью не считается; `S` считает дни с `level > 0`, то есть минимум одно
**завершённое** событие, вход в систему событием не является (§7.9); `H` ограничен 20 действиями — двадцать первая проверенная
работа индекс не повышает; добровольное назначение весит вдвое меньше обязательного, поэтому «набрать процент» лёгкими треками
нельзя: они разбавляют и числитель, и знаменатель.

### 7.4 Видит ли сотрудник заметки о себе, и уровни видимости

`[решение]` **По умолчанию — нет, но существование заметок не скрывается, а содержание человек вправе получить по запросу.**
В своей карточке человек видит счётчик «Нотатки (N)» и заметки `visibility='shared_with_person'`; остальные скрыты в интерфейсе,
но входят в выгрузку персональных данных по запросу субъекта (парная к `gdpr.erase` операция, `16` §7.9). Обоснование, почему
не «полностью скрыто» и не «полностью открыто»:
1. Заметка о человеке — его персональные данные; право субъекта на доступ неотчуждаемо. «Тайная» заметка юридически всё равно
   не тайна, и проектировать продукт так, будто она тайна, — закладывать в него ложное обещание руководителю.
2. Если автор знает, что текст может быть показан, заметки остаются фактологичными («домовились перенести дедлайн атестації
   на 12.03») и не превращаются в характеристики. Это единственный работающий фильтр качества, модерацией он не заменяется.
3. Полностью открытая заметка бесполезна для своей задачи: руководитель перестанет писать неудобное и уйдёт в мессенджер,
   где нет ни аудита, ни срока хранения.

Уровни: `hr` — автор, носители `person.note.read` в области тенанта, `admin`. `manager` (по умолчанию) — то же плюс руководители
**текущей точки**; при переводе на другую точку доступ прежнего руководителя прекращается в тот же день, заметка не копируется.
`shared_with_person` — то же плюс сам человек; проставляется `shared_at`, уходит `person_note_shared`. Уровня «тільки автор» нет
`[решение]`: заметка, которую не видит никто, кроме автора, не проверяема, не переживает ротацию руководителя и ради этого не стоит
риска хранения свободного текста о человеке.

`[гипотеза]` «Руководитель текущей точки» и «admin» в таблице §2 не определены через скоупы. `[решение, PR-32]`
Руководитель точки — носитель `person.note.read` в области, покрывающей **текущую** основную точку человека (роль на точку
или на подразделение над ней): то же понятие «своих точек», что у отчётов, а не поле `locations.manager_id` — право читать
заметку есть вопрос о роли смотрящего. Автор видит свои заметки и после перевода человека, но не после его увольнения.
«Admin» для заметок — носитель `person.note.write` **и** `audit.view` на весь тенант: новых скоупов пакет не заводит, а всё,
что §7.5–§7.6 и §12 оставляют «только admin» (чужая заметка с причиной, архив по ссылке, заметка уволенного автора), —
надзор над журналом. *Чем проверяется:* появление в пакете отдельного скоупа надзора над заметками — тогда меняется
одна функция `noteViewerOf()`.

### 7.5 Запрещённое содержание заметок и мягкий контроль

Запрещено фиксировать: состояние здоровья, диагнозы, беременность, инвалидность; личную и семейную жизнь; религиозные и
политические убеждения; национальность и этническое происхождение; сексуальную ориентацию; членство в профсоюзе; судимость;
финансовое положение вне служебных данных; оценки внешности. Механизм — серверный лексический скрин по словарю тенанта при
сохранении. Скрин **не блокирует** сохранение: показывает подтверждение (§6.1) и ставит `flagged_at`. Блокировать нельзя —
«хворів, переносимо дедлайн» законная рабочая заметка, ложное срабатывание неизбежно, а жёсткий запрет выталкивает переписку
из системы. Отчёт «Нотатки з ознаками чутливого змісту» доступен `admin`; удаление — его решение с причиной.

`[гипотеза]` «Словарь тенанта» не описан: ни полей, ни экрана правки. `[решение, PR-32]` Встроенный словарь по умолчанию —
основы слов на трёх языках интерфейса (`server/services/noteScreen.ts`), короткие слова сравниваются целиком; без «партія»,
«борг», «кредит» — в общепите это служебные данные («партія товару», «розрахувався кредитною карткою»). Подтверждение формы
§6.1 — ответ `409 note_sensitive_suspected` с признаками; повтор с `confirmSensitive: true` сохраняет и ставит `flagged_at`,
переписанный без чувствительного текст отметку снимает. *Чем проверяется:* появление настроек словаря в `docs/24` — тогда
словарь тенанта дополняет встроенный, и появляется смысл в еженедельной переборке `notes.sensitive_screen` (§11).

### 7.6 Срок хранения заметок, увольнение, аудит

Категории `general`, `onboarding`, `performance`, `incident` — **24 месяца** с `created_at`, затем `archived_at` автоматически:
заметка исчезает из карточки, остаётся доступной по прямой ссылке для `admin` и в `audit_log`. Категории `training_plan`
и `agreement`, а также любая `is_pinned` — **36 месяцев**: договорённость о развитии переживает годовой цикл аттестации.
При `users.status='archived'` (увольнение) заметки **не удаляются**, но переходят в режим только чтения, видимость всех сужается
до `hr` + `admin`, а `shared_with_person` теряет смысл вместе с доступом человека. При `gdpr.erase` — удаляются физически,
без обезличивания: свободный текст о человеке обезличить нельзя.

В `audit_log` (`02` §2.9) пишутся `person_note.create` (`after` — весь объект), `person_note.read`, `person_note.update`
(`before`/`after`), `person_note.delete`, `person_note.visibility_change`, `person_note.share`, `person_note.archive`.
**Чтение логируется обязательно** — одна запись на разворот секции, `after` содержит `{user_id, note_ids:[…], count}`, а не текст:
смысл записи «кто открывал заметки об этом человеке», а не дублирование содержания. Экран «Хто читав нотатки» доступен `admin`;
в выгрузку персональных данных человека входит список фактов чтения без имён читавших.

### 7.7 Медицинские документы: факт, а не содержание

Тип `medical_book` и любой тип с `is_fact_only=true` хранит **факт и срок**, не содержание: файл запрещён на уровне API, остаются
тип, дата выдачи, дата истечения, маскированный номер (последние 4 знака). Обоснование: (1) данные о здоровье — особая категория
персональных данных, и законное основание хранить **скан** медкнижки в системе обучения отсутствует — LMS нужен ответ «допущен ли
человек к работе», а он полностью выражается парой «факт + дата»; (2) утечка скана — утечка особой категории ПД с несопоставимо
большими последствиями, чем польза от превью в карточке; (3) оригинал в любом случае хранится у работодателя в кадровом деле,
вторая копия в LMS не добавляет ни одного сценария, но добавляет вторую поверхность утечки. Правило общее: оно действует для любого
типа, помеченного HR как `is_fact_only`, а не как исключение под медкнижку.

### 7.8 Документы: обязательность, напоминания, хранение файла

Тип с `is_required=true` и подходящим `required_positions` (пустой массив = все посады) порождает строку-заглушку в карточке, пока
документа нет, и попадает в отчёт §9. Напоминания по `remind_days` (30, 7, 0 дней до `expires_at`), после истечения — ежедневно
ещё 14 дней, затем прекращаются: бесконечное напоминание игнорируется. Загружать документ другому может только носитель
`person.document.manage`; себе — только типы с `self_upload=true`, и такой документ помечается «Завантажено співробітником»,
чтобы HR видел, что источник не проверен. Файл: `media_assets.origin='person_document'`, `owner_user_id=user_id`,
`is_evidence=true` для обязательных типов (не удаляется, пока документ `valid` или `expiring`, `34` §7.2),
`retention_until = expires_at + 3 роки` `[решение]` — общий срок исковой давности по трудовым спорам; далее действует `notify_only`,
то есть решение принимает человек.

### 7.9 Что считается событием активности

Закрытый список — двенадцать значений `user_activity_events.kind` (§3.3). **Не являются** событиями: вход в систему и
`last_seen_at`; открытие урока без завершения; просмотр списка или карточки; получение уведомления; отправка сообщения.
Обоснование: карта отвечает на вопрос «людина вчилася?», а не «людина заходила?». Если засчитывать вход, у человека, открывшего
и закрывшего приложение, клетка станет зелёной — и карта перестанет быть доказательством чего-либо. `review_graded` и
`content_issue_accepted` включены: для ментора и автора замечаний это и есть их учебная работа в системе.

> [уточнено, реализация PR-34] Кто порождает каждый вид (`ACTIVITY_SOURCES`, `shared/domain/activity.ts`; каждый вызов
> сверяет unit-тест `user-activity.spec.ts`), Р-34.6:
>
> | Вид | Чья лента | Где рождается |
> |---|---|---|
> | `lesson_completed` | ученика | урок зачтён: кнопкой (`completeLesson`) или результатом — тест сдан, практикум принят, занятие посещено (`markLessonCompleted`, одна точка на четыре пути); повторная отметка зачтённого урока — не событие |
> | `attempt_submitted` | ученика | ученик отправил попытку (`submitAttempt`) |
> | `attempt_graded` | ученика | попытка получила итог — сразу при автопроверке или после ручной проверки последнего ответа |
> | `enrollment_started` / `enrollment_completed` | ученика | запись на курс (`enrollments`) перешла в «в процесі» / завершена |
> | `workshop_submitted` | ученика | работа практикума отправлена на проверку |
> | `checklist_run_completed` | заполнившего | прогон чек-листа завершён |
> | `knowledge_read` | читателя | статья базы знаний открыта — раз на человека в день, как счётчик просмотров (Spec 21) |
> | `survey_submitted` | участника | опрос пройден; ссылка — на **участие**, а не на ответ: анонимный ответ с человеком не связывается |
> | `certificate_issued` | ученика | сертификат выдан |
> | `review_graded` | проверяющего | решение по ответу теста или по работе практикума (включая «на доработку») |
> | `content_issue_accepted` | каждого заявителя | карточка замечания взята в работу (`new → in_progress`) |
>
> Не события сверх перечня выше `[решение]`: закрытие попытки по сроку (`attempt.expire` — действие системы, человек
> попытку не отправлял), зачёт урока пересчётом администратора, просмотр материала вне курса, посещение занятия вне
> курса, «Ознайомлений» по объявлению, анкета оценки, прохождение программы и траектории целиком (они складываются
> из своих элементов, которые уже на карте). Новый вид — только через перечисления `docs/02` (CLAUDE.md п. 13).

### 7.10 Часовой пояс, агрегация, уровни

Таймзона разрешается в момент вставки по цепочке: `users.timezone` → `locations.timezone` **той точки, где человек работал
на дату события** (активное размещение в `user_placements`) → таймзона тенанта (`Europe/Kyiv` по умолчанию). Значение пишется
в `user_activity_events.tz`, `local_date` вычисляется один раз и **никогда не пересчитывается**. Причина: сеть точек в одном
часовом поясе — частный случай, а не правило; и даже в одной таймзоне перевод человека или переезд точки не должен задним числом
переписывать всю его карту. Событие в 00:40 по Киеву у человека с точки в UTC+4 попадает в **следующий** локальный день; граница
суток — локальная полночь, не UTC и не полночь тенанта.

`user_activity_daily` пересчитывается раз в час за текущий локальный день человека и финально — через 6 часов после окончания его
суток (поправка на поздние события с ручной проверки). Уровни `[решение]` по **количеству событий**, не по времени: `0` — нет;
`1` — 1–2; `2` — 3–5; `3` — 6–10; `4` — больше 10. Время подвержено «відкрив і пішов», количество завершённых действий — нет;
`seconds_spent` хранится и показывается в подсказке, но заливку определяет не оно.

> [исправлено, реализация PR-34] (1) **Агрегат обновляется в транзакции события**, а не часовым пересчётом (Р-34.1):
> счётчик, разбивка по видам и уровень дня — `insert … on conflict do update` той же командой, что пишет событие, —
> карта видит событие сразу, а «поздние события с ручной проверки» попадают в свой день в момент записи, без окна в
> 6 часов. Пересчёт событий в агрегат задним числом не выполняется вовсе: после `activity.purge` пересчитывать было
> бы не из чего — именно это и сломало бы карту прошлых лет (критерий 12). (2) **Секунды дня** — не из событий, а из
> сегментов учёта времени (`learning_time_sessions.credited_seconds`, PR-21), начатых в локальный день человека; их
> сводит задача `activity.aggregate` (§11). Писатели агрегата трогают разные колонки и не перетирают друг друга.
> (3) **Цепочка пояса** — одна на продукт (`personTimezone()`, `server/services/activity.ts`): `users.timezone` → пояс
> точки активного на дату события размещения (основное — первым, в день перевода — новое; дата размещения берётся в
> календаре тенанта) → **у кандидата — пояс точки вакансии** (размещений у него нет; тот же источник брал PR-37 для
> тихих часов) → пояс тенанта. По ней же теперь считаются тихие часы уведомлений (`docs/23` §3.3). (4) **`occurred_at`
> — момент действия самого человека** (Р-34.3): итог попытки ложится в день **сдачи** (день проверки — работа
> проверяющего, у него `review_graded`), принятое замечание — в день **подачи**, прогон чек-листа, досланный из
> офлайна, — в свой `finishedAt`; момент из будущего не принимается. Остальное — момент записи. (5) Сбой записи события
> (например, пояс точки, которого Postgres не знает) не откатывает действие: запись идёт в точке сохранения и теряет
> только это событие. Ранее: «`user_activity_daily` пересчитывается раз в час за текущий локальный день человека и
> финально — через 6 часов после окончания его суток».

### 7.11 Глубина хранения и доступ к чужой ленте

`user_activity_events` — **400 дней**, затем `activity.purge` удаляет физически (365 дней карты плюс запас на поздние пересчёты
и високосный год). `user_activity_daily` — бессрочно: одна строка на человеко-день, 365 строк в год на человека, отчёты за прошлые
годы строятся по ней. Чужая лента доступна руководителю текущей точки человека, HR и `admin`; ментору — только по людям, чьи работы
у него в очереди проверки, и только за последние 90 дней. Employee видит только свою. В публичной оргструктуре
(`32-org-structure.md`) и в выгрузках для коллег ленты нет.

### 7.12 Нормы отсутствий: граница ответственности

**Lola не ведёт кадровый учёт.** Она не формирует приказы об отпуске, не рассчитывает компенсации и отпускные, не является
источником истины для бухгалтерии и не заменяет табель. Норма и остаток в карточке — **справочная величина** с одним
функциональным следствием: планировщик не ставит дедлайн обязательного обучения на дни, покрытые отсутствием, и не шлёт
напоминания в эти дни (§7.14). Обоснование границы:
1. Кадровый учёт регулируется законодательством и требует документов, подписей и приказов, которых LMS не производит и производить
   не должна. Показывать число дней без документа под ним как «остаток отпуска» — значит выдать справочную цифру за кадровую.
2. Два источника истины по отпуску (кадровая система и LMS) гарантированно разойдутся, и разойдутся молча. Объявив LMS заведомо
   несамостоятельным источником, мы делаем расхождение безвредным: в спорном случае прав кадровый документ, всегда.
3. При этом без знания об отсутствии планировщик генерирует дедлайны на дни, когда человека нет, и производит ложные «прострочено» —
   а это реальный ущерб. Именно эта потребность оправдывает хранение нормы, и ровно ею объём функции ограничен.

### 7.13 Разрешение нормы и расчёт остатка

Порядок — **по каждому виду отдельно**, первое непустое значение: `user` (scope_id = человек) → `location` (текущая точка) →
`tenant` → системный дефолт (відпустка 24, лікарняний 5). `vacation_days` и `sick_days` **раздельно nullable**: точка вправе
переопределить только больничный, отпуск при этом наследуется от компании — на эталоне колонка «Включено відпустки» пуста у всех
13 филиалов, и это как раз «наследую». Норма привязана к **календарному году** `[решение]`, не к рабочему от даты приёма: иначе
у каждого свой расчётный период, и планирование обучения по сети становится непостроимым; дата приёма в середине года **не
уменьшает** норму пропорционально — Lola не начисляет дни, она отображает норму. Остаток:
`залишок(вид) = resolved_норма(вид, рік) − Σ days_count` по `absence_records` этого вида со `status='approved'`, попавшим в год
(частично попавший период учитывается пересечением диапазона с годом). `days_count` — **календарные** дни диапазона:
пересчитывать их в рабочие значило бы вести производственный календарь, то есть перейти границу §7.12.

### 7.14 Смена точки в середине года и влияние на планирование

Норма **не пересчитывается пропорционально и не делится между точками**: действует норма той точки, где человек числится на дату
расчёта, а уже использованные дни переносятся целиком. Следствие, которое надо принять, а не прятать: если новая норма меньше
использованного, остаток становится отрицательным и показывается красным — «Перевищено на {X} днів». Обучение при этом не
блокируется ничем, уходит `absence_norm_exceeded` в HR. Списать дни автоматически Lola не вправе (§7.12): это кадровое решение,
принимается человеком и фиксируется индивидуальной корректировкой с причиной.

Планирование: при создании назначения с дедлайном планировщик проверяет `absence_records` со `status in ('planned','approved')`.
Дедлайн, попавший в отсутствие, сдвигается на первый рабочий день после возвращения, в назначении фиксируется
`deadline_shifted_reason='absence'`. Если в отсутствие попадает весь срок прохождения — назначение создаётся, но стартует в день
возвращения. Напоминания в дни отсутствия не шлются. Добровольное обучение не ограничивается: запретить человеку учиться
в отпуске нельзя.

> [дополнено, PR-33] Решения по реализации (`server/services/absences.ts`, `46-progress.md`, запись PR-33):
> - **Что сдвигается.** Срок записи на курс (`enrollments.due_at`) **обязательного** назначения,
>   не начатой или в процессе, — и только если у этапа курса включена возможность `deadline`:
>   решает `stageCan()` (`33` §3.3, инвариант 16), курс без этапа — полный набор. Срок — параметр
>   назначения (CLAUDE.md п. 11), контент не трогается. Добровольное назначение не сдвигается.
> - **Когда.** При раскрытии назначения (та же транзакция, до уведомления «Вам призначено» — оно уже
>   несёт новую дату), при записи или правке отсутствия и ночной задачей `absence.deadline_guard`
>   (05:30, раньше `due.scan`) — для отсутствий, внесённых мимо формы. Сроки из CSV назначения
>   проходят ту же проверку. Только вперёд: прошедший срок не трогается (§12).
> - **Куда.** «Первый рабочий день после возвращения» `[решение]` (Г-38.8) — первый день с
>   понедельника по пятницу после всей цепочки смыкающихся записей (отпуск и сразу за ним
>   больничный — одно отсутствие); выходные — как у срока починки жалобы (`36` §7.6),
>   производственного календаря Lola не ведёт (§7.12). Время суток срока сохраняется в поясе точки
>   человека (иначе тенанта): 15 июля 18:00 → 21 июля 18:00. Новый срок, снова попавший в
>   отсутствие, сдвигается ещё раз.
> - **«Весь срок в отсутствии».** Если и старт записи в той же цепочке, не начатая запись получает
>   `starts_at` = день возвращения («Заплановано», доступ не закрывается — «запретить учиться в
>   отпуске нельзя»); относительный срок («N днів з моменту призначення», `docs/15` §7.4)
>   отсчитывается от этого старта, календарный — по общему правилу. Начатую запись в
>   «Заплановано» не возвращаем — сдвигается только срок.
> - **Офбординг.** Срок не уезжает за последний рабочий день открытого случая офбординга `[решение]`:
>   после него человек не работает, а курс офбординга обязан быть пройден до ухода.
> - **Отмена отсутствия** сдвинутый срок назад не возвращает `[решение]`: сдвиг только дал время,
>   молча отнятое — дало бы ложное «прострочено». Ручное продление (`POST
>   /manage/enrollments/:id/extend`) и срок из CSV снимают `deadline_shifted_reason`.
> - **Журнал.** Каждый сдвиг — `audit_log` `enrollment.deadline_shifted` (было/стало, `trigger`:
>   `assignment` | `absence` | `daily`), `enrollment_events` `extended` с `reason: absence`,
>   уведомление `absence_deadline_shifted` (§8).
> - **Напоминания.** `due.scan` не шлёт человеку «залишилось N днів», «сьогодні останній день» и
>   «прострочено» в дни, когда на его местную дату есть отсутствие `planned` или `approved` (§4);
>   эскалация руководителю идёт. Пропущенные напоминания не досылаются.

### 7.15 Светофор дедлайна и счётчик модулей

Цвет «Дедлайн»: бирюзовый `#2BBFAE` — больше 3 дней запаса; жёлтый `#FFC933` — 3 дня и меньше; коралловый `#FF6B4A` — просрочен;
без дедлайна — серое «Без дедлайну». «Пройдено модулів: X/Y»: Y — число модулей **той версии курса**, на которую человек записан
(`enrollments.course_version_id`), а не текущей опубликованной, иначе добавление модуля автором задним числом «откатывает»
прогресс уже прошедшим.

## 8. Уведомления

| Код | Событие | Канал | Кому | Шаблон (uk) |
|---|---|---|---|---|
| `person_document_expiring` | `valid → expiring` | push + Telegram | человеку, руководителю точки, HR | «Документ «{тип}» дійсний до {дата}. Залишилось {N} днів.» |
| `person_document_expired` | `expiring → expired` | push + Telegram | тем же | «Документ «{тип}» прострочено {дата}. Потрібно оновити.» |
| `person_document_missing` | обязательный тип отсутствует 7 дней после приёма | Telegram | руководителю точки, HR | «У {ПІБ} немає обовʼязкового документа «{тип}».» |
| `person_note_shared` | `visibility → shared_with_person` | push | человеку | «Керівник поділився з вами нотаткою.» |
| `person_note_flagged` | сохранение с `flagged_at` | внутреннее | `admin` | «Нотатку збережено з ознаками чутливого змісту.» |
| `absence_norm_exceeded` | остаток стал отрицательным | Telegram | HR | «У {ПІБ} залишок «{вид}» відʼємний: {X} днів.» |
| `absence_deadline_shifted` | дедлайн сдвинут из-за отсутствия | push | человеку, руководителю | «Дедлайн «{трек}» перенесено на {дата}: ви у відсутності.» |
| `rating_formula_changed` | смена `formula_version` | внутреннее | `admin` | «Формулу індексу залученості змінено. Історичні значення збережено.» |

В дни, покрытые `absence_records` со `status='approved'`, уведомления не отправляются, кроме `person_document_expired`:
документ истекает независимо от отпуска.

> [дополнено, PR-33] Сделаны `absence_deadline_shifted` (человеку — «ви у відсутності», руководителю —
> с именем, адресат по `resolveManager()`) и тишина **напоминаний о сроках** обучения (§7.14,
> критерий §13 к. 10). Общая тишина всех кодов в дни `approved`-отсутствия и `absence_norm_exceeded`
> с `absence.balance_scan` (§11) в PR-33 не входят — «Входит» плана и критерии 9–10 их не называют;
> остались в `46-progress.md`, запись PR-33.

## 9. Отчёты и выгрузки

1. **«Документи співробітників»** — ПІБ · Посада · Точка · Тип · Статус · Виданий · Дійсний до · Залишилось днів · Хто завантажив.
   Фильтры: точка, посада, тип, статус, период истечения; режим «Тільки відсутні обовʼязкові».
2. **«Прострочені та близькі до завершення»** — то же с фиксированным `status in ('expiring','expired')`, сортировка по `expires_at`.
3. **«Норми і залишки відсутностей»** — ПІБ · Точка · Вид · Норма · Джерело норми · Використано · Залишок; фильтр «Тільки відʼємний залишок».
4. **«Навчальна активність»** — ПІБ · Точка · Днів з активністю · Найдовша серія · Усього подій · Годин; период произвольный, строится по `user_activity_daily`.
5. **«Індекс залученості»** — ПІБ · Точка · Основа · Достроковість · Регулярність · Внесок · Разом. Выгружается **только** с явной
   галкой (§7.3); первой строкой файла — «Показник довідковий, не призначений для кадрових рішень».
6. **Заметки не выгружаются вовсе** `[решение]` — ни в каком виде, ни для какой роли. Выгружаемый свободный текст о людях неизбежно
   оказывается в почте и мессенджерах, где не действуют ни срок хранения (§7.6), ни аудит чтения (§7.6). Единственный законный
   канал выдачи содержания — выгрузка персональных данных по запросу самого человека.

## 10. API

> [исправлено фазой 1, `43` §5, `44` В-16 §8.2.7] Ранее: коды `activity_forbidden`,
> `rating_forbidden`, `note_forbidden` для отказа по скоупу. В `server/api` для «нет скоупа»
> действует одно написание — `forbidden`; три уточняющих кода заменены им.

| Метод | Путь | Вход | Выход | Ошибки |
|---|---|---|---|---|
| GET | `/people/:id/activity?year=` | — | `{days:[{date,count,seconds,level,kinds}],year,timezone}` | `403 forbidden`, `404` |
| GET | `/people/:id/action-log` | — | последние 100 записей `audit_log` человека (прежний «Журнал дій») | `403` |
| GET | `/people/:id/rating` | — | `{total,base,bonuses:{…},breakdown,window,updatedAt}` | `403 forbidden` |
| POST | `/people/:id/rating/recalc` | — | `{jobId}` | `403`, `429 recalc_too_often` (1 раз в час) |
| GET/POST | `/people/:id/notes` | `{body,visibility,category,isPinned}` | список / объект | `403 forbidden`, `422 note_body_invalid`, `409 pinned_limit` |
| PATCH/DELETE | `/people/:id/notes/:noteId` | `{body?,visibility?}` | объект | `403`, `409 visibility_narrowing_forbidden` |
| GET/POST | `/people/:id/documents` | `{typeId,mediaId?,number?,issuedAt,expiresAt?,title?,note?}` | список / объект | `422 document_file_not_allowed`, `422 document_file_required`, `422 document_dates_invalid` |
| PATCH/DELETE | `/people/:id/documents/:docId` | `{expiresAt?,status?,note?}` | объект | `403`, `409 document_is_evidence` |
| CRUD | `/person-document-types` | поля §3.5 | | `409 type_in_use` при деактивации используемого |
| GET | `/people/:id/absences?year=` | — | `{norms:{vacation:{value,source},sick:{…}},used,remaining,records:[…]}` | `403` |
| PUT | `/absence-norms` | `{scopeType,scopeId,year,vacationDays?,sickDays?,reason?}` | объект | `422 reason_required`, `403 forbidden` |
| POST/PATCH | `/people/:id/absences` | `{kind,dateFrom,dateTo,status,comment?}` | объект | `409 absence_overlap`, `422 absence_record.range_invalid` |
| GET | `/reports/documents` · `/reports/absences` · `/reports/activity` · `/reports/rating` | фильтры §9 | курсорная страница | `403` |

> [уточнено, реализация PR-34] Ответ `GET /people/:id/activity` шире строки таблицы: `{year, years, timezone, window:
> {from, to}, scope, days, totals: {activeDays, events, seconds}}` — `years` (селектор: с первого дня активности до
> текущего), `window` (доступное смотрящему окно: у проверяющего `from` — 90 дней назад, `to` — сегодня человека),
> `scope` (`self` · `full` · `reviewer`, §2). `?year=` — 2000…2100, иначе `400 validation_failed`; без него — текущий год
> по часам человека. Скоупа на входе нет — права решает сервис (своя лента без скоупа, §2). Прежний контракт этого пути
> («последние 100 записей `audit_log`», `43` §3) переехал на `GET /people/:id/action-log` без изменений.

Все мутации идемпотентны по `Idempotency-Key`; чужой тенант — `404`. `GET /people/:id/notes` **порождает запись в `audit_log`**
(§7.6) — единственный `GET` в продукте с побочным эффектом, это сознательно.

> [исправлено, реализация PR-32] Лента `GET /people/:id/notes` — страницами с ключевым курсором (`docs/04` §4.1, общая
> утилита `shared/domain/keyset.ts`): порядок «закреплённые, затем новые», `meta.cursor`; каждая страница — своя запись
> `person_note.read` со своими `note_ids`. Список документов человека не листается: он ограничен по построению (по типу —
> один действующий и его история) и сверяется целиком со строками-заглушками обязательных типов, которые без полного списка
> не построить. Добавлены пути: `GET /people/:id/notes/count` — число для свёрнутой секции «Нотатки (N)»
> без чтения содержания и без журнала; `GET /people/:id/notes/:noteId` — прямая ссылка (архивная заметка — только
> администратору, §7.6); `GET /people/:id/documents/:docId/file` — файл документа **только через документ** и его права
> (общий `GET /media/:id` файлы `origin='person_document'` не отдаёт: `learn.view` есть у каждого). Коды сверх таблицы:
> `409 note_sensitive_suspected` (подтверждение скрина §6.1), `409 person_archived` (уволенный — только чтение, §7.6),
> `409 note_archived`, `422 reason_required` (чужая заметка удаляется с причиной, §7.5), `422 document_type_invalid`,
> `422 document_file_invalid` и `422 document_file_not_ready` (свой, дошедший до хранилища, ещё не привязанный PDF/JPG/PNG
> до 20 МБ), `409 document_revoked` (у отменённого меняется только примечание), `409 type_is_system`. `409 type_in_use` —
> только на **удаление** используемого типа: деактивация разрешена, строка таблицы «при деактивации используемого»
> противоречила §12 («тип уходит из формы добавления, записи остаются»), модульный текст побеждает. Удалить документ
> обязательного типа нельзя вовсе — `409 document_is_evidence`, его отменяют с причиной. Своё право на `media.upload` для
> загрузки себе документа `self_upload` не нужно: `origin='person_document'` — происхождение самообслуживания
> (`SELF_SERVICE_ORIGINS`, `server/services/media.ts`). Ключ идемпотентности `Idempotency-Key` в репозитории не реализован
> ни для одной ручки — PR-32 его не вводит.

> [исправлено, реализация PR-33] Пути отсутствий: `GET /people/:id/absences?year=` — сверх
> `{norms,used,remaining,records}` ещё `levels` (значения уровней для формы §6.3), `missedDeadlines`
> (§12) и `can` (права смотрящего); у нормы — `setAt`, `setBy`, `reason` индивидуальной. `POST`
> и `PATCH /people/:id/absences/:absenceId` — раздельные строки (`docs/04` §4.21), ответ несёт
> `meta.shifted`. Коды сверх таблицы: `409 absence_status_invalid` (статус назад, §4),
> `409 absence_cancelled`, `409 person_archived` (уволенный — только чтение), `403 forbidden`.
> `absence_record.range_invalid` — написание этой таблицы, а не `absence_range_invalid` из `41` §5
> (коллизия `41` §8.2.6: модульный документ побеждает, у отсутствия проверяющего —
> `reviewer_absence.range_invalid`). Видеть чужие отсутствия — тот же `person.absence.manage` в
> области точки: отдельного скоупа просмотра `38` §2 не вводит.

## 11. Фоновые задачи

| Задача | Расписание | Что делает |
|---|---|---|
| `activity.aggregate` | каждый час | пересчёт `user_activity_daily` за текущий локальный день каждого активного человека |
| `activity.finalize` | ежечасно | финальный пересчёт дня через 6 часов после локальной полуночи человека |

> [исправлено, реализация PR-34] Счётчик, разбивка и уровень дня пишутся в транзакции события (§7.10), пересчитывать их
> задачей нечего. `activity.aggregate` сводит только **секунды дня** из сегментов учёта времени: ежечасно (в :25) —
> дни, чьи сегменты менялись за 120 минут, и раз в сутки (04:50 по Киеву) — за 48 часов; второй проход и есть
> «финальный пересчёт» — догоняет поздно закрытые сегменты и пропущенные прогоны. Отдельной `activity.finalize` нет.
> `activity.purge` — как в таблице, 03:00 по Киеву; агрегат не трогает. Обе — круг `runPerTenant`, тенант — внутри
> `withTenant()`. Ранее: две задачи пересчёта агрегата из событий.
| `activity.purge` | ежесуточно 03:00 | удаление `user_activity_events` старше 400 дней |
| `rating.recalc` | ежесуточно 04:00, партиями по 500 | полный пересчёт §7.1, запись снимка, снятие `is_current` с прошлого, обновление `users.rating_pct` |
| `documents.expiry_scan` | ежесуточно 06:00 | переходы `valid→expiring→expired`, отправка §8 |
| `documents.missing_scan` | ежесуточно 06:10 | поиск отсутствующих обязательных документов |
| `notes.archive_scan` | ежесуточно 02:00 | `archived_at` по срокам §7.6 |
| `notes.sensitive_screen` | при сохранении + еженедельная переборка по обновлённому словарю | лексический скрин §7.5 |
| `absence.balance_scan` | ежесуточно 05:00 | пересчёт остатков, `absence_norm_exceeded` |
| `absence.deadline_guard` | при создании назначения + ежесуточно 05:30 | сдвиг дедлайнов §7.14 |

> [дополнено, PR-33] `absence.deadline_guard` работает (pg-boss, круг `runPerTenant`) и сверх
> «при создании назначения» — при записи и правке отсутствия. `absence.balance_scan` не сделан —
> см. §8 [дополнено, PR-33].

## 12. Крайние случаи

- **Перевод между точками 30 июня.** Карта целостна: `local_date` каждого события посчитан в таймзоне точки **на момент события**.
  Норма берётся по новой точке, использованные дни переносятся полностью.
- **Точка в UTC+4, событие в 00:40 по Киеву** попадает в следующий локальный день человека, а не в киевский. Клетка сдвигается — верно.
- **Рейтинг 130 %** достижим только при 100 % основы и трёх максимальных бонусах; показывается как «130 %», не обрезается.
- **Нет назначений за 12 месяцев** → `rating_pct = null`, в списке «—», не «0 %».
- **Документ с `expires_at` в прошлом при загрузке** принимается, сразу `expired`, в форме предупреждение «Документ уже прострочено»:
  запрещать нельзя, HR вносит исторические записи.
- **Обязательный тип деактивирован, документы по нему есть** — тип уходит из формы добавления, записи остаются, строка-заглушка больше не показывается.
- **Попытка загрузить скан к `medical_book`** → `422 document_file_not_allowed`, «Для цього типу документа зберігається лише факт наявності».
- **Автор заметки уволен** — заметка остаётся, автор показывается как «{ПІБ} (архівований)», править может только `admin`.
- **Человек запросил выгрузку своих данных** — в неё входят все заметки о нём, включая `visibility='hr'`, и список фактов чтения без имён читавших.
- **Норма точки уменьшена задним числом, остаток −3** — красным, обучение не блокируется, уведомление HR; автосписание запрещено `[решение]`.
- **Отсутствие внесено задним числом на уже просроченный дедлайн** — дедлайн не воскрешается автоматически, правило работает только
  вперёд; в карточке появляется «Дедлайн минув під час відсутності» и кнопка «Перенести» для руководителя.
- **Два документа одного типа подряд** — первый автоматически `revoked` («Замінено документом від {дата}»), активным остаётся один.

## 13. Критерии приёмки

1. **Дано** сотрудник завершил 8 из 10 обязательных назначений, в среднем на 20 % раньше срока, серия 15 дней, 10 зачтённых действий
   помощи, **коли** выполнен `rating.recalc`, **тоді** `rating_pct = 80 + 2 + 5 + 5 = 92.0`, и экран §5.3 показывает все четыре слагаемых с этими числами.
2. **Дано** 100 % основы и максимальные бонусы, **тоді** в списке «130 %», значение не обрезано, поповер заголовка объясняет, почему больше 100.
3. **Дано** `GET /people?filter={rating_pct:{lt:50}}` как единственное условие массового архивирования, **тоді** `422 rating_only_filter_forbidden`.
4. **Дано** руководитель открыл секцию «Нотатки» чужой карточки, **тоді** в `audit_log` появилась `person_note.read` с перечнем `note_ids` и без текста.
5. **Дано** заметка `shared_with_person`, **коли** сменить видимость на `manager`, **тоді** `409 visibility_narrowing_forbidden`.
6. **Дано** заметке 25 месяцев, категория `performance`, **коли** отработал `notes.archive_scan`, **тоді** `archived_at` заполнен,
   заметка исчезла из карточки и доступна `admin` по прямой ссылке.
7. **Дано** тип `medical_book` с `is_fact_only=true`, **коли** `POST /people/:id/documents` с `mediaId`, **тоді** `422 document_file_not_allowed`, запись не создана.
8. **Дано** инструктаж с охраны труда истекает через 30 дней, **тоді** ушли уведомления человеку, руководителю точки и HR, статус `expiring`.
9. **Дано** компания 24 дня, точка переопределила только больничный (7), индивидуальной корректировки нет, **тоді** резолвинг даёт
   відпустка 24 («Норма компанії») и лікарняний 7 («Норма точки»).
10. **Дано** обязательное назначение с дедлайном 15 июля и отпуск 10–20 июля, **коли** назначение создано, **тоді** дедлайн 21 июля,
    `deadline_shifted_reason='absence'`, напоминания 10–20 июля не отправлены.
11. **Дано** человек на точке UTC+4, событие в 22:40 UTC, **тоді** `local_date` — следующий календарный день, клетка закрашена в нём.
12. **Дано** `user_activity_events` старше 400 дней, **коли** отработал `activity.purge`, **тоді** события удалены, а карта
    за позапрошлый год по-прежнему строится из `user_activity_daily`.

## 14. Сверено с эталоном

| Находка | Источник | Что взято |
|---|---|---|
| Блок «Активність за N» (год), тепловая карта, легенда | `04-employees.md` §4.2 | §3.3, §5.1, §7.9–7.11 |
| «Нотатки (0)» / «Документи (0)» как сворачиваемые секции со счётчиком | `04-employees.md` §4.2 | §5.1 |
| «Дата народження», «Дата працевлаштування» | `04-employees.md` §4.2, §4.3 | §1: ложатся в существующие `users.birth_date`, `users.hired_at` |
| Колонка «%» со значениями 101 %, 102 % | `04-employees.md` §4.1 | §7.1: индекс с потолком 130, не процент прохождения |
| «Пройдено модулів X/Y», «Плановий час», «Час проходження», светофор дедлайна | `04-employees.md` §4.2 | §5.1, §7.15; алгоритм времени — `37-review-delegation.md` |
| Группировка «Призначені треки» по категориям | `04-employees.md` §4.2 | §5.1; перечень этапов — `33-lifecycle.md` |
| «Кількість днів відпустки»: 24 / 5, компания → точка → HR в карточке | `10-settings.md` §10.1 | §3.6, §5.4, §7.13 |
| Колонка «Включено відпустки» у филиалов, пустая у всех 13 | `10-settings.md` §10.2 | §7.13: пусто = наследование, поля раздельно nullable |

Не подтверждено эталоном и принято решением Lola: формула рейтинга и потолок, модель видимости заметок, справочник типов
документов, `absence_records` как сущность, закрытый список событий активности. См. §15.

## 15. Гипотезы и принятые по ним решения

**Г-38.1 — смысл колонки «%».** Аудит (Г-04.2) не установил, что именно считает эталон. `[решение]` Lola вводит собственный индекс
по §7.1 с потолком 130 и обязательным экраном расшифровки. *Чем проверяется:* открыть на эталоне карточку человека с «102 %»
и посмотреть, есть ли там расшифровка. Если формула эталона окажется иной — менять `formula_version`, историю не переписывать (§7.2).

**Г-38.2 — типы событий активности.** Аудит (Г-04.4) не раскрыл, что логируют «квадратики»; в легенде на пустых данных виден один
тип «Інше». `[решение]` Закрытый список из двенадцати значений §3.3, вход в систему исключён. *Чем проверяется:* открыть карточку
человека с реальной активностью и раскрыть легенду карты.

**Г-38.3 — содержимое секций «Нотатки» и «Документи».** Аудит (Г-04.5) снял только счётчики «(0)». `[решение]` Модель §3.4–3.5
спроектирована самостоятельно. *Чем проверяется:* создать на эталоне заметку и документ и посмотреть состав полей и наличие
выбора видимости.

**Г-38.4 — видит ли сотрудник заметки о себе.** На эталоне не проверяемо: нет доступа под учётной записью рядового сотрудника.
`[решение]` §7.4: по умолчанию не видит, счётчик не скрывается, содержание выдаётся по запросу субъекта ПД. *Чем проверяется:*
вход под сотрудником на эталоне; независимо от результата решение Lola не меняется — оно принято по правовому основанию, а не по эталону.

**Г-38.5 — переопределение нормы на уровне точки.** Колонка «Включено відпустки» пуста у всех филиалов, форма филиала не
открывалась (Г-10.5). `[решение]` §7.13: `vacation_days` и `sick_days` раздельно nullable, null = наследование.
*Чем проверяется:* открыть форму редактирования филиала и посмотреть, одно там поле или два.

**Г-38.6 — учитывает ли эталон факт отсутствия, а не только норму.** Не наблюдалось. `[решение]` Lola заводит `absence_records`:
без факта норма бессмысленна — остаток считать не из чего, а планировщик дедлайнов (§7.14) и есть единственное оправдание функции.
*Чем проверяется:* поискать на эталоне экран внесения отпуска; если его нет, подтверждается, что 24/5 там чистая справка,
и наше расширение осознанно.

**Г-38.7 — строка `person_document` в политиках хранения `34-storage.md` §7.3.** Документ её не заводил. `[решение]` `notify_only`
+ `retention_until = expires_at + 3 роки`. *Чем проверяется:* правка таблицы `34` §7.3 отдельной строкой при сведении пакета.

**Г-38.8 — что такое «первый рабочий день после возвращения» (§7.14)** `[решение, PR-33]`. Документ не определяет
рабочие дни, а производственного календаря Lola не ведёт (§7.12). `[решение]` Будни — понедельник–пятница, как у срока
починки жалобы (`36` §7.6); день возвращения — день после всей цепочки смыкающихся отсутствий. Для общепита, где
суббота рабочая, это даёт лишние выходные дни запаса, а не отнятые. *Чем проверяется:* на эталоне — есть ли у тенанта
настройка рабочих дней; в эксплуатации — жалобы на «дедлайн у понеділок, хоча я виходжу в суботу».
