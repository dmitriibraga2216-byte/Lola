# Lola LMS — ТЗ. Часть 2. Модель данных

Все таблицы: `id uuid primary key default gen_random_uuid()`, `tenant_id uuid not null`,
`created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`,
где уместно — `deleted_at timestamptz`. Ниже эти поля в DDL не повторяются, кроме случаев,
где важен состав индекса.

Правило: **на каждой таблице с `tenant_id` включён RLS** (раздел 2.12). Запросы идут только
через `withTenant()`.

## 2.1 Платформа и тенанты

```sql
create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,                 -- kappi
  name text not null,                        -- Каппі
  locale text not null default 'uk',         -- uk | en
  timezone text not null default 'Europe/Kyiv',
  status text not null default 'active',     -- active | suspended | archived
  plan text not null default 'trial',        -- trial | point | network | custom
  trial_ends_at timestamptz,
  branding jsonb not null default '{}',      -- logo_key, accent, space_name
  settings jsonb not null default '{}',      -- флаги модулей, пороги, политика паролей
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

`settings` (валидируется zod-схемой `TenantSettings`): включённые модули, проходной балл
по умолчанию, число попыток по умолчанию, рабочие часы для рассылок, канал уведомлений
по умолчанию, требовать ли подтверждение аттестации очно.

## 2.2 Структура организации

```sql
create table org_units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  parent_id uuid references org_units(id) on delete restrict,
  name text not null,
  path ltree not null,                        -- материализованный путь для быстрых выборок
  unique (tenant_id, path)
);

create table locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  org_unit_id uuid not null references org_units(id),
  name text not null,                         -- Лазарева
  address text,
  timezone text not null default 'Europe/Kyiv',
  manager_id uuid references users(id),
  is_active boolean not null default true
);

create table positions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,                         -- Кухар гарячого цеху
  code text,                                  -- для импорта из учётной системы
  unique (tenant_id, name)
);
```

## 2.3 Люди, роли, сессии

```sql
create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  phone text,                                 -- E.164, уникален в тенанте
  email text,
  full_name text not null,
  avatar_key text,
  locale text,                                -- null → берём локаль тенанта
  status text not null default 'invited',     -- invited | active | suspended | archived
  hired_at date,
  archived_at timestamptz,
  telegram_chat_id bigint,
  password_hash text,                         -- только для e-mail входа
  last_seen_at timestamptz,
  unique (tenant_id, phone),
  unique (tenant_id, email)
);

create table user_placements (                -- где человек работает
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  location_id uuid not null references locations(id),
  position_id uuid not null references positions(id),
  is_primary boolean not null default true,
  started_at date not null default current_date,
  ended_at date
);

create table roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null,                         -- employee | mentor | ... | custom_*
  name text not null,
  scopes text[] not null,                     -- см. 01-roles.md §1.3
  is_system boolean not null default false,
  unique (tenant_id, code)
);

create table user_roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references roles(id),
  scope_type text not null,                   -- tenant | org_unit | location
  scope_id uuid,                              -- null для tenant
  unique (tenant_id, user_id, role_id, scope_type, scope_id)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  user_agent text,
  ip inet,
  impersonated_by uuid references users(id),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table otp_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,                             -- null до выбора пространства
  phone text not null,
  code_hash text not null,
  channel text not null,                      -- telegram | sms
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index on otp_codes (phone, expires_at desc);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_by uuid references users(id)
);
```

## 2.4 Контент: курсы, модули, уроки

```sql
create table courses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  title text not null,
  slug text not null,
  summary text,
  cover_key text,
  category_id uuid references course_categories(id),
  language text not null default 'uk',
  status text not null default 'draft',       -- draft | published | archived
  published_version_id uuid,                  -- → course_versions.id
  estimated_minutes int,
  is_catalog_visible boolean not null default false,
  tags text[] not null default '{}',
  created_by uuid references users(id),
  unique (tenant_id, slug)
);

create table course_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  parent_id uuid references course_categories(id),
  name text not null,
  sort int not null default 0
);

create table course_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  course_id uuid not null references courses(id) on delete cascade,
  version int not null,                       -- 1,2,3…
  status text not null default 'draft',       -- draft | published | retired
  changelog text,
  published_at timestamptz,
  published_by uuid references users(id),
  unique (tenant_id, course_id, version)
);

