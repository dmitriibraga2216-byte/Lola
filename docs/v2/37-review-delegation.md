# Lola LMS — ТЗ. 37. Очередь проверки: делегирование, нагрузка и метрики времени

## 1. Назначение и границы

Очередь ручной проверки в Lola уже описана: `13-workshops.md` §5.2–5.3 (очередь сдач практикумов, захват карточки, SLA 48 часов, запрет самопроверки) и `14-certification.md` §3.3, §5.2–5.3 (витрина `review_queue_items` поверх трёх источников: развёрнутый ответ теста, сдача практикума, очное подтверждение). Этот документ **ничего из перечисленного не отменяет**. Он добавляет к существующей очереди ровно три вещи, которых в базовом ТЗ нет.

**(1) Делегирование.** Проверяющий передаёт конкретную работу другому проверяющему и видит отдельный список «Делеговані мною» — на эталоне Sintegrum это второй таб над таблицей очереди, единственный наблюдаемый след механизма (`06-review.md` §5, Г-06.5). В базовом ТЗ есть только массовое переназначение руководителем (`13` §12): там руководитель распоряжается чужой работой, здесь проверяющий — своей.

**(2) Метрики времени.** Раздельный учёт **«Час на контент»** (сколько человек изучал материал) и **«Час на випробування»** (сколько выполнял задание), плюс **«Розрахунковий час»** — плановая оценка, против которой сравнивается факт. На эталоне это три отдельные колонки очереди из десяти. В базовом ТЗ есть `lesson_progress.seconds_spent` (`11` §3.5) и `attempts.time_spent_sec` (`12` §3.6) — два несвязанных счётчика без общего алгоритма, без защиты от «открытой вкладки» и без плановой величины.

**(3) Управление нагрузкой проверяющих.** Правила распределения, круговое назначение, учёт отсутствия (отпуск, больничный, увольнение), SLA с предупреждением и эскалацией, отчётность по проверяющим.

**Субъект проверки — не только сотрудник.** С появлением `28-recruiting-candidates.md` в очередь попадают работы кандидатов. Наставник видит карточку кандидата **только в объёме назначенной ему проверки** (`28` §2): ответ, критерии, история попыток; телефон, e-mail и резюме не показываются. Делегирование обязано это ограничение сохранять, а не обходить.

**Входит:** делегирование и его отзыв, конфликт интересов, сбор и подсчёт времени, нормы времени контента, правила распределения, ёмкость и отсутствия проверяющих, SLA и эскалация, экран очереди, отчётность. **Не входит:** сами практикумы (`13`), тесты (`12`), аттестация и сертификаты (`14`), оценка 360° (`20` — назначение оценщиков там своё и не делегируется), жалобы на контент (`36` — там проверяют контент, а не человека).

---

## 2. Роли и скоупы

Новые скоупы: `review.delegate`, `review.delegate.any` (делегировать чужую работу), `review.routing.manage`, `review.workload.view`, `review.absence.manage`, `time.metrics.view`.

| Действие | employee | mentor | manager | author | admin |
|---|:-:|:-:|:-:|:-:|:-:|
| Видеть свою очередь «Мої» | — | ✓ | ✓ | — | ✓ |
| Делегировать свою работу | — | ✓ | ✓ | — | ✓ |
| Видеть табы «Делеговані мною» / «мені» | — | ✓ | ✓ | — | ✓ |
| Отозвать своё делегирование | — | ✓ | ✓ | — | ✓ |
| Отозвать чужое делегирование, переназначить, править правила распределения | — | — | ✓ своей области | — | ✓ |
| Перебросить очередь отсутствующего, видеть экран нагрузки | — | — | ✓ | — | ✓ |
| Отмечать отсутствие | — | ✓ только своё | ✓ | — | ✓ |
| Видеть чужое «Час на контент» / «на випробування» | — | ✓ по своей области | ✓ | ✓ агрегат без имён | ✓ |
| Видеть «Розрахунковий час» и отклонение план/факт | — | ✓ | ✓ | ✓ | ✓ |
| Видеть своё собственное время | ✓ | ✓ | ✓ | ✓ | ✓ |
| Видеть отчёт по проверяющим | — | — | ✓ | — | ✓ |

[решение] Автор контента видит метрики времени **в агрегате и без имён**: медиана, p25, p75, размер выборки. Ему нужно понять, что урок читается втрое дольше заявленного, а не кто читал медленно (§7.14).

---

## 3. Сущности и поля

### 3.1 `create table review_queue_items`

> [исправлено, решение `44-decisions.md` В-2 и сверка `43-reconciliation.md` Р-3: объекта не
> существовало ни в схеме, ни в БД — ни таблицы, ни представления, ни матвью, поэтому `alter`
> по нему неисполним; «повышение витрины до таблицы» на деле оказалось созданием с нуля]
> Ранее: «`alter table review_queue_items`» с 21 колонкой по существующей витрине.

Реализовано миграцией `0066_v2_review_queue` (PR-18) как `create table` с идентичностью
(`task_type`, `source_id`, `user_id`, `location_id`, `position_id`, `submitted_at`, `status`,
`priority` — из `docs/14` §3.3) плюс перечисленные ниже колонки состояния. Полный DDL —
`docs/02-data-model.md`, раздел «Очередь проверки». Два отличия реализации от списка ниже,
оба зафиксированы в `docs/v2/46-progress.md`:

- **одна ось вместо двух** — колонки `source` из В-2 нет: `task_type` указывает и таблицу
  источника, и подпись в интерфейсе, а две колонки одной оси однажды разойдутся;
- **`attempts_count` называется `attempt_no`** — как одноимённая колонка
  `workshop_submissions` с тем же смыслом.

Колонки `delegation_id` и `assigned_by_rule_id` заведены без внешних ключей: таблицы
`review_delegations` и `review_routing_rules` появляются в PR-19, он же ставит оба ключа
(развязка цикла `40` §5 0022).

```sql
-- Историческая запись патча: как было заявлено до сверки с репозиторием.
alter table review_queue_items
  add column subject_kind text not null default 'employee',
  add column task_type text not null default 'workshop',
  add column task_title text, add column track_id uuid, add column estimated_seconds int,
  add column attempts_count int not null default 1, add column completed_at timestamptz,
  add column content_seconds int not null default 0, add column attempt_seconds int not null default 0,
  add column time_confidence text not null default 'ok', add column delegation_id uuid,
  add column assigned_reviewer_id uuid references users(id), add column assigned_at timestamptz,
  add column assigned_by_rule_id uuid, add column origin_reviewer_id uuid references users(id),
  add column delegation_depth int not null default 0, add column sla_hours int not null default 48,
  add column sla_warned_at timestamptz, add column sla_breached_at timestamptz,
  add column escalated_at timestamptz, add column escalated_to_id uuid references users(id),
  add constraint rqi_subject_kind_chk check (subject_kind in ('employee','candidate')),
  add constraint rqi_task_type_chk check (task_type in
    ('quiz_open_answer','workshop','offline_confirm','survey_open','ai_interview_review')),
  add constraint rqi_time_confidence_chk check (time_confidence in ('ok','partial','unreliable')),
  add constraint rqi_depth_chk check (delegation_depth between 0 and 2);
create index idx_review_queue_items_tenant on review_queue_items (tenant_id, status, sla_due_at);
create index idx_review_queue_items_reviewer on review_queue_items (tenant_id, assigned_reviewer_id, status) where status <> 'done';
create index idx_review_queue_items_origin on review_queue_items (tenant_id, origin_reviewer_id) where delegation_id is not null;
```