create table modules (                         -- раздел курса
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  course_version_id uuid not null references course_versions(id) on delete cascade,
  title text not null,
  sort int not null
);

create table lessons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  module_id uuid not null references modules(id) on delete cascade,
  title text not null,
  sort int not null,
  kind text not null,                          -- content | quiz | task | survey | external
  body jsonb,                                  -- структурированный контент (см. 2.5)
  quiz_id uuid references quizzes(id),
  min_seconds int,                             -- минимальное время на уроке
  is_required boolean not null default true
);
```

### 2.5 Формат `lessons.body`

Массив блоков, каждый блок — объект с `type`. Хранение в jsonb, валидация zod.

```jsonc
[
  { "type": "text", "html": "<p>…</p>" },                    // санитизированный html
  { "type": "image", "key": "t/…/img.jpg", "alt": "…" },
  { "type": "video", "key": "t/…/v.mp4", "poster": "…", "duration": 41 },
  { "type": "file",  "key": "t/…/instr.pdf", "name": "Інструкція.pdf" },
  { "type": "callout", "tone": "warn", "text": "…" },        // sun | teal | coral
  { "type": "checklist", "items": ["…", "…"] },
  { "type": "embed", "provider": "youtube", "id": "…" }
]
```

## 2.6 Банк вопросов и тесты

```sql
create table question_banks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null,
  category_id uuid references course_categories(id)
);

create table questions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  bank_id uuid not null references question_banks(id) on delete cascade,
  kind text not null,       -- single | multiple | order | match | number | text_short | text_long | file
  stem jsonb not null,      -- блоки, как в lessons.body (текст + картинка)
  options jsonb,            -- варианты; для number — {value, tolerance, unit}
  answer jsonb,             -- эталон; для text_long — null (ручная проверка)
  explanation text,         -- разбор, показывается после ответа
  is_critical boolean not null default false,  -- провал критического = провал теста
  difficulty int,           -- 1..5, для отбора
  tags text[] not null default '{}',
  version int not null default 1
);

create table quizzes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  title text not null,
  kind text not null default 'quiz',          -- quiz | certification
  pass_score numeric(5,2) not null default 80,
  time_limit_sec int,
  attempts_allowed int not null default 3,
  shuffle_questions boolean not null default true,
  shuffle_options boolean not null default true,
  show_answers text not null default 'after_attempt', -- never | after_question | after_attempt
  question_pick jsonb not null default '{}',  -- правила отбора: {bank_id, count, difficulty}
  requires_review boolean not null default false,
  requires_offline_confirm boolean not null default false
);

create table quiz_questions (                 -- фиксированный состав (если не отбор)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  quiz_id uuid not null references quizzes(id) on delete cascade,
  question_id uuid not null references questions(id),
  sort int not null,
  weight numeric(5,2) not null default 1
);
```

## 2.7 Назначения и прохождение

```sql
create table assignments (                    -- «кому что назначено»
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  course_id uuid not null references courses(id),
  course_version_id uuid not null references course_versions(id),
  audience jsonb not null,                    -- {type: user|position|location|org_unit|role|segment, ids:[…]}
  due_at timestamptz,
  starts_at timestamptz,
  is_mandatory boolean not null default true,
  recurrence jsonb,                           -- {every: '12 months'} для переаттестации
  created_by uuid references users(id)
);

create table enrollments (                    -- «конкретный человек на конкретном курсе»
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  assignment_id uuid references assignments(id) on delete set null,
  user_id uuid not null references users(id) on delete cascade,
  course_id uuid not null references courses(id),
  course_version_id uuid not null references course_versions(id),
  source text not null default 'assigned',    -- assigned | self | repeat
  status text not null default 'not_started', -- not_started | in_progress | completed | failed | expired
  progress_pct numeric(5,2) not null default 0,
  due_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  last_activity_at timestamptz,
  unique (tenant_id, user_id, course_version_id, assignment_id)
);
create index on enrollments (tenant_id, user_id, status);
create index on enrollments (tenant_id, due_at) where status in ('not_started','in_progress');

create table lesson_progress (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  enrollment_id uuid not null references enrollments(id) on delete cascade,
  lesson_id uuid not null references lessons(id),
  status text not null default 'opened',      -- opened | completed
  seconds_spent int not null default 0,
  completed_at timestamptz,
  unique (tenant_id, enrollment_id, lesson_id)
);

create table attempts (                       -- попытка теста/аттестации
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  enrollment_id uuid references enrollments(id) on delete cascade,
  quiz_id uuid not null references quizzes(id),
  user_id uuid not null references users(id),
  attempt_no int not null,
  snapshot jsonb not null,                    -- вопросы+эталоны на момент старта
  status text not null default 'in_progress', -- in_progress | submitted | review | passed | failed | expired
  score numeric(5,2),
  max_score numeric(5,2),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  finished_at timestamptz,
  time_limit_at timestamptz,
  unique (tenant_id, enrollment_id, quiz_id, attempt_no)
);

create table attempt_answers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  attempt_id uuid not null references attempts(id) on delete cascade,
  question_id uuid not null,
  question_version int not null,
  answer jsonb,                               -- ответ пользователя
  is_correct boolean,                         -- null пока не проверено вручную
  score numeric(5,2),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  review_comment text
);

create table certificates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references users(id),
  course_id uuid not null references courses(id),
  enrollment_id uuid not null references enrollments(id),
  number text not null,                       -- 0421-LO
  score numeric(5,2),
  issued_at timestamptz not null default now(),
  valid_until timestamptz,                    -- для переаттестации
  pdf_key text,
  public_token text unique,                   -- ссылка для проверки
  revoked_at timestamptz,
  unique (tenant_id, number)
);
```

## 2.8 База знаний и опросы

```sql
create table knowledge_articles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  title text not null,
  slug text not null,
  body jsonb not null,                        -- блоки, как в уроке
  category_id uuid references course_categories(id),
  tags text[] not null default '{}',
  status text not null default 'draft',
  search_tsv tsvector,                        -- generated, ukrainian config
  embedding vector(1536),                     -- pgvector, для семантического поиска
  updated_by uuid references users(id),
  unique (tenant_id, slug)
);
create index on knowledge_articles using gin (search_tsv);
create index on knowledge_articles using ivfflat (embedding vector_cosine_ops);

create table surveys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  title text not null,
  kind text not null default 'survey',        -- survey | feedback_360 | poll
  questions jsonb not null,
  is_anonymous boolean not null default false,
  status text not null default 'draft',
  opens_at timestamptz, closes_at timestamptz
);

create table survey_responses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  survey_id uuid not null references surveys(id) on delete cascade,
  user_id uuid references users(id),           -- null, если анонимно
  answers jsonb not null,
  submitted_at timestamptz not null default now()
);
```

## 2.9 Уведомления, задачи, интеграции

```sql
create table notification_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null,                          -- assignment_created | due_soon | overdue | passed | review_needed
  channel text not null,                       -- telegram | sms | email | push
  locale text not null default 'uk',
  subject text,
  body text not null,                          -- шаблон с {{переменными}}
  is_enabled boolean not null default true,
  unique (tenant_id, code, channel, locale)
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  code text not null,
  channel text not null,
  payload jsonb not null,
  status text not null default 'queued',       -- queued | sent | failed | skipped
  error text,
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz
);
create index on notifications (tenant_id, status, scheduled_for);

create table media_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  key text not null,                           -- t/<tenant>/…
  kind text not null,                          -- image | video | file
  mime text not null,
  bytes bigint not null,
  width int, height int, duration_sec int,
  poster_key text,
  status text not null default 'uploaded',     -- uploaded | processing | ready | failed
  uploaded_by uuid references users(id),
  unique (tenant_id, key)
);

create table import_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  kind text not null,                          -- users | courses
  file_key text not null,
  status text not null default 'queued',       -- queued | validating | ready | applied | failed
  stats jsonb not null default '{}',           -- {rows, created, updated, errors}
  report_key text,                             -- xlsx с построчными ошибками
  created_by uuid references users(id)
);