| Поле | Тип | Обяз. | По умолчанию | Валидация | Комментарий |
|---|---|:-:|---|---|---|
| `subject_kind` | text | да | `employee` | 2 значения | Сотрудник или кандидат; управляет маскировкой ПД (§7.2) |
| `task_type` | text | да | `workshop` | 5 значений | Колонка и фильтр «Тип завдання» эталона |
| `task_title`, `track_id` | text, uuid | нет | — | ≤200; FK курс/траектория | Колонки «Назва завдання» (снимок на момент сдачи) и «Трек» |
| `attempts_count` | int | да | 1 | ≥1 | «Кількість спроб» — какая по счёту сдача |
| `estimated_seconds` | int | нет | — | 60–216000 | «Розрахунковий час», снимок нормы (§3.5) |
| `content_seconds` | int | да | 0 | ≥0 | «Час на контент», зачтённое время изучения (§7.11) |
| `attempt_seconds` | int | да | 0 | ≥0 | «Час на випробування», зачтённое время выполнения |
| `time_confidence` | text | да | `ok` | 3 значения | Достоверность измерения (§7.15) |
| `completed_at` | timestamptz | нет | — | — | Колонка «Дата виконання» |
| `assigned_reviewer_id`, `assigned_at` | uuid, timestamptz | нет | — | FK `users` | Текущий ответственный и момент назначения |
| `assigned_by_rule_id` | uuid | нет | — | FK `review_routing_rules` | Каким правилом назначено; null — вручную |
| `delegation_id` | uuid | нет | — | FK `review_delegations` | Активное делегирование |
| `origin_reviewer_id` | uuid | нет | — | FK `users` | Первый в цепочке, не меняется при A→B→C |
| `delegation_depth` | int | да | 0 | 0–2 | Глубина цепочки, жёсткий предел 2 (§7.3) |
| `sla_hours` | int | да | 48 | 1–720 | Снимок из практикума или аттестации |
| `sla_warned_at`, `sla_breached_at`, `escalated_at` | timestamptz | нет | — | — | Отметки порогов 50 / 100 / 150 % (§7.19) |
| `escalated_to_id` | uuid | нет | — | FK `users` | Кому ушла эскалация |

### 3.2 `review_delegations`

```sql
create table review_delegations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  queue_item_id uuid not null references review_queue_items(id) on delete cascade,
  from_user_id uuid not null references users(id), to_user_id uuid not null references users(id),
  depth int not null default 1, reason_code text not null, reason_text text,
  due_at timestamptz not null, state text not null default 'active',
  accepted_at timestamptz, resolved_at timestamptz,
  revoked_by uuid references users(id), revoke_reason text,
  created_at timestamptz not null default now(),
  constraint rd_reason_chk check (reason_code in
    ('absence','workload','expertise','conflict_of_interest','location_change','other')),
  constraint rd_state_chk check (state in
    ('active','resolved','revoked_by_author','revoked_by_manager','revoked_sla','cancelled')),
  constraint rd_self_chk check (from_user_id <> to_user_id), constraint rd_depth_chk check (depth between 1 and 2),
  constraint rd_text_chk check (reason_code <> 'other' or length(coalesce(reason_text,'')) between 10 and 500)
);
create index idx_review_delegations_tenant on review_delegations (tenant_id, from_user_id, state);
create index idx_review_delegations_to on review_delegations (tenant_id, to_user_id, state);
create unique index uq_review_delegations_active on review_delegations (tenant_id, queue_item_id) where state = 'active';
```

### 3.3 `review_routing_rules` — правила распределения

```sql
create table review_routing_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name_uk text not null, priority int not null default 100,
  match_scope jsonb not null default '{}'::jsonb, match_subject_kind text,
  match_task_types text[] not null default '{}', strategy text not null default 'round_robin',
  reviewer_ids uuid[] not null default '{}', fallback_user_id uuid references users(id),
  sla_hours_override int, is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references users(id),
  constraint rrr_strategy_chk check (strategy in
    ('location_mentor','course_author','specific_list','round_robin','least_loaded','manual')),
  constraint rrr_sla_chk check (sla_hours_override is null or sla_hours_override between 1 and 720),
  constraint rrr_subject_chk check (match_subject_kind is null or match_subject_kind in ('employee','candidate'))
);
create index idx_review_routing_rules_tenant on review_routing_rules (tenant_id, priority) where is_active;
```

`match_scope` — `{"location_ids":[…],"org_node_ids":[…],"position_ids":[…],"course_ids":[…]}`; пустой объект = весь тенант. Выигрывает первое подошедшее правило по `priority`, остальные не применяются.

### 3.4 `reviewer_capacity`, `reviewer_absences`, `review_sla_events`, `reviewer_stats_daily`

```sql
create table reviewer_capacity (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  max_open_items int not null default 20, daily_target int not null default 10,
  accepts_delegation boolean not null default true, task_types text[] not null default '{}',
  rr_cursor int not null default 0, updated_at timestamptz not null default now(),
  constraint rc_max_chk check (max_open_items between 1 and 200),
  constraint rc_daily_chk check (daily_target between 1 and 200), unique (tenant_id, user_id)
);
create index idx_reviewer_capacity_tenant on reviewer_capacity (tenant_id, user_id);

create table reviewer_absences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null, starts_on date not null, ends_on date, substitute_id uuid references users(id),
  move_open_items boolean not null default true, created_by uuid references users(id),
  created_at timestamptz not null default now(),
  constraint ra_kind_chk check (kind in ('vacation','sick','training','dismissal','other')),
  constraint ra_range_chk check (ends_on is null or ends_on >= starts_on),
  constraint ra_dismissal_chk check (kind <> 'dismissal' or ends_on is null),
  constraint ra_sub_chk check (substitute_id is null or substitute_id <> user_id)  -- §7.18
);
create index idx_reviewer_absences_tenant on reviewer_absences (tenant_id, user_id, starts_on);

create table review_sla_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  queue_item_id uuid not null references review_queue_items(id) on delete cascade,
  reviewer_id uuid references users(id), event text not null, due_at timestamptz,
  overdue_hours numeric(8,2), target_id uuid references users(id),
  created_at timestamptz not null default now(),
  constraint rse_event_chk check (event in
    ('assigned','warned','breached','escalated','reassigned','resolved','delegation_expired'))
);
create index idx_review_sla_events_tenant on review_sla_events (tenant_id, queue_item_id, created_at desc);

create table reviewer_stats_daily (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  reviewer_id uuid not null references users(id) on delete cascade, day date not null,
  reviewed_count int not null default 0, accepted_count int not null default 0,
  rejected_count int not null default 0, rework_count int not null default 0,
  delegated_out int not null default 0, delegated_in int not null default 0,
  breached_count int not null default 0, own_content_count int not null default 0,
  median_react_sec int, median_review_sec int, unique (tenant_id, reviewer_id, day)
);
create index idx_reviewer_stats_daily_tenant on reviewer_stats_daily (tenant_id, day desc);
```

### 3.5 `content_time_norms` — «Розрахунковий час» элемента контента

```sql
create table content_time_norms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  subject_type text not null, subject_id uuid not null, source text not null default 'auto',
  author_seconds int, auto_seconds int, observed_seconds int, observed_p25 int, observed_p75 int,
  observed_sample int not null default 0, deviation_flag text not null default 'none',
  recalculated_at timestamptz, updated_by uuid references users(id),
  constraint ctn_subject_chk check (subject_type in ('lesson','quiz','workshop','track_node')),
  constraint ctn_source_chk check (source in ('author','auto','observed')),
  constraint ctn_author_chk check (author_seconds is null or author_seconds between 60 and 216000),
  constraint ctn_flag_chk check (deviation_flag in ('none','too_fast','too_slow','no_data')),
  unique (tenant_id, subject_type, subject_id)  -- одна норма на элемент
);
create index idx_content_time_norms_tenant on content_time_norms (tenant_id, subject_type, deviation_flag);
```

`lessons.estimated_minutes` (`11` §3.1) остаётся полем автора и синхронизируется в `author_seconds` при сохранении материала; авторитетной для очереди и отчётов становится эта таблица.

### 3.6 `learning_time_sessions` и `learning_time_totals`

```sql
create table learning_time_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  enrollment_id uuid references enrollments(id) on delete cascade,
  subject_type text not null, subject_id uuid not null, kind text not null,
  session_key uuid not null, segment_no int not null default 1, beats_count int not null default 0,
  started_at timestamptz not null, last_beat_at timestamptz not null, closed_reason text,
  credited_seconds int not null default 0, discarded_seconds int not null default 0,
  device text, is_offline_replay boolean not null default false,
  constraint lts_kind_chk check (kind in ('content','attempt')),
  constraint lts_subject_chk check (subject_type in ('lesson','quiz','workshop','track_node')),
  constraint lts_closed_chk check (closed_reason is null or closed_reason in
    ('completed','idle_timeout','segment_cap','daily_cap','navigated_away','session_end','stale')),
  constraint lts_credited_chk check (credited_seconds between 0 and 5400),
  unique (tenant_id, session_key, segment_no)  -- защита от повторной догрузки
);
create index idx_learning_time_sessions_tenant on learning_time_sessions (tenant_id, user_id, subject_type, subject_id, kind);
create index idx_learning_time_sessions_open on learning_time_sessions (tenant_id, last_beat_at) where closed_reason is null;

create table learning_time_totals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  enrollment_id uuid references enrollments(id) on delete cascade,
  subject_type text not null, subject_id uuid not null, confidence text not null default 'ok',
  content_seconds int not null default 0, attempt_seconds int not null default 0,
  discarded_seconds int not null default 0, sessions_count int not null default 0,
  first_started_at timestamptz, last_activity_at timestamptz,
  constraint ltt_conf_chk check (confidence in ('ok','partial','unreliable')),
  unique (tenant_id, user_id, subject_type, subject_id, enrollment_id)  -- витрина §7.12
);
create index idx_learning_time_totals_tenant on learning_time_totals (tenant_id, subject_type, subject_id);
```

`credited_seconds` — зачтённое время сегмента (потолок 5400 с = 90 мин, §7.11); `discarded_seconds` — выброшенный простой и непринятая офлайн-догрузка; `closed_reason` — одна из семи причин закрытия (§4).

> [исправлено, PR-21: DDL не давал выполнить §10, §12 и §7.11 — решение Р-21.1 в `46-progress.md`]
> Ранее: DDL §3.6 без перечисленного ниже. Миграция `0078_v2_learning_time` добавляет к
> `learning_time_sessions` общие `created_at`/`updated_at` (`docs/02`, преамбула; по
> `updated_at` свёртка находит изменившиеся пары), `last_seq` и `last_credit` —
> идемпотентность по `(session_key, seq)` (§10, §12): уникальность `(session_key, segment_no)`
> не помнит биений, и повтор без них нечем узнать и нечего вернуть; `media_seconds` — потолок
> «1,5 × довжина медіа» (§7.11) суммарный по элементу, без своего счётчика его не проверить;
> частичный уникальный индекс `uq_learning_time_sessions_open_pair` по
> `(tenant_id, user_id, subject_type, subject_id) where closed_reason is null` — правило §4
> «открытый сеанс один» становится инвариантом базы. У `learning_time_totals` уникальность
> `nulls not distinct`: прохождение вне курса (`enrollment_id is null`) — тоже одна строка.

### 3.7 Дополнения к таблицам прогресса

```sql
alter table lesson_progress add column content_seconds int not null default 0,
  add column discarded_seconds int not null default 0, add column sessions_count int not null default 0;
alter table attempts add column net_seconds int not null default 0, add column discarded_seconds int not null default 0;
alter table workshop_submissions add column attempt_seconds int not null default 0, add column content_seconds int not null default 0;
```

`lesson_progress.seconds_spent` и `attempts.time_spent_sec` **не удаляются**: остаются «сырой» величиной (от открытия до закрытия) и расходятся с новыми полями ровно на выброшенный простой. Отчёты используют новые поля, старые — материал для отладки алгоритма.

---

## 4. Состояния и переходы

**Элемент очереди** (расширяет `waiting → in_review → done` из `14` §3.3):

| Статус | Значение | Переходы |
|---|---|---|
| `waiting` | ждёт проверяющего, назначен или нет | → `in_review`, `delegated`, `escalated` |
| `in_review` | карточка захвачена | → `done`, → `waiting` (отпустил или 30 мин бездействия, `13` §4.2) |
| `delegated` | ответственность передана делегату | → `in_review`, `waiting` (отзыв), `escalated` |
| `escalated` | срок нарушен на 150 %, поднято руководителю | → `in_review`, `done` |
| `done` | решение принято | конечное |

**Делегирование** (`review_delegations.state`): `active → resolved` (делегат принял решение) · `revoked_by_author` (отозвал делегировавший) · `revoked_by_manager` · `revoked_sla` (делегат не уложился, §7.5) · `cancelled` (работа аннулирована или человек уволен до проверки).

**Сеанс измерения** (`learning_time_sessions.closed_reason`): открыт → закрыт одной из семи причин §3.6. Открытых сеансов у человека по одному элементу `subject` не больше одного, в каком бы виде `kind` он ни был; попытка открыть второй закрывает первый с `navigated_away`.

> [исправлено, PR-21: «пара `(subject, kind)`» противоречила §7.12 «виды не пересекаются» —
> решение Р-21.4] Ранее: «Открытых сеансов у человека по одной паре `(subject, kind)` не
> больше одного». При паре с видом сеанс чтения условий и сеанс попытки одного теста могли
> бы быть открыты одновременно — ровно то, что §7.12 запрещает.
>
> `stale` — причина **предварительная** (решение Р-21.5): если тот же `session_key`
> возвращается с биением, сеанс не был аварийным — он простаивал, и `stale` переписывается на
> `idle_timeout`. Иначе человек, отошедший на 10 минут, получал бы `time_confidence =
> 'unreliable'` («все сеансы закрыты через `stale`», §7.15) за обычный перерыв.

---

## 5. Экраны

### 5.1 Очередь проверки — `/review` (дополнение к `14` §5.2)

**Табы:** «Мої» · «Делеговані мені» · «Делеговані мною» · «Завершені». Первые два рабочие, третий контрольный (что я отдал и в каком оно состоянии), четвёртый — архив. Счётчик на «Мої» считает `waiting` + `in_review`, просроченные в нём коралловые.

**Колонки** (первые десять — состав эталона дословно и в том же порядке): «Прізвище, Ім'я» · «Філії» · «Трек» · «Тип завдання» · «Назва завдання» · «Кількість спроб» · «Розрахунковий час» · «Час на контент» · «Час на випробування» · «Дата виконання». Добавлено `[решение]`: «Перевіряючий» (пусто = не назначен), «Термін» (остаток SLA), «Ким делеговано» (только на «Делеговані мені»), «Статус делегування» (только на «Делеговані мною»), «Відхилення» (факт/план, §7.14).

**Фильтры** (эталонные + добавленные): «Філії» · «Трек» · «Вибрати період» (диапазон дат, поле «–») · «Тип завдання» · `[решение]` «Перевіряючий» · «Тип суб'єкта» (Співробітники / Кандидати / Усі) · переключатель «Лише прострочені».

**Массовые действия:** «Взяти 10 у роботу» (`14` §5.2), `[решение]` «Делегувати обрані» (≤25 строк, один делегат, одна причина), «Відкликати делегування» (на «Делеговані мною»), «Переназначити» (только `review.delegate.any`). **Пустые состояния:** «Мої» — «Черга порожня. Усе перевірено»; «Делеговані мені» — «Вам нічого не делегували»; «Делеговані мною» — «Ви нікому не передавали перевірку. Передати роботу можна кнопкою «Делегувати» у картці»; «Завершені» — «За обраний період перевірок не було». Загрузка — скелетон на 10 строк. Ошибка — «Не вдалося завантажити чергу» и кнопка «Спробувати ще раз».

### 5.2 Карточка проверки — дополнения (к `13` §5.3, `14` §5.3)

Шапка получает строку времени: «Розрахунковий час 12 хв · Контент 27 хв · Випробування 9 хв» со значком отклонения. При `time_confidence <> 'ok'` рядом серая подпись «Час виміряно неповно» с объяснением причины.

Кнопка «Делегувати» — рядом с «Пропустити»; при `delegation_depth = 2` неактивна, подсказка «Глибше передавати не можна: це вже друга передача». Плашка конфликта интересов (§7.7–7.8): коралловая «Ви не можете перевіряти власну роботу» с заблокированными кнопками решения либо жёлтая «Ви автор цього матеріалу — оцінюйте роботу, а не свій контент».

При `subject_kind = 'candidate'` показаны ответ, критерии, история попыток; блок контактов и резюме заменён серой плашкой «Контактні дані кандидата доступні рекрутеру» (`28` §2).

### 5.3 Три служебных экрана

**Нагрузка проверяющих — `/review/workload`.** Таблица: ім'я, філія, відкрито / `max_open_items` (полоса, коралловая при перегрузе), перевірено за 7 днів, медіана реакції, прострочено, «делеговано мені / мною», присутствие («На місці» / «Відпустка до 12.10» / «Звільнений»). Действия в строке: «Перекинути чергу», «Позначити відсутність», «Змінити ліміт». Пусто: «У цій області ще немає перевіряючих. Призначте роль наставника».