create table audit_log (
  id bigserial primary key,
  tenant_id uuid not null,
  actor_id uuid,
  action text not null,                        -- course.publish, user.archive, attempt.grade
  entity text not null,
  entity_id uuid,
  before jsonb, after jsonb,
  ip inet, user_agent text,
  created_at timestamptz not null default now()
);
create index on audit_log (tenant_id, created_at desc);
```

## 2.10 Геймификация (этап 5, закладываем таблицы)

```sql
create table badges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null, name text not null, icon_key text,
  rule jsonb not null                          -- {type:'course_completed', course_id} | {type:'streak', days:5}
);
create table user_badges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  badge_id uuid not null references badges(id),
  awarded_at timestamptz not null default now(),
  unique (tenant_id, user_id, badge_id)
);
create table points_ledger (
  id bigserial primary key,
  tenant_id uuid not null,
  user_id uuid not null,
  delta int not null,
  reason text not null,
  ref_id uuid,
  created_at timestamptz not null default now()
);
```

## 2.11 Материализованные представления для отчётов

```sql
create materialized view mv_course_stats as
select tenant_id, course_id,
       count(*) filter (where status='completed')            as completed,
       count(*)                                              as enrolled,
       avg(progress_pct)                                     as avg_progress,
       percentile_cont(0.5) within group (order by
         extract(epoch from (completed_at - started_at))/60)  as median_minutes
from enrollments group by tenant_id, course_id;
```

Обновление — фоновой задачей раз в 10 минут (`refresh materialized view concurrently`).
Отчёты по требованию считаются напрямую, витрины — для дашборда.

## 2.12 RLS

```sql
alter table <table> enable row level security;
alter table <table> force row level security;

create policy tenant_isolation on <table>
  using      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

- Политика создаётся миграцией для **каждой** таблицы с `tenant_id`; тест
  `tests/integration/rls.spec.ts` перебирает `information_schema` и падает, если найдена
  таблица с `tenant_id` без включённого RLS (защита от забытой таблицы в новой миграции).
- Роль приложения: `create role app_user nologin nobypassrls;` — гранты только на нужные таблицы.
- `platform_admin` — отдельная роль с `bypassrls`, используется только модулем панели оператора.

## 2.13 Индексы, которые нужны сразу

```sql
create index on users (tenant_id, status);
create index on user_placements (tenant_id, location_id, position_id) where ended_at is null;
create index on lessons (tenant_id, module_id, sort);
create index on attempts (tenant_id, user_id, quiz_id, attempt_no desc);
create index on attempt_answers (tenant_id, attempt_id);
create index on lesson_progress (tenant_id, enrollment_id);
create index on notifications (tenant_id, user_id, status);
create index on certificates (tenant_id, user_id, issued_at desc);
```

## 2.14 Правила целостности

- Публикация курса: создаётся новая `course_versions` со `status='published'`,
  прошлая переводится в `retired`, `courses.published_version_id` обновляется в одной транзакции.
- Нельзя удалить `question`, на который ссылается `attempt_answers`; вместо удаления — `deleted_at`.
- `attempts.snapshot` пишется один раз при старте и не меняется никогда.
- `enrollments.progress_pct` пересчитывается сервисом, а не триггером: нужен контроль над
  правилами (обязательные уроки, минимальное время, зачтённый тест).
- `certificates.number` выдаётся последовательностью на тенант: `LO-<год>-<порядковый>`.

---

# 2.15 Таблицы модулей R2–R3 (полный дубль)

DDL приводится сокращённо: общие поля (`id`, `tenant_id`, `created_at`, `updated_at`,
`deleted_at`) и RLS-политика — как в §2.12, у каждой таблицы.

## Практикумы

```sql
workshops(title, description jsonb, criteria jsonb, submission_kinds text[], -- text|file|photo|video
          reviewer_scope text, deadline_days int, allow_rework boolean)
workshop_submissions(workshop_id, user_id, enrollment_id, body jsonb, files jsonb,
          status text,        -- draft | submitted | review | reworking | accepted | rejected
          score numeric(5,2), reviewed_by, reviewed_at, review_comment text, rework_count int)
workshop_comments(submission_id, author_id, body text, is_internal boolean)
```

## Программы и траектории

```sql
programs(title, description, cover_key, status, certificate_template_id)
program_items(program_id, item_type text,      -- course | quiz | workshop | meetup | webinar
          item_id uuid, sort int, is_required boolean, unlock_rule jsonb)
program_enrollments(program_id, user_id, status, progress_pct, started_at, completed_at)
trajectories(title, graph jsonb)               -- узлы и переходы с условиями (R2)
```

## Комплексные тесты, очные занятия, вебинары