**Правила розподілу — `/review/routing`.** Список правил по `priority`: назва, область, типи завдань, стратегія, перевіряючі, SLA, перемикач активності, перетаскивание для смены приоритета. Внизу строка «Якщо жодне правило не підійшло: {fallback}». Пусто: «Правил немає — роботи розподіляються за наставниками точки».

**Норми часу — `/content/time-norms`.** Таблица: назва, тип, розрахунковий час, джерело (Автор / Авто / За фактом), медіана факту, p25–p75, вибірка, відхилення. Фильтр по отклонению: «Швидше за план», «Повільніше за план», «Немає даних». Над таблицей жёлтая плашка: «Це показник якості матеріалу, а не швидкості людей. Відхилення означає, що план поставлено неточно або матеріал складний».

---

## 6. Формы

### 6.1 Делегування перевірки

| Поле | Контрол | Обяз. | Валидация | Ошибка (uk) |
|---|---|:-:|---|---|
| Кому делегувати | поиск по проверяющим | ✓ | только доступные (§7.2) | «Ця людина не має доступу до цієї точки» |
| Причина | селект | ✓ | 6 значений | «Оберіть причину» |
| Пояснення | текст | при «Інше» | 10–500 | «Поясніть причину: 10–500 символів» |
| Термін для делегата | дата-время | ✓ | ≥ +12 год, ≤ `sla_due_at` элемента | «Термін не може бути пізнішим за термін перевірки» |
| Повідомити делегата | переключатель | — | вкл. по умолчанию | — |

Подсказка под выбором: «У {ім'я} зараз {N} робіт у черзі, ліміт {M}»; при `N ≥ M` жёлтая плашка «Перевіряючий перевантажений» — предупреждение, не запрет. Причины: «Відсутність», «Перевантаження», «Потрібна інша експертиза», «Конфлікт інтересів», «Зміна точки», «Інше».

**Відкликання делегування** — одно поле: причина, 0–500 знаков, необязательно. Подтверждение: «Роботу буде повернено вам. {ім'я} отримає повідомлення». Если делегат уже в `in_review`: «{ім'я} вже перевіряє цю роботу — відкликати не можна».

### 6.2 Відсутність перевіряючого

| Поле | Контрол | Обяз. | Валидация | Ошибка (uk) |
|---|---|:-:|---|---|
| Тип | селект | ✓ | 5 значений | — |
| З | дата | ✓ | — | — |
| По | дата | при типе ≠ «Звільнення» | ≥ «З» | «Дата завершення не може бути раніше початку» |
| Заміщує | поиск | — | не сам себе | «Не можна призначити заміщення самому собі» |
| Перекинути відкриті роботи | переключатель | — | вкл. по умолчанию | — |

### 6.3 Норма часу елемента

| Поле | Контрол | Обяз. | Валидация | Ошибка (uk) |
|---|---|:-:|---|---|
| Джерело | радио | ✓ | Автор / Авто / За фактом | — |
| Розрахунковий час | число хвилин | при «Автор» | 1–3600 | «Від 1 хвилини до 60 годин» |

При `observed_sample ≥ 20` под полем: «За фактом люди витрачають {медіана} хв (вибірка {N}). Застосувати?» — одно нажатие. Молча система норму не меняет никогда.

---

## 7. Правила и алгоритмы

### Делегирование

1. **Модель — передача ответственности, а не второй проверяющий** `[решение]`. Делегат становится единственным ответственным: работа уходит из «Мої» делегировавшего и появляется в «Мої» делегата. Обоснование: два проверяющих на одной работе дают либо двойную оценку (чей вердикт главный?), либо диффузию ответственности (оба ждут другого); и то и другое хуже ясной передачи. Цена — отдельный таб «Делеговані мною» и правило возврата по просрочке (п. 5). След не теряется: `origin_reviewer_id` хранит первого ответственного навсегда, `review_delegations` — всю цепочку, отчёт §9.2 — долю делегированного у каждого.
2. **Кто кому может делегировать.** Делегирует тот, кому работа назначена (`assigned_reviewer_id`), при наличии `review.delegate`. Делегат обязан одновременно: (а) иметь `review.grade`; (б) иметь область, покрывающую `location_id` элемента (`01-roles.md`) — **нельзя делегировать тому, кто не имеет доступа к этой точке**; (в) при `subject_kind='candidate'` иметь право на назначенную проверку кандидата (`28` §2); (г) не быть самим проверяемым (п. 7); (д) иметь `accepts_delegation = true`. Нарушение (а)–(г) — `422 review.delegate_target_forbidden`, (д) — `422 review.delegate_target_declines`. Список в форме отфильтрован заранее: недоступные не показываются вовсе.
3. **Цепочка.** A→B→C разрешена, `delegation_depth` растёт на 1 за передачу, предел 2: C делегировать дальше не может (`422 review.delegate_depth_exceeded`). Цикл запрещён — делегат не может совпасть ни с одним участником цепочки (`422 review.delegate_cycle`). Обоснование предела: при глубине 3+ ни делегировавший, ни руководитель уже не знают, у кого работа, и эскалация (п. 19) теряет адресата.
4. **Возврат после проверки.** Работа делегировавшему **не возвращается**: решение делегата окончательное, `state = 'resolved'`, делегировавший получает `review_delegation_resolved` и видит результат на табе «Делеговані мною». Обоснование: возврат на утверждение превратил бы делегирование в двухступенчатую проверку и удвоил срок — ровно то, от чего делегирование спасает.
5. **Делегат не уложился.** В `due_at` делегирования работа **автоматически возвращается** делегировавшему: `state = 'revoked_sla'`, `assigned_reviewer_id = from_user_id`, `delegation_depth − 1`, обоим уходит `review_delegation_expired`, в `review_sla_events` пишется `delegation_expired`. Исходный `sla_due_at` элемента **не сдвигается** — иначе делегирование стало бы способом бесплатно продлить срок.
6. **Отзыв.** Делегировавший отзывает своё делегирование, пока элемент в `waiting` или `delegated`. Как только делегат перевёл в `in_review` — `409 review.delegation_in_progress`; руководитель с `review.delegate.any` может отозвать и тогда, с обязательной причиной. Любой отзыв возвращает `assigned_reviewer_id` делегировавшему и пишется в `audit_log`.

### Конфликт интересов

7. **Запрет: проверяющий = автор ответа.** Элемент, где `review_queue_items.user_id` равен текущему пользователю, не показывается ему **никогда** — ни в «Мої», ни в «Делеговані мені», ни в поиске. Правило действует и при делегировании (нельзя делегировать человеку его же работу), и при круговом распределении, и при перебросе очереди отсутствующего. Если после исключения проверяющих не осталось — работа уходит руководителю области (`14` §7.9). Это расширение существующего `workshops.self_review_forbidden` на всю очередь, включая делегирование, которое раньше защиту обходило бы.
8. **Предупреждение: проверяющий = автор контента.** Если пользователь входит в `lessons.author_ids` или создал проверяемый практикум, карточка показывает жёлтую плашку «Ви автор цього матеріалу — оцінюйте роботу, а не свій контент», решение **не блокируется**, факт пишется в `audit_log` (`review.graded_own_content`) и идёт в отчёт §9.2 отдельной колонкой. Почему предупреждение, а не запрет: в сети из двух точек автор чек-листа кухни часто единственный, кто способен оценить его выполнение; запрет оставил бы очередь без проверяющего.
9. **Руководитель не обязан проверять того, кого сам обучал** `[решение]`. Если руководитель был назначенным наставником проверяемого по этому же треку (`16`), при назначении ему работы он видит плашку «Ви навчали цю людину за цим треком» и кнопку «Передати іншому» — делегирование в один клик с преднаполненной причиной `conflict_of_interest`. Это не запрет и не автопереадресация: обязанность снимается, право остаётся.

### Метрики времени

10. **Сбор — heartbeat, а не разница «открыл/закрыл»** `[решение]`. Клиент на экране прохождения создаёт `session_key` (uuid) и каждые **30 секунд** шлёт `POST /learning/time/beat` с `{session_key, seq, kind, subject_type, subject_id, active_ms, visible, client_ts}`, где `active_ms` — сколько миллисекунд за истекший интервал была активность (`mousemove`, `keydown`, `scroll`, `touchstart`, `pointerdown`, `timeupdate` у видео). Биение **не отправляется**, если `document.hidden = true` или активности не было вовсе.
11. **Зачёт на сервере.** За каждое биение зачитывается `credit = min(active_ms/1000, server_now − prev_beat_server_ts, 30)` секунд. Клиентское время в расчёт не входит (защита от переведённых часов); `client_ts` нужен только для упорядочивания и офлайн-догрузки. Пороги и обоснование:
    - **Интервал 30 с.** Максимальная ошибка — 30 с на сеанс. Трафик: урок на 20 минут = 40 биений по ~200 байт; при 43 сотрудниках и 5 уроках в день ≈ 1,7 МБ/сутки на тенант — величина, которую можно не оптимизировать.
    - **Порог неактивности 120 с** (4 пропущенных биения). Если следующее биение пришло позже чем через 120 с, **вся пауза не засчитывается**, сеанс закрывается с `idle_timeout`, новое биение открывает новый сегмент (`segment_no + 1`). Почему 120, а не 60: одно потерянное биение на мобильном интернете — норма, два подряд — уже нет; 120 с переживают флап сети и не переживают кофе.
    - **Потолок сегмента 90 минут (5400 с).** При достижении сегмент закрывается с `segment_cap`, клиент показывает «Ви ще тут?»; время стоит, пока человек не нажмёт «Продовжити», затем открывается новый сегмент. Почему 90: самый длинный практикум Каппі — около 40 минут, 90 даёт двукратный запас и остаётся верхней границей правдоподобного непрерывного внимания.
    - **Потолок суток 8 часов (28800 с)** на связку «человек × элемент × вид». Сверх — биения принимаются с `200`, но не зачитываются, сеанс закрывается с `daily_cap`. Почему 8: рабочая смена; больше — либо артефакт, либо не обучение.
    - **Минимальный сеанс 10 с.** Сегменты короче отбрасываются целиком — это случайное открытие.
    - **Фоновая вкладка.** `document.hidden` → биения прекращаются немедленно, ноль зачёта; пауза дольше 120 с закрывает сеанс. Исключение одно — **воспроизведение видео или аудио**: зачитывается прирост позиции воспроизведения (`timeupdate`) независимо от видимости, но суммарно не более `1,5 × довжина медіа`, чтобы перемотка и повторный просмотр не накручивали время.
    - **Потеря связи.** Клиент буферизует до **200 биений** в `localStorage` (это 100 минут) и досылает пакетом `POST /learning/time/beats` при восстановлении. Сервер принимает пакет, если старейшее биение не старше **24 часов**, дедуплицирует по `(session_key, seq)`, зачитывает по интервалам `client_ts` (серверных у них нет) и ставит `is_offline_replay = true`. Пакет старше 24 часов отбрасывается, потеря пишется в `discarded_seconds`.
    - **Аварийное завершение** (закрыли вкладку, разрядился телефон): сеанс без биений более 120 с закрывается фоновой задачей с `stale`, зачтено остаётся пришедшее. Задним числом ничего не достраивается.
12. **Суммирование.** `content_seconds` = сумма `credited_seconds` сеансов с `kind='content'` по всем сегментам и устройствам; `attempt_seconds` — то же для `kind='attempt'`. Виды не пересекаются: при открытии теста или формы сдачи сеанс `content` закрывается с `navigated_away` и открывается сеанс `attempt`; возврат к материалу снова переключает вид. Два устройства одновременно дают два сеанса, которые **суммируются**, а не берутся максимумом, но одновременная работа не даёт больше реального времени: каждое биение зачитывается ещё и не больше, чем прошло по часам сервера с последнего биения этой пары «человек × элемент» на любом устройстве — так и принято в базовом ТЗ (`03` §41: «время не удваивается»).

> [исправлено, PR-21: ссылка на `03` §41 передавала его наоборот — решение Р-21.3]
> Ранее: «Два устройства одновременно дают два сеанса, которые **суммируются**, а не берутся
> максимумом — как уже принято в базовом ТЗ (`03` §41)». `03` §41 говорит: «прогресс
> суммируется по `lesson_progress`, время не удваивается». Последовательная работа на двух
> устройствах суммируется целиком; одновременная — не больше реального времени. Без этого
> правила два открытых экрана (или клиент, плодящий `session_key`) удваивали бы зачёт: каждое
> первое биение нового сегмента зачитывает свои 30 секунд.
13. **«Розрахунковий час» — откуда берётся** `[решение]`. Три источника (`content_time_norms.source`):
    - `author` — автор ввёл вручную (`lessons.estimated_minutes`, `11` §3.1). Приоритетный.
    - `auto` — расчёт по объёму, если автор не задал: текст — `знаків / 1100` минут (≈140 слов в минуту для украинского текста, округление вверх); видео и аудио — фактическая длительность; документ — `сторінок × 2` минуты; тест — `питань × 45` с плюс `розгорнутих питань × 150` с; практикум — только `author` (объём работы вне экрана система оценить не может; при пустом значении в очереди «—»).
    - `observed` — медиана фактического `content_seconds + attempt_seconds` по завершённым прохождениям при `observed_sample ≥ 20`, **никогда не применяется автоматически**: система предлагает, автор нажимает «Застосувати» (§6.4).
14. **Как используется и как НЕ используется.** `estimated_seconds` попадает в очередь снимком на момент сдачи (правка нормы историю не переписывает). Отклонение: `factor = (content_seconds + attempt_seconds) / estimated_seconds`; `factor > 2,0` → `too_slow`, `< 0,4` → `too_fast`, иначе `none`; при выборке меньше 10 прохождений — `no_data`, флаг не ставится. **Отклонение факта от плана — сигнал качества контента, а НЕ основание наказывать человека.** Поэтому: (а) флаг всегда сопровождается текстом «Сигнал якості матеріалу, не оцінка людини»; (б) время не участвует ни в одной формуле балла, зачёта, рейтинга или начисления баллов (`21`) — ни прямо, ни коэффициентом; (в) в отчёте по контенту (§9.3) данные обезличены; (г) поимённая выгрузка доступна только `manager` и `admin` и пишется в `audit_log`. Массовое «слишком долго» значит, что план занижен или материал непонятен; единичное — что у человека был тяжёлый день.
15. **Достоверность.** `time_confidence`: `ok` — покрытие биениями ≥ 80 % интервала «первое открытие … завершение»; `partial` — 40–79 % либо есть офлайн-догрузка; `unreliable` — < 40 %, либо сработал `daily_cap`, либо все сеансы закрыты через `stale`. При `unreliable` колонки времени серые с подписью «неповні дані», строка исключается из расчёта `observed_seconds` и из отчёта план/факт.

### Распределение, SLA, эскалация

16. **Как работа попадает проверяющему.** При появлении элемента ищется первое активное правило по `priority`, чьи `match_scope`, `match_task_types`, `match_subject_kind` подходят. Стратегии: `location_mentor` — наставники точки человека; `course_author` — авторы материала; `specific_list` — `reviewer_ids`; `round_robin` — круговое; `least_loaded` — минимум открытых работ; `manual` — никому, работа висит в общем пуле. Правил нет — поведение базового ТЗ (`13` §7.1). Кандидатов ноль после фильтров п. 2 и п. 7 — `fallback_user_id`, а при его отсутствии руководитель области.
17. **Круговое распределение.** Кандидаты сортируются по `users.id`, указатель `reviewer_capacity.rr_cursor` продвигается на одного за назначение и сохраняется в той же транзакции (`select … for update`). Пропускаются отсутствующие (п. 18), достигшие `max_open_items` и исключённые по конфликту интересов. Если пропущены все — берётся первый по списку с игнорированием лимита, в `review_sla_events` пишется `assigned` с пометкой перегрузки: работа не может остаться неназначенной из-за лимитов.
18. **Отсутствие проверяющего.** Запись с `starts_on ≤ сьогодні` и (`ends_on is null` или `ends_on ≥ сьогодні`) исключает человека из распределения и из списка делегатов. При `move_open_items = true` в момент начала отсутствия все его `waiting` и `delegated` работы переходят на `substitute_id`, а без него перераспределяются правилами заново. Работы в `in_review` не трогаются 30 минут — карточка освободится сама (`13` §4.2). При `kind = 'dismissal'` переброс принудителен, флаг игнорируется, а все активные делегирования, где уволенный — делегат, переводятся в `revoked_sla` с возвратом делегировавшим.
19. **SLA и эскалация.** Срок — `sla_hours` элемента (снимок, по умолчанию 48), отсчёт от `assigned_at`, при отсутствии назначения — от `submitted_at`. Делегирование срок не продлевает (п. 5). Пороги: **50 %** — уведомление проверяющему `review_sla_warning`, `sla_warned_at`; **100 %** — `sla_breached_at`, строка коралловая, руководителю `review_sla_breach`; **150 %** — эскалация: `status = 'escalated'`, `escalated_to_id` = руководитель области, работа появляется в его «Мої» **дополнительно** к текущему проверяющему (единственный случай, когда работу видят двое — чтобы эскалация не выглядела как отъём). Просрочкой в отчётах считается факт `sla_breached_at is not null` на момент решения, а не текущее состояние.
20. **Тихие часы.** Уведомления §8 подчиняются общим правилам доставки (`23` §6): предупреждение, выпавшее на ночь, доставляется в 09:00, но `sla_warned_at` фиксируется по факту события, а не доставки.

---

## 8. Уведомления

| Код | Событие | Канал | Кому | Текст (uk) |
|---|---|---|---|---|
| `review_delegated` | работа делегирована | push + in-app | делегату | «{ім'я} передав вам перевірку «{task}». Термін до {due}» |
| `review_delegation_revoked` | делегирование отозвано | in-app | делегату | «{ім'я} відкликав передану перевірку «{task}»» |
| `review_delegation_resolved` | делегат принял решение | in-app | делегировавшему | «{ім'я} перевірив «{task}»: {decision}» |
| `review_delegation_expired` | делегат не уложился | push + in-app | обоим | «Термін делегування «{task}» минув. Роботу повернено вам» |
| `review_assigned` | работа назначена правилом | in-app | проверяющему | «Вам призначено перевірку «{task}» — {ім'я}, {філія}» |
| `review_sla_warning` | 50 % срока | push | проверяющему | «Залишилось {hours} год на перевірку «{task}»» |
| `review_sla_breach` | 100 % срока | push + e-mail | руководителю области | «Перевірка «{task}» прострочена на {hours} год» |
| `review_escalated` | 150 % срока | push + e-mail | руководителю области | «Перевірку «{task}» ескальовано на вас» |
| `review_queue_moved` | переброс очереди отсутствующего | in-app | принимающему | «Вам передано {N} робіт із черги {ім'я} ({причина})» |
| `review_overloaded` | открыто больше `max_open_items` | in-app | руководителю | «У {ім'я} {N} робіт у черзі при ліміті {M}» |
| `content_time_deviation` | флаг `too_slow`/`too_fast` при выборке ≥ 20 | in-app | автору материала | «Матеріал «{title}»: люди витрачають {fact} хв замість {plan} хв» |

---

## 9. Отчёты и выгрузки

**9.1 «Черга перевірки»** (выгрузка экрана, csv/xlsx). Колонки: Прізвище Ім'я · Тип суб'єкта · Філії · Трек · Тип завдання · Назва завдання · Кількість спроб · Розрахунковий час · Час на контент · Час на випробування · Відхилення · Достовірність · Дата виконання · Перевіряючий · Ким делеговано · Термін · Статус. Фильтры — как на экране (§5.1).

**9.2 «Робота перевіряючих»** (расширяет `13` §9 и `14` §9). Строка — проверяющий за период. Колонки: Перевіряючий · Філії · Перевірено · Прийнято · Відхилено · На доопрацювання · Частка прийнятих · Медіана часу реакції (здача → взяття в роботу) · Медіана часу перевірки (взяття → рішення) · Делеговано мною · Делеговано мені · Частка делегованого (`delegated_out / (reviewed + delegated_out)`) · Прострочено · Ескальовано · Перевірок власного контенту (п. 8). Фильтры: період, філії, тип завдання, тип суб'єкта. Источник — `reviewer_stats_daily` плюс догрузка текущих суток.

**9.3 «План і факт часу»** (по контенту, обезличенный). Колонки: Елемент · Тип · Трек · Розрахунковий час · Джерело норми · Медіана факту · p25 · p75 · Вибірка · Відхилення · Частка недостовірних вимірів. Фильтры: тип элемента, трек, отклонение, минимальный размер выборки. Шапка — жёлтая плашка §5.5.

**9.4 «Делегування»** (журнал). Колонки: Дата · Від кого · Кому · Глибина · Завдання · Причина · Пояснення · Стан · Дата завершення. Фильтры: період, від кого, кому, причина, стан.

---

## 10. API

| Метод | Путь | Вход | Выход | Ошибки |
|---|---|---|---|---|
| GET | `/review/queue` | `?tab=mine\|delegated_in\|delegated_out\|done&taskType&locationId&trackId&from&to&reviewerId&subjectKind&overdue&cursor&limit` | `{data:{items,total,cursor}}` | `403 forbidden` |
| POST | `/review/items/:id/delegate` | `{toUserId, reasonCode, reasonText?, dueAt, notify}` | `{data:{delegationId,item}}` | `422 review.delegate_target_forbidden`, `422 review.delegate_target_declines`, `422 review.delegate_cycle`, `422 review.delegate_depth_exceeded`, `409 review.already_in_review` |
| POST | `/review/delegations/:id/revoke` | `{reason?}` | `{data:{item}}` | `409 review.delegation_in_progress`, `403 forbidden` |
| POST | `/review/items/bulk-delegate` | `{itemIds[≤25], toUserId, reasonCode, dueAt}` | `{data:{ok, failed:[{id,code}]}}` | `422 review.bulk_limit` |
| POST | `/review/items/:id/reassign` | `{toUserId, reason}` | `{data:{item}}` | `403 forbidden` |
| GET | `/review/workload` | `?location&org_node` | `{data:[reviewer]}` | `403 forbidden` |
| POST | `/review/absences` | `{userId, kind, startsOn, endsOn?, substituteId?, moveOpenItems}` | `{data:{absence, movedCount}}` | `422 reviewer_absence.range_invalid`, `422 absence.self_substitute` |
| DELETE | `/review/absences/:id` | — | `{data:{ok:true}}` | `404` |
| CRUD | `/review/routing-rules` | правило §3.3 | `{data:rule}` | `422 routing.scope_empty` |
| POST | `/learning/time/beat` | `{sessionKey, seq, kind, subjectType, subjectId, activeMs, visible, clientTs}` | `{data:{credited, dailyLeft}}` | `422 time.beat_invalid`, `429` |
| POST | `/learning/time/beats` | `{beats:[≤200]}` | `{data:{credited, discarded}}` | `422 time.replay_too_old` |
| GET | `/learning/time/totals` | `?userId&subjectType&subjectId` | `{data:totals}` | `403 forbidden` |
| GET/PUT | `/content/time-norms/:subjectType/:subjectId` | `{source, authorSeconds?}` | `{data:norm}` | `422 norm.value_range` |
| POST | `/content/time-norms/:subjectType/:subjectId/apply-observed` | — | `{data:norm}` | `422 norm.sample_too_small` |
| GET | `/reports/reviewers`, `/reports/time-plan-fact`, `/reports/delegations` | фильтры §9 | `{data:[…]}` | `403 forbidden` |

**Отношение к трём базовым путям `docs/04-api.md` §4.7** (решение `44-decisions.md` В-15,
добавлено PR-18): `/review/queue` — единый список поверх `review_queue_items`; `/review/answers`
и `/review/workshops` остаются **узкими фильтрами** над теми же источниками, потому что несут
фильтры, которых у очереди нет (метки вопросов, «Поза програмами», «Поза курсами», `quizId`), и
на них завязаны работающие экраны. Действия не дублируются: `claim`, `release`, `grade`
остаются на `/review/submissions/:id/*` и `/review/answers/:id/grade` — решение принимается над
работой, а не над строкой очереди, а очередь обновляется тем же сервисом в той же транзакции.
`/review/checklists` вычеркнут из `docs/04-api.md` §4.7 как никогда не существовавший:
подтверждение чек-листа приходит табом `offline_confirm`.

Табы и `taskType` — **две разные оси** (`shared/schemas/review.ts`): таб отвечает на вопрос
«чья это работа сейчас», `taskType` — «что это за работа». В `44` В-15 оба набора значений
названы словом `tab`; экран §5.1 показывает их одновременно, поэтому они разведены.

`POST /learning/time/beat` идемпотентен по `(session_key, seq)` без заголовка `Idempotency-Key`: повтор возвращает тот же `credited` и ничего не начисляет. Остальные мутации — по общему правилу `Idempotency-Key`.

> [исправлено, PR-21: без этих полей правила §7.11–7.12 не исполнимы] Ранее в таблице:
> вход биения — только `{sessionKey, seq, kind, subjectType, subjectId, activeMs, visible,
> clientTs}`, ответ — `{credited, dailyLeft}`. Добавлено: `enrollmentId` (урок входит в
> несколько курсов, `lesson_progress` ведётся по записи — без неё время урока не к чему
> отнести), `device`, `resume` (первое биение после «Продовжити», §7.11, решение Р-21.12),
> `end` (последнее биение экрана — сегмент закрывается `session_end`, а не `stale`); у пакета —
> `sentAt`, время отправки по часам клиента, чтобы исправить сдвиг его часов (Р-21.13). Ответ
> биения дополнен `segmentNo`, `capped`, `stillHere`, `duplicate`; ответ пакета — `accepted`,
> `duplicates`, `rejected` (биения удалённого за время офлайна элемента отбрасываются поштучно,
> остальные принимаются). Чужой или несуществующий элемент и чужая запись — `404` (CLAUDE.md
> п. 15), нарушение протокола сеанса (смена вида, чужой `session_key`) — `422 time.beat_invalid`.

---

## 11. Фоновые задачи

| Задача | Расписание | Что делает |
|---|---|---|
| `review.sla_scan` | ежечасно | пороги 50/100/150 %, уведомления, `review_sla_events`; расширяет одноимённую задачу `14` §11 |
| `review.delegation_expire` | каждые 15 минут | возврат просроченных делегирований (п. 5) |
| `review.absence_apply` | ежедневно 06:00 и при создании записи | включение и снятие отсутствий, переброс очередей |
| `review.rebalance` | ежедневно 07:00 | работы старше 24 часов без `assigned_reviewer_id` — переназначение правилами |
| `time.close_stale_sessions` | каждые 5 минут | закрытие сеансов без биений > 120 с (`stale`) |
| `time.rollup` | каждые 10 минут | свёртка сеансов в `learning_time_totals`, `lesson_progress`, `attempts`, `workshop_submissions` и в колонки времени `review_queue_items` (`content_seconds`, `attempt_seconds`, `time_confidence`); раз в сутки — с окном 48 часов, догоняя пропущенное (Р-21.18) |
| `time.norms_recalc` | еженедельно, ночь воскресенья | пересчёт `observed_seconds`, p25, p75, `deviation_flag`, уведомление автору |
| `review.stats_rollup` | ежедневно 03:00 | заполнение `reviewer_stats_daily` за прошедшие сутки |
| `time.purge_sessions` | ежедневно | удаление `learning_time_sessions` старше 400 дней |

---

## 12. Крайние случаи

- **Делегат уволился, не проверив** → `kind='dismissal'` переводит его делегирования в `revoked_sla`, работы возвращаются делегировавшим, уведомление обоим. **Делегировавший уволился, делегат ещё проверяет** → делегирование продолжается, ответственность уже передана; после решения уведомление уходит руководителю области вместо уволенного.
- **Отпуск делегата начался между открытием формы и отправкой** → сервер проверяет отсутствие в момент выполнения, `422 review.delegate_target_declines`.
- **Урок пройден с телефона в метро без связи** → биения буферизуются и досылаются, `is_offline_replay = true`, `time_confidence = 'partial'`; в расчёт `observed_seconds` такие сеансы входят (они честные), `unreliable` — не входит.
- **Вкладка урока открыта сутки** → первые 90 минут ограничены потолком сегмента, дальше «Ви ще тут?»; зачтено столько, сколько было активности, но не более 8 часов за сутки.
- **Видео поставили на паузу и ушли** → `timeupdate` не приходит, через 120 с сеанс закрывается по `idle_timeout`; пауза не засчитывается.
- **Автор изменил норму после сдачи** → `estimated_seconds` элемента очереди не меняется, новая норма действует на последующие сдачи.
- **Работа кандидата делегирована наставнику без прав на кандидатов** → делегирование разрешено, карточка в ограниченном объёме (`28` §2), контакты скрыты.
- **Эскалация на руководителя, который сам и есть проверяющий** → уходит на уровень выше по `org_nodes` (`32`); выше некуда — администратору тенанта.
- **Единственный проверяющий сам сдал эту работу** → кандидатов ноль, работа уходит руководителю области (`14` §7.9), а не остаётся без адресата.
- **25 работ массово делегированы человеку с лимитом 20** → проходит, руководитель получает `review_overloaded`: лимит — сигнал распределению, а не запрет ручному действию.
- **Два биения с одинаковым `seq`** (повтор после таймаута) → второе возвращает `credited` первого, счётчик не растёт.

---

## 13. Критерии приёмки

1. **Дано** работу призначено наставнику А, **коли** він делегує її Б на +24 год, **тоді** робота зникла з «Мої» у А, з'явилась у «Мої» у Б та у «Делеговані мною» у А, `delegation_depth = 1`, `origin_reviewer_id` = А.
2. **Дано** делегування А→Б, **коли** Б делегує В, **тоді** `delegation_depth = 2`, `origin_reviewer_id` = А; **коли** В делегує далі — `422 review.delegate_depth_exceeded`.
3. **Дано** термін делегування 24 год, **коли** делегат не вирішив, **тоді** робота повернулась до А зі станом `revoked_sla`, обидва отримали повідомлення, а `sla_due_at` елемента не змінився.
4. **Дано** Б відкрив картку (`in_review`), **коли** А натискає «Відкликати» — `409 review.delegation_in_progress`; **коли** те саме робить керівник — відкликання проходить із обов'язковою причиною та записом в `audit_log`.
5. **Дано** наставник сам здав практикум, **тоді** ця робота не з'являється в жодному його табі, не пропонується в круговому розподілі і не може бути йому делегована.
6. **Дано** наставник входить в `author_ids` матеріалу, **тоді** картка показує жовту плашку, кнопки рішення активні, факт у `audit_log` і в звіті §9.2.
7. **Дано** урок відкрито і 3 хвилини без активності, **тоді** зараховано не більше 30 секунд, сеанс закрито з `idle_timeout`, наступна активність відкриває сегмент 2.
8. **Дано** вкладку згорнуто на 10 хвилин під час читання статті, **тоді** час не зараховано; **дано** те саме під час відтворення відео — зараховано приріст позиції відтворення.
9. **Дано** 95 хвилин безперервної активності, **тоді** зараховано 5400 секунд, показано «Ви ще тут?», після підтвердження відкрито новий сегмент.
10. **Дано** телефон без зв'язку 40 хвилин, **коли** зв'язок відновлено, **тоді** биття прийнято, `is_offline_replay = true`, `time_confidence = 'partial'`.
11. **Дано** норму 10 хв і факт 35 хв на вибірці 25, **тоді** `deviation_flag = 'too_slow'`, автор отримав повідомлення, звіт §9.3 без імен, бал жодної людини не змінився.
12. **Дано** правило `round_robin` на трьох наставників, один у відпустці, **коли** надходять 6 робіт, **тоді** вони розподілені 3/3 між присутніми.
13. **Дано** наставник іде у відпустку з 12 відкритими роботами і заміщенням, **коли** настає `starts_on`, **тоді** всі `waiting` і `delegated` переїхали на заміщення, `in_review` лишилась до звільнення картки.
14. **Дано** SLA 48 год, **тоді** на 24-й — повідомлення перевіряючому, на 48-й — керівнику і кораловий рядок, на 72-й — статус `escalated` і робота видно обом.
15. **Дано** роботу кандидата делеговано наставнику, **тоді** він бачить відповідь і критерії, але не бачить телефон, e-mail і резюме.

---

## 14. Сверено с эталоном

Проверено по материалам аудита Sintegrum (`06-review.md`): семь экранов `/review/<категорія>`, шаблон подтверждён на каждом индивидуально.

С эталона перенесено **дословно**: два таба над таблицей («Завершені», «Делеговані мною»); десять колонок в исходном порядке (Прізвище Ім'я · Філії · Трек · Тип завдання · Назва завдання · Кількість спроб · Розрахунковий час · Час на контент · Час на випробування · Дата виконання); четыре фильтра (Філії, Трек, Вибрати період, Тип завдання). Сам факт раздельных колонок «Час на контент» и «Час на випробування» — эталонный, и он же главное основание вводить раздельный учёт: эталон меряет эти величины отдельно, значит разделение имеет практический смысл для линейного персонала.

Всё остальное — наше `[решение]`: механизм и UI делегирования (на эталоне не наблюдались, Г-06.5), модель передачи ответственности, цепочка глубиной 2, отзыв, срок делегата и авто-возврат, правила конфликта интересов, алгоритм измерения времени целиком, источники «Розрахункового часу», правила распределения, ёмкость, отсутствия, SLA с тремя порогами, экраны нагрузки и норм, отчёты §9.2–9.4, два таба сверх эталонных («Мої», «Делеговані мені»).

Связь с базовым ТЗ: очередь и карточка — `14` §3.3, §5.2–5.3; захват и освобождение через 30 минут — `13` §4.2, §7.2; `self_review_forbidden` — `13` §3.1; SLA 48 часов и уведомления `review_sla_warning` / `review_sla_breach` — `14` §7.8, §8; счётчики времени — `11` §3.5, `12` §3.6; `lessons.estimated_minutes` — `11` §3.1; суммирование прогресса с двух устройств — `03` §41; тихие часы — `23` §6; области и скоупы — `01`; кандидаты в очереди и ограниченный доступ наставника — `28` §2, §3.2; уровни руководства для эскалации — `32`.

---

## 15. Гипотезы и принятые по ним решения

**Г-37.1. Механизм делегирования на эталоне.** Наблюдается только таб «Делеговані мною» на пустом экране; кнопка делегирования не найдена (Г-06.5). `[решение]` Передача ответственности (§7.1), не второй проверяющий; глубина 2; возврата после решения нет; авто-возврат по просрочке делегата. Чем проверяется: открыть очередь установки с непроверенными работами, найти действие в строке или карточке и посмотреть, остаётся ли работа в «Мої» у делегировавшего.

**Г-37.2. Есть ли на эталоне таб «Делеговані мені».** Не наблюдался — на эталоне два таба. `[решение]` Вводим четыре: без «Делеговані мені» делегат не отличает переданное от своего, а это единственный способ понять, откуда у него работа. Чем проверяется: войти на эталоне пользователем, которому что-то делегировали.

**Г-37.3. Состав селекта «Тип завдання».** Не раскрыт (Г-06.3). `[решение]` Пять значений (`quiz_open_answer`, `workshop`, `offline_confirm`, `survey_open`, `ai_interview_review`) — ровно те источники ручной проверки, которые существуют в Lola. Чем проверяется: раскрыть селект на установке с данными.

**Г-37.4. Колонка «Розрахунковий час» на `/review/attestation`.** На эталоне не зафиксирована, остальные 9 совпадают (Г-06.6). `[решение]` Колонка выводится во всех категориях без исключения, при отсутствии нормы — «—». Расхождение трактуем как отображение при пустых данных, а не как осознанное отличие: скрывать колонку в одной категории — источник путаницы при сравнении отчётов. Чем проверяется: открыть `/review/attestation` с непустой очередью.

**Г-37.5. Как эталон считает «Час на контент».** Алгоритм в принципе не наблюдаем — это серверная механика. `[решение]` Собственный алгоритм §7.10–7.12: heartbeat 30 с, порог простоя 120 с, потолок сегмента 90 мин, суточный потолок 8 ч. Чем проверяется: на эталоне не проверяется, калибруется по эксплуатации — доля сеансов с `time_confidence <> 'ok'` за первый месяц должна быть ниже 15 %, иначе пороги пересматриваются.

**Г-37.6. Экран детальной проверки одного ответа.** Не снят (Г-06.2: строк в очереди нет). `[решение]` Используется карточка базового ТЗ (`13` §5.3, `14` §5.3) с тремя дополнениями §5.2 — строка времени, кнопка «Делегувати», плашка конфликта интересов. Отдельного макета не заводим. Чем проверяется: кликнуть по строке очереди на установке с данными.

**Г-37.7. Кто на эталоне видит колонки времени.** Права не наблюдались. `[решение]` Поимённо — наставник по своей области, руководитель, администратор; автор контента — только обезличенный агрегат (§2, §7.14). Чем проверяется: на эталоне не проверяется, решение продиктовано правилом «метрика времени не наказывает человека».

**Г-37.8. Нужна ли ёмкость проверяющего.** На эталоне такого понятия не видно. `[решение]` Вводим `max_open_items` = 20 и `daily_target` = 10 по умолчанию. Это не запрет, а вход в круговое распределение и триггер `review_overloaded`. Чем проверяется: медиана длины очереди наставника Каппі за первый квартал; при медиане ниже 5 значение по умолчанию снижается до 10.

**Г-37.9. Два устройства и «один открытый сеанс»** `[решение, PR-21]`. §4 требует одного открытого сеанса на элемент, §7.12 — суммировать два устройства, `03` §41 — не удваивать время. `[решение]` Р-21.3 и Р-21.4 (`46-progress.md`): открытый сегмент у пары «человек × элемент» один (новый закрывает прежний с `navigated_away`), а зачёт биения дополнительно ограничен временем сервера с последнего биения пары на любом устройстве. Последовательная работа на двух устройствах суммируется целиком, одновременная — не больше реального времени. Чем проверяется: доля сегментов с `navigated_away` у пар с двумя `device` за первый месяц; если выше 20 % — люди действительно учатся с двух устройств разом, и стоит показать на втором «Урок відкрито на іншому пристрої».

**Г-37.10. Время в форме жалобы во время попытки** `[решение, PR-21]`. `36` §7.7 (б) возвращает время формы дедлайну, но §7 не говорит, чем оно является для учёта. `[решение]` Р-21.9: это не «Час на випробування» — пока форма жалобы открыта, счётчик экрана стоит, а сервер зачитывает следующему биению только активность после формы; время формы остаётся в `discarded_seconds` попытки. Дедлайн и учёт не читают друг друга: сдвиг `deadline_at` — правило попытки (PR-23), `net_seconds` — учёт, свёртка `deadline_at` не трогает. Чем проверяется: `tests/integration/v2-learning-time.spec.ts`, «время в форме жалобы»; в эксплуатации — `discarded_seconds` попыток с жалобой против попыток без неё.

**Г-37.11. К какой попытке и сдаче относится сегмент** `[решение, PR-21]`. В DDL §3.6 нет ссылки на попытку или сдачу, а §3.7 требует `attempts.net_seconds` и `workshop_submissions.*_seconds`. `[решение]` Р-21.8: привязка по времени. Сегмент выполнения теста — к последней попытке, начатой не позже его начала; чтение условий — к первой попытке, начатой после; сегменты практикума — к первой сдаче, отправленной не раньше их начала, иначе к текущему черновику. Колонку `attempt_id` не заводим: одновременно открытой бывает одна попытка элемента, и порядок во времени однозначен. Чем проверяется: доля попыток с `net_seconds = 0` при `time_spent_sec > 60`; если заметна — привязка теряет сегменты и колонка всё-таки нужна.

**Г-37.12. Чем обеспечено «время стоит, пока не нажмёт «Продовжити»»** `[решение, PR-21]`. `[решение]` Р-21.12: сервером. После `segment_cap` биения без признака `resume` принимаются, запоминаются и не зачитываются; ответ несёт `stillHere`, экран показывает «Ви ще тут?», первое биение после нажатия уходит с `resume` и открывает новый сегмент. Клиент, который прячет вопрос, времени себе не добавит. Чем проверяется: критерий приёмки 9, `v2-learning-time.spec.ts`.

**Г-37.13. Какие сутки у суточного потолка** `[решение, PR-21]`. `[решение]` Р-21.6: скользящие 24 часа по времени последнего биения сегмента, а не календарный день. Потолок — страховка правдоподобия, а не отчётный период: календарные сутки требуют часового пояса человека и дают 16 часов подряд через полночь. Чем проверяется: число сегментов с `daily_cap` за месяц; ожидаемо ноль, любое срабатывание разбирается.

**Г-37.14. Когда у практикума «открыта форма сдачи»** `[решение, PR-21]`. На экране практикума задание и форма сдачи — одна страница (`13` §5.1). `[решение]` Р-21.10: форма считается открытой с первого касания её полей (фокус, клик, файл); до того время — «Час на контент», после — «Час на випробування»; отправленная сдача времени не меряет. Чем проверяется: соотношение `content_seconds` и `attempt_seconds` сдач; если «контент» почти всегда ноль — люди начинают с формы, и чтение задания стоит вынести на отдельный шаг.