```sql
complex_tests(title, pass_score, time_limit_sec, parts jsonb)  -- ссылки на quizzes с весами
meetups(title, starts_at, ends_at, location_id, room text, trainer_id, capacity int, status)
meetup_registrations(meetup_id, user_id, status,  -- registered | waitlist | attended | missed
          checked_in_at, check_in_method text)     -- manual | qr
webinars(title, starts_at, provider text, join_url text, record_url text, capacity int)
webinar_participations(webinar_id, user_id, joined_at, minutes int)
```

## Развитие

```sql
competencies(name, description, levels jsonb)                    -- уровни 1..5 с поведением
position_profiles(position_id, competency_id, required_level int)
position_profile_courses(position_id, course_id, due_days int, is_mandatory boolean)
development_plans(user_id, period_from date, period_to date, owner_id, status)
development_goals(plan_id, title, description, metric text, due_at, status,
          status_changed_at, approved_by)
goal_status_log(goal_id, from_status, to_status, actor_id, comment)
external_training_requests(user_id, title, provider, cost numeric, currency text,
          status, approved_by, decided_at, comment)
career_requests(user_id, target_position_id, status, approved_by, comment)
```

## Оценка и чек-листы

```sql
assessment_cycles(title, period_from, period_to, status, rater_kinds text[]) -- self|manager|peer
assessment_criteria_groups(name, sort)
assessment_criteria(group_id, name, description, scale_id)
rating_scales(name, kind text, options jsonb)   -- percent | pass_fail | 1_5 | letters
assessment_tasks(cycle_id, subject_user_id, rater_user_id, status, due_at)
assessment_answers(task_id, criterion_id, value jsonb, comment)
checklists(title, items jsonb, scale_id, requires_photo boolean)
checklist_runs(checklist_id, location_id, observer_id, subject_user_id, started_at,
          finished_at, score numeric(5,2), answers jsonb, photos jsonb)
```

## Корпоративный хаб

```sql
news(title, body jsonb, category_id, cover_key, is_pinned boolean, requires_ack boolean,
          published_at, author_id)
news_views(news_id, user_id, viewed_at, acked_at)
announcements(title, body jsonb, audience jsonb, show_mode text, -- modal | banner
          starts_at, ends_at, requires_ack boolean)
announcement_acks(announcement_id, user_id, acked_at)
events(title, description, starts_at, ends_at, location_id, audience jsonb, capacity int)
event_registrations(event_id, user_id, status)
wiki_pages(parent_id, title, slug, body jsonb, access jsonb, updated_by)
wiki_revisions(page_id, body jsonb, author_id, comment, created_at)
forum_topics(category_id, title, author_id, is_locked boolean, is_pinned boolean)
forum_posts(topic_id, author_id, body text, reply_to_id, is_hidden boolean, moderated_by)
chat_threads(kind text, title, member_ids uuid[])
chat_messages(thread_id, author_id, body text, attachments jsonb, read_by uuid[])
contacts(user_id, phone_public text, email_public text, room text, notes text)
shop_items(title, description, image_key, price_points int, stock int, is_active boolean)
shop_orders(user_id, item_id, price_points int, status, -- new | approved | issued | cancelled
          approved_by, issued_at)
```

## Рабочие задачи

```sql
work_task_types(name, fields jsonb, default_statuses jsonb)
work_tasks(type_id, title, description, assignee_id, author_id, location_id,
          due_at, status, priority, result jsonb)
work_task_comments(task_id, author_id, body)
```

## Геймификация и шкалы

```sql
evaluation_scales(name, kind, options jsonb)    -- шкалы оценки заданий
badges / user_badges / points_ledger            -- см. §2.10
leaderboard_snapshots(scope_type, scope_id, period, rows jsonb)
```

## Интеграции и переводы

```sql
tenant_secrets(...)                             -- см. 09-integrations.md §9.4
oauth_states(tenant_id, provider, state_hash, created_by, expires_at, consumed_at)
webhook_endpoints(url, secret_encrypted, events text[], is_active boolean)
webhook_deliveries(endpoint_id, event, payload jsonb, status_code int, attempt int,
          response_body text, delivered_at)
api_tokens(name, token_hash, scopes text[], last_used_at, expires_at, created_by)
translations(locale, key, value, updated_by)    -- переопределения строк тенантом
saved_reports(name, entity text, fields jsonb, filters jsonb, group_by jsonb,
          schedule jsonb, owner_id)
```
