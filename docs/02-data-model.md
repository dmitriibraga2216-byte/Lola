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
  custom_domain text unique,                 -- navchannya.kappi.ua; докс/33 D-059, `25` §16.1
  name text not null,                        -- Каппі
  locale text not null default 'uk',         -- uk | en
  timezone text not null default 'Europe/Kyiv',
  status text not null default 'active',     -- active | suspended | archived
  plan text not null default 'trial',        -- trial | point | network | custom
  trial_ends_at timestamptz,
  branding jsonb not null default '{}',      -- logo_key, accent, space_name
  settings jsonb not null default '{}',      -- флаги модулей, пороги, политика паролей
  archived_at timestamptz,                   -- `25` §8: мягкое удаление, tenant.purge через 30 дней; Spec 25
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- status: CHECK на active | suspended | archived (Spec 25). suspended — вход закрыт (403 tenant_suspended),
-- задачи стоят, данные целы; archived — команда оператора на удаление, исполняется задачей tenant.purge.

-- Переопределение лимитов тенанту (`24` §4.4, `25` §10); null — лимит тарифа plans. С RLS. Spec 25
create table tenant_limits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique,
  users int, storage_gb int, sms_per_month int, api_per_minute int, webhooks int,
  active_jobs int,                           -- квота задач тенанта на круг воркера (`25` §5), по умолчанию 100
  updated_by uuid references platform_admins(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Журнал действий оператора платформы (`25` §3.1, §7 п. 5): платформенная, без tenant_id и RLS. Spec 25
create table platform_audit (
  id bigserial primary key,
  admin_id uuid references platform_admins(id) on delete set null,
  admin_email text not null,                 -- 'worker' — запись фоновой задачи (tenant.purged)
  action text not null,                      -- tenant.create | tenant.update | tenant.suspend | tenant.resume |
                                             -- tenant.purge_schedule | tenant.purge_cancel | tenant.purged | tenant.limits | platform.request
  subject_tenant_id uuid references tenants(id) on delete set null, -- после purge null, slug остаётся в after/before
  entity text not null, entity_id text,
  before jsonb, after jsonb,
  request_context jsonb,                     -- как у остальных журналов
  created_at timestamptz not null default now()
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
  first_name text, last_name text, patronymic text,  -- эталон хранит ПІБ по частям
  gender text,                                -- поле есть в карточке эталона
  birth_date date,                            -- нужна для поздравлений (`23`)
  birthday_consent boolean not null default true, -- согласие показывать в «Дні народження» (`21` §7.8; `29` Б.16 — opt-out)
  avatar_key text,
  locale text,                                -- null → берём локаль тенанта
  status text not null default 'invited',     -- invited | active | suspended | archived
  hired_at date,
  position_since date,                        -- «Дата призначення поточної посади»:
                                              -- по ней считается «новичок в должности»
                                              -- и отложенные назначения (`17` §14.2)
  external_id text,                           -- «Зовнішній №», ключ идемпотентного импорта
  login text,                                 -- эталон различает логин и e-mail
  translit text,                              -- «Транслітерація» для выгрузок
  work_contacts text,                         -- «Робочі контакти», отдельно от личного телефона
  is_hidden boolean not null default false,   -- «Прихований»: работает, но не виден в контактах
  must_change_password boolean not null default false, -- «Змінити пароль після першого входу» (`24` §3.4.1); Spec 16
  password_changed_at timestamptz,            -- для «Обмежити максимальний термін дії пароля»; Spec 16
  comment text,
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
  manager_id uuid references users(id),       -- «Керівник» (зовнішній № при імпорті); Spec 16, docs/33 D-023 —
                                              -- окремо від functional_chiefs (там винятки з дерева оргструктури)
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
  description text,                           -- редактор ролей (`24` §3.5); Spec 24
  default_scope_type text not null default 'location', -- «область по умолчанию» роли: tenant | org_unit | location
  unique (tenant_id, code)
);

create table user_roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references roles(id),
  scope_type text not null,                   -- tenant | org_unit | location
  scope_id uuid,                              -- null для tenant
  valid_until timestamptz,                    -- срок действия (`16` §6.2, `29` Б.15): null — бессрочно; истёкшая роль прав не даёт, снимается ежедневно
  reason text,                                -- причина назначения — для аудита
  is_org_derived boolean not null default false, -- выдана правилом position_role_map; пересобирается при смене должности
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
  impersonator_admin_id uuid references platform_admins(id), -- вход «от имени» оператором (`24` §4.5): сессия 60 минут без продления, запреты `29` Б.13
  impersonation_reason text,                  -- причина 10–500 знаков, видна клиенту в журнале
  active_role_id uuid references roles(id),   -- активная роль сессии (`01` §1.9.2): права по ней, переключение без выхода
  preview_role_id uuid references roles(id),  -- «Переглянути систему як роль» (`24` §3.5, докс/33 D-052): права рахуються по ній, а не по власних ролях
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table otp_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,                             -- null до выбора пространства
  phone text not null,
  code_hash text not null,
  channel text not null,                      -- telegram | sms | email (docs/28 «Вхід: код на e-mail»)
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
  code text,                                  -- «Код» из карточки эталона
  icon_key text,                              -- «Іконка»
  duration_days int,                          -- «Тривалість навчання», днів
  workload text,                              -- «Оцінка зайнятості»
  result_mode text not null default 'pct',    -- «Визначати результат проходження курсу по»:
                                              -- pct (% успішності) | avg_score (середній бал)
                                              -- | final_test (за підсумковим тестуванням)
  is_catalog_visible boolean not null default false,
  -- Режим доступу каталогу (`10` §14.1, Spec 10): діє тільки коли is_catalog_visible.
  -- Значення узгоджені з `assign_mode` траєкторій (без manual/automation — тут керує тумблер вище).
  assign_mode text not null default 'catalog_free', -- catalog_free | catalog_request
  tags text[] not null default '{}',
  created_by uuid references users(id),
  unique (tenant_id, slug)
);

-- План курса: разделы и элементы. Раздел — обязательный уровень группировки.
-- У теста внутри плана свой порог; назначение его перекрывает (`15` §14.3).
create table course_sections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  course_version_id uuid not null references course_versions(id) on delete cascade,
  title text not null,
  sort_order int not null default 0
);

create table course_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  section_id uuid not null references course_sections(id) on delete cascade,
  item_type text not null,                    -- resource | quiz
  item_id uuid not null,
  pass_score_pct numeric(5,2),                -- «Поріг проходження, %» у теста в плане
  sort_order int not null default 0
);

-- Ресурс как тип контента (`11` §3.1, §14, Г-11.3): рабочая редакция + опубликованные снимки.
-- Правил прохождения нет; правило зачёта по типу — свойство типа (`11` Г-11.5), не строки.
create table resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  title text not null,
  slug text not null,
  kind text not null default 'article',       -- article | file | video | link (scorm — R3)
  summary text,
  body jsonb not null default '[]',           -- блоки, `11` §3.3 (для article)
  plain_text text not null default '',
  media_id uuid,                              -- file | video
  external_url text,                          -- link
  category_ids uuid[] not null default '{}',  -- «Категорії», несколько (resource_categories)
  tags text[] not null default '{}',
  language text not null default 'uk',
  estimated_minutes int,
  cover_key text,                             -- «Обкладинка ресурсу», 16:9
  card_image_key text,                        -- «Зображення для картки завдання», 16:9
  allow_print boolean not null default true,  -- «Дозволити друк»; политика «Вимкнути друк у ресурсах» сильнее
  status text not null default 'draft',       -- draft | published | archived
  author_ids uuid[] not null default '{}',
  version int not null default 1,             -- номер последней опубликованной версии
  published_version_id uuid,                  -- → resource_versions.id
  views_count int not null default 0,         -- «Переглядів: N» (`21` §14.1)
  unique (tenant_id, slug)
);

create table resource_versions (              -- снимок на момент публикации (Г-11.3)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  resource_id uuid not null references resources(id) on delete cascade,
  version int not null,
  title text not null,
  kind text not null,
  body jsonb not null default '[]',
  plain_text text not null default '',
  media_id uuid,
  external_url text,
  changelog text,
  published_at timestamptz not null default now(),
  published_by uuid references users(id),
  unique (tenant_id, resource_id, version)
);

create table resource_categories (            -- справочник категорий ресурсов, свой порядок (`30`)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  parent_id uuid references resource_categories(id) on delete set null,
  name text not null,
  sort_order int not null default 0
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
  is_required boolean not null default true,
  resource_version_id uuid references resource_versions(id) on delete set null  -- снимок ресурса, закреплённый публикацией курса (Г-11.3)
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
  question_group_id uuid references question_groups(id),  -- «Вибрати групу», см. ниже
  kind text not null,       -- эталон (7): single | multi | free | ordering |
                            --             classification | comparison | answer_by_map
                            -- Lola сверх эталона: number | text_short | file
  stem jsonb not null,      -- блоки, как в lessons.body (текст + картинка)
  options jsonb,            -- варианты; для number — {value, tolerance, unit}
  answer jsonb,             -- эталон; для free — null (ручная проверка)
  score numeric(6,2) not null default 1,       -- «бал(ів)*», обязательное поле в эталоне
  scoring_method text not null default 'formula', -- «Метод підрахунку балів»: formula | all_or_nothing (`12` §14.6)
  grader_hint text,         -- «Підказка для перевіряючого» (free): видит наставник, не ученик
  attach_files boolean not null default false, -- «Дозволити прикріпляти файли до відповіді» (free)
  explanation text,         -- разбор, показывается после ответа
  is_critical boolean not null default false,  -- провал критического = провал теста
  difficulty int,           -- 1..5, для отбора
  tags text[] not null default '{}',
  version int not null default 1
);

-- Группа вопросов внутри теста. Нужна для параметра назначения
-- «Кількість питань → Одне питання від кожної групи» (`15` §14.3):
-- по одному вопросу из каждой группы даёт разным людям разные наборы.
create table question_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  quiz_id uuid not null references quizzes(id) on delete cascade,
  title text not null,
  sort_order int not null default 0
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
  content_type text not null,                 -- course|training_program|resource|test|complex_test|
                                              -- workshop|meetup|webinar|poll|poll360|check_list
  content_id uuid not null,                   -- ссылка в таблицу по content_type
  content_version_id uuid,                    -- фиксация версии на момент назначения (в коде — subject_version_id:
                                              -- курс — при «зафиксировать версию», ресурс — всегда, D-007)
  audience jsonb not null,                    -- {type: user|position|location|org_unit|role|segment, ids:[…]}
  params jsonb not null default '{}',         -- ПРАВИЛА ПРОХОЖДЕНИЯ, см. ниже
  automation_rule_id uuid references automation_rules(id),
  via_catalog boolean not null default false, -- «Доступ через каталог навчання»
  use_in_dev_plans boolean not null default false,
  due_at timestamptz,
  starts_at timestamptz,
  due_days int,                               -- «кількість днів з моменту призначення»
  is_mandatory boolean not null default true,
  recurrence jsonb,                           -- {every: '12 months'} для переаттестации
  created_by uuid references users(id),
  on_leave_condition text not null default 'keep',  -- keep | cancel_unstarted | cancel_all (`15` Г-15.2) — как у правила [решение]
  content_changed_at timestamptz,             -- контент изменён после назначения (`15` §14.6)
  content_change_notified_at timestamptz      -- когда администратор разослал «матеріал оновлено» или снял баннер
);
create table assignment_competencies (        -- «Обрати компетенції» (`15` Г-15.3)
  tenant_id uuid not null,
  assignment_id uuid references assignments(id) on delete cascade,
  competency_id uuid references competencies(id) on delete cascade,
  primary key (assignment_id, competency_id)
);
```

**`assignments.params` — состав, сверено с эталоном** (`15` §14.3). Правила прохождения
живут здесь, а не в контенте; контент содержит только материал. Ключи:

```jsonc
{
  // срок
  "deadline_mode": "unlimited|days_from_assign|calendar",   // Термін завершення завдання
  "time_limit_min": 30,                                      // Час проходження, null = без лимита
  // тест
  "questions_mode": "all|one_per_group|limited",             // Кількість питань
  "questions_count": 10,
  "attempts": 3,                                             // null = необмежено
  "training_mode": false,                                    // Режим тренування
  "allow_other_pages": false,                                // Дозволити відкриття інших сторінок
  "show_error_protocol": true,                               // Показати протокол помилок
  "hide_correct_in_protocol": false,
  "shuffle_options": true,                                   // Перемішувати варіанти відповідей
  "keep_question_order": false,                              // Дотримуватися послідовності питань
  "allow_skip": true,                                        // Пропускати питання
  "instant_feedback": false,                                 // показывать верность сразу
  "manual_next": false,                                      // Перейти до наступного питання вручну
  // результат
  "result_source": "last|best",                              // остання спроба | кращий результат
  "pass_score_pct": 85,                                      // перекрывает порог контента
  "fix_result": true,                                        // Фіксувати результат завдання
  "scale_id": "uuid|null",                                   // Перетворити результат за шкалою
  // награды
  "badge_id": null, "certificate_id": null,
  "points": 0,                                               // рейтинг
  "bonuses": 0,                                              // магазин подарков
  // прочее
  "allow_comments": true,
  "notify_on_result": true                                   // Повідомлення про успішне/неуспішне
}
```

Набор ключей зависит от `content_type`: у курса нет `attempts` и `shuffle_options`,
у практикума нет `questions_mode`. Валидация — схемой zod на каждый тип (`shared/schemas`).

**Почему jsonb, а не колонки.** Одиннадцать типов контента с пересекающимися, но разными
наборами правил дали бы таблицу на шестьдесят колонок, из которых для каждой строки
заполнено пятнадцать. Поиск и отчёты по параметрам не нужны — они нужны по результатам.
Единственное исключение — `due_at`, `starts_at` и `due_days`: по ним идут напоминания
и просрочки, поэтому они вынесены в колонки и проиндексированы.

```sql

create table enrollments (                    -- «конкретный человек на конкретном курсе»
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  assignment_id uuid references assignments(id) on delete set null,
  user_id uuid not null references users(id) on delete cascade,
  course_id uuid not null references courses(id),
  course_version_id uuid not null references course_versions(id),
  source text not null default 'assigned',    -- assigned | self | repeat | catalog (Spec 10 — заявка через каталог)
  status text not null default 'not_started', -- not_started | in_progress | completed | failed | expired
  requested_at timestamptz,                   -- `10` §14.1, Spec 10: заявка через каталог (catalog_request) до рішення — status = not_assigned
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
  video_pct int not null default 0,           -- максимум просмотра
  scroll_pct int not null default 0,          -- докуда доскроллил (страница, документ) — `11` Г-11.5
  acknowledged_at timestamptz,                -- «Я ознайомився» (ссылка)
  downloaded_at timestamptz,                  -- документ скачан
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
  answer jsonb,                               -- ответ пользователя; для free с файлами — {text, files:[{mediaId, name, kind, bytes}]}
  is_correct boolean,                         -- null пока не проверено вручную
  score numeric(5,2),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  review_comment text
);

-- История результатов попытки (`22` §13.7, `04` §4.6): первый подсчёт, итог ручной проверки,
-- каждое «Перерахувати». Снимок попытки не меняется — меняется только запись результата.
create table attempt_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  attempt_id uuid not null references attempts(id) on delete cascade,
  reason text not null,                       -- submit | review | recalculate
  status text not null,
  score numeric(5,2), max_score numeric(7,2), passed boolean,
  created_by uuid references users(id),
  comment text,
  created_at timestamptz not null default now()
);

-- Запрос дополнительной попытки (`12` §6.3, §14.5). Одобренный запрос даёт +1 попытку
-- сверх лимита назначения; само назначение не меняется.
create table attempt_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  quiz_id uuid not null references quizzes(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  enrollment_id uuid references enrollments(id) on delete cascade,
  assignment_id uuid,
  reason text not null,
  attempts_used int not null, attempts_allowed int not null,  -- на момент запроса, для колонки «Використано спроб»
  status text not null default 'pending',     -- attempt_request_status
  decided_by uuid references users(id), decided_at timestamptz, decision_comment text,
  request_context jsonb,                      -- CLAUDE.md п. 14
  created_at timestamptz not null default now()
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

-- «Оцінок: N» на картці ресурсу і статті (`21` §14.1, докс/33 D-042). Один голос на людину —
-- повторна оцінка виправляє свою (upsert). С RLS.
create table content_ratings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  content_type text not null,                 -- content_rating_target: resource | knowledge_article
  content_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  value int not null,                         -- 1..5
  unique (tenant_id, content_type, content_id, user_id)
);
-- value: CHECK between 1 and 5; content_type: CHECK IN ('resource', 'knowledge_article')

-- Spec 20 (`20` §14.5, §14.7): режим, конфиденциальность, четыре типа вопроса, заморозка
create table surveys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  title text not null,
  kind text not null default 'survey',        -- survey | course_feedback | poll
  mode text not null default 'linear',        -- poll_mode: linear | conditional («з умовами»)
  -- [{id, type poll_question_kind, text, options [{id, text}], allowOwnOption, allowFiles, scaleId, required, next [{optionId?, goTo}]}]
  questions jsonb not null,
  is_anonymous boolean not null default false,     -- «Анонімне»: автор ответа не хранится вовсе
  is_confidential boolean not null default false,  -- «Конфіденційно»: ответы с именами видит только владелец
  show_results boolean not null default false,     -- «Дозволити перегляд підсумкових результатів»
  is_locked boolean not null default false,        -- после первого ответа (`20` §14.4)
  tags text[], status text not null default 'draft',
  opens_at timestamptz, closes_at timestamptz
);

create table survey_responses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  survey_id uuid not null references surveys(id) on delete cascade,
  user_id uuid references users(id),           -- null, если анонимно; других колонок, ведущих к человеку, нет
  answers jsonb not null,                      -- {questionId: {optionId} | {own} | {optionIds, own?} | {text, fileIds?} | {value}}
  path jsonb not null default '[]',            -- порядок показанных вопросов (режим з умовами)
  submitted_at timestamptz not null default now()
);

-- Участие: дедуп и черновик по ходу заполнения; связи с survey_responses нет (анонимность на уровне данных)
create table survey_participations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  survey_id uuid not null references surveys(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  status text not null default 'in_progress',  -- in_progress | submitted
  draft jsonb not null default '{}',           -- {answers, path}; стирается при отправке
  enrollment_id uuid, submitted_at timestamptz,
  unique (tenant_id, survey_id, user_id)
);
```

## 2.9 Уведомления, задачи, интеграции

```sql
-- Реализация обросла полями `23`/`24` без правки этого наброска (buttons, is_mandatory, throttle,
-- escalate_after_hours, ignore_quiet_hours, version — миграции 0007–0024; body_mjml, image_key,
-- telegram_image_key — Spec 23, миграция 0036) — актуальный список см. docs/28 «Spec 23».
create table notification_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null,                          -- assignment_created | due_soon | overdue | passed | review_needed
  channel text not null,                       -- telegram | sms | email | push
  locale text not null default 'uk',
  subject text,
  body text not null,                          -- шаблон с {{переменными}}
  body_mjml text,                              -- Spec 23: вёрстка письма, безопасное подмножество MJML (docs/28)
  image_key text,                              -- Spec 23: картинка шаблона
  telegram_image_key text,                     -- Spec 23: отдельная картинка для Telegram
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

-- Push-подписки браузера, PWA (`23` §4, докс/33 D-051). Один человек — несколько подписок
-- (несколько устройств), уникальность по endpoint. С RLS.
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  last_seen_at timestamptz not null default now()
);

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
  actor_role_id uuid,                          -- активная роль актора в момент действия (`01` §1.9.2)
  actor_roles text[],                          -- коды всех действующих ролей актора — кто на самом деле мог это сделать
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
-- Карточка практикума в эталоне несёт только материал (`13` §14).
-- Критерии, правило зачёта и лимит доработок — наше добавление `[решение]`.
workshops(title, description jsonb, body jsonb, attachments jsonb,
          criteria jsonb,                       -- [{id, title, weight}] — наше
          pass_rule text,                       -- all_criteria | weighted | reviewer_decision
          submission_kinds text[],              -- text | file | photo | video
          scale_id uuid references scales(id))  -- шкала заданий, общая (§ ниже)
workshop_submissions(workshop_id, user_id, enrollment_id, body jsonb, files jsonb,
          status text,        -- draft | submitted | review | reworking | accepted | rejected
          score numeric(5,2), reviewed_by, reviewed_at, review_comment text, rework_count int)
workshop_comments(submission_id, author_id, body text, is_internal boolean)
```

## Программы и траектории

```sql
programs(title, description, cover_key, status, certificate_template_id,
          code text, icon_key text, workload text)     -- docs/33 D-025, по аналогии с courses
program_items(program_id, item_type text,      -- course | quiz | workshop | meetup | webinar
          item_id uuid, sort int, is_required boolean, unlock_rule jsonb)
program_enrollments(program_id, user_id, status, progress_pct, started_at, completed_at)
trajectories(title, description, cover_key, status, tags text[],
          assign_mode text,                     -- manual | catalog_free | catalog_request | automation
          automation_rule_id uuid,
          stop_assign_after_finish boolean)     -- «Не призначати завдання після завершення»

-- Язык полотна снят с эталона (`17` §14.3): условия живут в УЗЛАХ, не в рёбрах.
trajectory_nodes(
  id, tenant_id, trajectory_id,
  kind text not null,      -- start | finish | task | and | or | delay | stop_delay
                           -- | branch  ← наш узел «Розгалуження за результатом» [решение]
  title text,              -- «Назва (підпис до блоку)», обязательна у and/or/delay/stop_delay
  content_type text,       -- для kind='task'
  content_id uuid,
  days int,                -- для delay («пропустити через N днів»)
                           -- и stop_delay («закрити доступ через N днів»)
  mentor_id uuid,          -- для mentor: явный наставник; null — керівник точки людини [решение spec-17]
  params jsonb,            -- для task: правила назначения, которое создаст узел (ключи assignments.params
                           -- по типу, `15` §14.3, + dueDays) — узел = шаблон назначения, не контент [решение spec-17]
  x int, y int             -- положение на полотне
)

trajectory_edges(
  id, tenant_id, trajectory_id, from_node_id, to_node_id,
  -- условие заполняется ТОЛЬКО когда from_node.kind = 'branch'; у остальных null
  condition jsonb,         -- {op:'passed'} | {op:'failed'} | {op:'score_gte', value:80} | {op:'else'}
  sort int                 -- порядок гілок у branch: берётся первая подходящая (`17` §12)
)

-- Прохождение траектории человеком (spec-17): статус — enrollment_status (пять значений);
-- заявка из каталога — not_assigned + requested_at; снятие — cancelled_at, не удаление
trajectory_enrollments(
  id, tenant_id, trajectory_id, user_id, status, source text,   -- manual | catalog | automation
  rule_id uuid, mentor_id uuid, requested_at, available_from,    -- available_from — «Призначення через N днів» правила
  started_at, completed_at, cancelled_at, cancel_reason, progress_pct, last_activity_at,
  unique (trajectory_id, user_id)
)
-- Состояние узла у человека — путь воспроизводим (`17` §7.4)
trajectory_node_states(
  id, tenant_id, enrollment_id, node_id,
  status text,             -- locked | available | in_progress | done | failed | skipped (`17` §4)
  activated_at, finished_at, fires_at,   -- fires_at: когда сработает таймер delay/stop_delay
  score numeric, passed boolean, assignment_id uuid,   -- task: назначение, созданное узлом (assignments.kind = trajectory)
  reason text,             -- failed/skipped: access_closed | branch_not_taken | cancelled
  chosen_edge_id uuid,     -- branch: выбранная гілка
  unique (enrollment_id, node_id)
)
```

## Комплексные тесты, очные занятия, вебинары

```sql
-- Комплексный тест = именованный набор обычных тестов, сгруппированный по темам
-- (`12` §14.2). Своих правил прохождения не несёт — они в назначении.
complex_tests(title, description, attachments jsonb, tags text[], status)
complex_test_items(complex_test_id, quiz_id, topic text, sort_order int)
-- Карточка занятия — только материал; расписание вынесено в сессии (`18` §14.1, наше решение).
meetups(title, announcement jsonb, description jsonb, attachments jsonb, tags text[], status)
webinars(title, description jsonb, attachments jsonb, tags text[], status)

-- Spec 18: в коде таблица называется `meetup_sessions`/`meetup_session_registrations` —
-- имя `sessions` занято автентифікацією (`sessions.active_role_id`, parity-4-active-role).
-- Старые поля даты/места/вместимости на `meetups`/`webinars` для kind=meetup|webinar не убраны
-- (используются kind=event, Spec 21, и старыми записями без сессии) — но полностью «спят», как
-- только у карточки появляется хоть одна сессия: запись/QR/отметка/отчёт/напоминания/
-- Calendar-Zoom-синк переходят на `meetup_sessions` целиком (`33` D-029, миграция 0053 переносит
-- одноразовые старые карточки в одну сессию каждая). `meetup_sessions.external_event_id`/
-- `external_meeting_id` — Google Calendar/Zoom на конкретную сессию (было только на карточке).
-- sessions (аутентификация).login_method text — чем подтверждена личность (docs/33 D-021, миграция 0050):
-- otp | otp_sms | otp_telegram | otp_email | password | password_otp | google | invite | impersonation (CHECK);
-- по нему решается, можно ли задать новый пароль без текущего («Відновлення пароля», `24` §3.4.1).
sessions(                                  -- общая для очных занятий и вебинаров
  id, tenant_id, task_id,                  -- сессия принадлежит НАЗНАЧЕНИЮ, не карточке
  content_type text,                       -- meetup | webinar
  starts_at, ends_at,
  location_id uuid, room text, trainer_id uuid,   -- очное (в коде — trainer_ids uuid[], тренеров может быть несколько, `18` §3.1)
  join_url text, record_url text, provider text,  -- вебинар
  capacity int, waitlist_enabled boolean, status text
)
session_registrations(session_id, user_id, status,  -- registered | waitlist | attended | missed
          checked_in_at, check_in_method text,      -- qr | list | manual_late
          checked_in_by uuid,
          minutes_watched int, watch_pct numeric(5,2))  -- вебинар
```

## Развитие

```sql
competencies(name, description, levels jsonb)                    -- уровни 1..5 с поведением
position_profiles(position_id, competency_id, required_level int)
position_profile_positions(profile_id, position_id, unique(profile_id, position_id))   -- docs/33 D-031: усі посади профілю, головна — position_profiles.position_id
position_profile_courses(position_id, course_id, due_days int, is_mandatory boolean)
development_plans(user_id, period_from date, period_to date, owner_id, mentor_id, status)   -- mentor_id [рішення] screens-7, docs/19 §3.4
development_goals(plan_id, title, description, metric text, due_at, status,
          status_changed_at, approved_by,
          parent_id, is_strategic boolean)   -- [рішення] spec-development, docs/19 §14.4: дерево «Стратегічний план»
goal_status_log(goal_id, from_status, to_status, actor_id, comment)
external_training_requests(user_id, title, provider, cost numeric, currency text,
          status, approved_by, decided_at, comment)
career_requests(user_id, target_position_id, status, approved_by, comment)
```

Spec 19: `position_profiles` (в коде — `competency_requirements jsonb` вместо отдельной таблицы) получила
`use_position_levels boolean`, `goals jsonb`, `responsibilities jsonb` (`19` §14.2: «Цілі посади»,
«Обов'язки посади»); элементы `competency_requirements[]` — необязательный `position_level_id`
(разные требования для «Бариста» и «Бариста 2 рівня» в одном профиле, применяется только при
`use_position_levels = true`). Несколько должностей на профиль (`19` §14.2) — `position_profile_positions`
(`debts-6`, D-031): `position_id` профиля — головна посада, остальные — строки связи; одна должность
состоит не более чем в одном профиле.

**`development_goals.parent_id`/`is_strategic`** (`[рішення]` spec-development, `19` §14.4). Ре-аудит
эталона показал «Стратегічний план» (`/mbo`) как дерево целей компании («Напрямок»), каскадом
раскрывающееся до личных целей людей, с тем же жизненным циклом статусов и протоколом, что и у
целей ИПР. Вместо отдельной таблицы — тот же `development_goals`: `parent_id` (self-FK, `on delete
cascade` — удаление узла удаляет и поддерево) строит вложенность, `is_strategic` (`boolean`,
по умолчанию `false`) отделяет узлы дерева от личных целей ИПР той же самой таблицы (иначе цель
компании, «принадлежащая» руководителю через `user_id`, утекла бы в его личный «Мій розвиток»).
`due_at` стал необязательным — у корневого узла «Напрямок» в мокапе `Goals` срока нет, он есть
только у дочерних целей людей. `kind='result'` — ближайшее из уже существующего перечня
(`competency|learning|result|project`, CLAUDE.md п. 13 — новое значение не заводили).

## Оценка и чек-листы

```sql
-- Словарь критериев (сверено `20` §14.6): критерий несёт только название и описание,
-- группа — название, описание и метки. Связь критерия с компетенцией — наша `[решение]`.
criteria_groups(id, tenant_id, name, description jsonb, tags text[])
criteria(id, tenant_id, group_id, name, description jsonb,
         competency_id uuid references competencies(id))   -- наше

-- Анкета оценки (сверено `20` §14.2). Spec 20: реализована как assessment_forms (0039) — состав в assessment_items,
-- шкала — scales(kind=levels), is_locked при первом заполнении; комментарии к группам — assessment_tasks.group_comments jsonb
assessments(
  id, tenant_id, title, description jsonb, instruction jsonb, attachments jsonb,
  kind text not null,               -- by_criteria | by_competencies
  scale_id uuid not null references scales(id),
  allow_comment_groups boolean, comment_groups_required boolean,
  comment_when_above_norm boolean, comment_when_below_norm boolean, comment_when_equal boolean,
  zero_means_no_grade boolean,      -- «значення 0 означає відсутність оцінки»
  is_locked boolean not null default false,  -- после первого заполнения (§14.4)
  tags text[], status text
)
assessment_items(assessment_id, criterion_id, norm numeric(6,2), cluster text, sort_order int)   -- Spec 20: form_id, RLS

-- Чек-лист (сверено `20` §14.3): у пункта ВЕС, а не норма
checklists(
  id, tenant_id, title, description jsonb, instruction jsonb, attachments jsonb,
  scale_id uuid not null references scales(id),
  allow_skip boolean, allow_item_comment boolean, item_comment_required boolean,
  requires_photo boolean,           -- наше `[решение]`
  is_locked boolean not null default false,
  tags text[], status text
)
checklist_items(checklist_id, criterion_id, weight numeric(6,2), sort_order int)
-- Spec 20: пункты по-прежнему в checklists.items jsonb [{id, text, criterionId?, weight, isCritical, requiresPhoto, hint, passThreshold?}] — criterionId
-- ссылается на словарь; шкала одна (checklists.scale_id → scales); фото — на пункте, не на чек-листе (`20` §3.5)
-- passThreshold (docs/33 D-037) — опциональный свой порог провала пункта (％ доли), без него — прохідний бал чек-листа

-- Циклы и ответы — общие для обеих анкет
assessment_cycles(assessment_id, task_id, period_from, period_to, status, min_raters int)
assessment_raters(cycle_id, subject_user_id, rater_user_id,
          rater_kind text,          -- self | manager | functional_manager | peer | subordinate | external
          weight numeric(4,2), is_anonymous boolean, status text, due_at)
-- В коде assessment_raters = assessment_tasks (docs/33 D-036, миграция 0050): rater_kind с CHECK по шести ролям
-- (mentor прежних циклов → external), weight/is_anonymous — снимок роли на момент старта цикла;
-- набор ролей цикла — assessment_cycles.rater_roles jsonb [{kind, weight, isAnonymous}] поверх умолчаний Г-20.1;
-- assessment_tasks.items jsonb [{criterionId, norm, cluster}] — состав анкеты by_competencies для оцениваемого
-- из вимог профиля его должности (docs/33 D-039), null — состав анкеты.
assessment_answers(cycle_id, rater_id, item_id, value numeric(6,2), comment text,
          photo_keys text[])
```

## Корпоративный хаб

```sql
news(title, body jsonb, category_id, cover_key, is_pinned boolean, requires_ack boolean,
          published_at, author_id, views_count int)   -- срока ознакомления у новости нет (п. 11): срок — у объявления, назначением
news_views(news_id, user_id, viewed_at, acked_at)
-- Объявление (сверено `21` §14.5) — назначаемая сущность, а не лента: контент типа `notice`
-- назначается через `assignments` (аудитория, срок подтверждения `due_at`, напоминания,
-- `assign_mode` = `via_catalog`/`automation_rule_id` назначения). Spec 21.
notices(
  id, tenant_id, title, body jsonb, attachments jsonb,
  kind text not null,               -- acknowledge | event | notification («Ознайомлення/Подія/Сповіщення»)
  starts_at, ends_at,               -- «Термін оголошення» — период показа, не срок подтверждения
  show_mode text, priority text, block_until_ack boolean, ack_text text,  -- показ (`21` §3.3, §5.4)
  status text,                      -- draft | published | archived; scheduled/active/expired — признаки по датам
  published_at, views_count int, author_id
)
notice_acks(notice_id, user_id, acked_at, request_context jsonb)   -- «Ознайомлений N (всього M)»

-- Простое объявление: без назначения и подтверждения
simple_notices(title, body jsonb, published_at, ends_at, status, views_count int)
-- «Мої закладки» (`21` §14.1): content_type — resource | article | news | notice
bookmarks(user_id, content_type, content_id)
-- События живут в meetups(kind=event) + meetups.audience jsonb (Spec 21); отдельной таблицы нет
events(title, description, starts_at, ends_at, location_id, audience jsonb, capacity int)
event_registrations(event_id, user_id, status)
wiki_pages(parent_id, title, slug, body jsonb, access jsonb, updated_by)
wiki_revisions(page_id, body jsonb, author_id, comment, created_at)
forum_topics(category_id, title, author_id, is_locked boolean, is_pinned boolean)
forum_posts(topic_id, author_id, body text, reply_to_id, is_hidden boolean, moderated_by)
chat_threads(kind text, title, member_ids uuid[])
chat_messages(thread_id, author_id, body text, attachments jsonb, read_by uuid[])
-- Контакты (`21` §14.8): витрина над users/user_placements/work_contacts, отдельной таблицы нет (Spec 21)
contacts(user_id, phone_public text, email_public text, room text, notes text)
-- Товар (сверено `21` Г-21.1): у эталона нет ни точки выдачи, ни лимита — это наше.
shop_items(title, description, image_key, category_id, price_bonuses int, stock int,
          location_id uuid,                 -- точка выдачи, null = любая  [решение]
          limit_per_user int,               -- [решение]
          is_active boolean)
shop_orders(user_id, item_id, price_bonuses int,
          status text,                      -- reserved | ready | issued | cancelled
          reserved_until timestamptz,       -- 14 дней, потом автоотмена  [решение]
          issued_by uuid, issued_at timestamptz, cancel_reason text)
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
-- В эталоне три реестра шкал (`24` Г-24.4). Сводим к одному с полем kind.
--   range  — «Шкали оцінки завдань»: диапазон процентов → название + характеристика
--   levels — «Шкали оцінювання» анкет и «Шкала компетенцій»: перечень уровней
scales(id, tenant_id, name, description,
       kind text not null,                 -- range | levels
       display_as text)                    -- label | value — только для levels
scale_levels(scale_id, label, value numeric,
       range_from numeric, range_to numeric,   -- только для kind='range'
       characteristic text,                     -- «Характеристика оцінки»
       show_in_reports boolean,                 -- «Відображати у звітах»
       sort_order int)
-- Spec 24: обе таблицы созданы (0035, RLS, scale_levels.tenant_id ради политики). Spec 20: rating_scales анкет/чек-листов
-- перенесена сюда (0039, kind=levels), таблица удалена; порог «норма» живёт в assessment_items.norm, а не в шкале.
-- Spec 19: «Шкала компетенцій» (`19` §14.1) — не строка `scales` (у компетенции уже свои levels jsonb
-- с названием и поведением на уровень), а один тумблер на тенанта: tenants.settings.development.competencyDisplayAs
-- (display_as: label | value) — показывать рівень как «Досвідчений» или как «4» в гэпах, матрице, ІПР.
badges / user_badges / points_ledger            -- см. §2.10
leaderboard_snapshots(scope_type, scope_id, period, rows jsonb)
```

## Метки

```sql
-- Область действия обязательна: без неё список меток на форме курса показывает
-- метки должностей. Значения области в эталоне: course | resource | user (и другие).
tags(id, tenant_id, name, description, color, scope text not null)   -- scope: tag_scope (CHECK), Spec 16 (было kind any|people|content|assignment)
-- name ≤ 40 знаков, без угловых скобок; уникальна в паре (tenant_id, scope, name)
-- метка живёт на сущностях строкой (users.tags, courses.tags, …): «где используется» считается по таблицам области
user_groups.is_org_derived boolean not null default false,  -- группа «з оргструктури» (`16` §14.1): пересобирается, руками не правится; Spec 16
user_groups.org_unit_id uuid references org_units on delete cascade,   -- узел-источник производной группы
user_groups.location_id uuid references locations on delete cascade
```

## Интеграции и переводы

```sql
tenant_secrets(...)                             -- см. 09-integrations.md §9.4
oauth_states(tenant_id, provider, state_hash, created_by, expires_at, consumed_at)
webhook_endpoints(url, secret_encrypted, events text[], is_active boolean)
webhook_deliveries(endpoint_id, event, payload jsonb, status_code int, attempt int,
          response_body text, delivered_at)
api_tokens(name, token_hash, scopes text[], last_used_at, expires_at, created_by)
translations(tenant_id, locale, key, value, updated_by, unique (tenant_id, locale, key)) -- переопределения строк тенантом поверх словаря (`24` §3.6); Spec 24
tenant_usage(tenant_id, collected_at,           -- потребление раз в сутки, строка на сбор (`24` §4.4.1, задача usage.collect); Spec 24
       active_users int, blocked_users int, archived_users int, storage_bytes bigint,
       sms_month int, courses_count int, assignments_count int, attempts_month int)
saved_reports(name, entity text, fields jsonb, filters jsonb, group_by jsonb,
          schedule jsonb, owner_id)
```

## Сквозные таблицы, добавленные по итогам разбора эталона

```sql
-- Технический контекст события. Пишется одинаково во ВСЕ журналы (`22` §13.4):
-- IP с геолокацией и браузер встречаются в трёх журналах эталона из четырёх.
-- Хранится строкой журнала, а не отдельной таблицей — join на каждый показ дороже.
-- Формат поля request_context jsonb:
--   {ip, geo:{country,country_code,city}, user_agent, browser, os, device}
-- Журналы: audit_log, security_log, sessions, enrollment_events, notifications,
-- import_jobs, goal_status_log, automation_runs, task_access_log, org_conflicts, task_status_log
-- (+ points_ledger, когда появится).
-- Заполняет server/utils/requestContext.ts; вне HTTP-запроса (очередь, вебхук) — null.
-- security_log.severity text not null default 'info' — security_severity (см. перечисления).

-- Звіт звернень до завдань (`22` §13.4): строка на каждое открытие или скачивание, не на первый вход. Spec 22.
task_access_log(
  id, tenant_id, user_id,
  content_type text not null,     -- content_type
  content_id uuid not null,
  title text,                     -- название на момент обращения
  assignment_id uuid, enrollment_id uuid,
  action text not null default 'open',   -- open | download
  request_context jsonb, created_at
)
-- Протокол конфліктів в оргструктурі (`16` §7, §14): эталон не падает на конфликте, а пишет строку и продолжает. Spec 22.
org_conflicts(
  id, tenant_id, user_id,
  kind text not null,             -- org_conflict_kind: double_unit | placement_replaced | manager_self | manager_cycle | unit_missing (Spec 16, по мокапу)
  source text not null default 'manual',  -- manual | import
  import_job_id uuid, details jsonb, actor_id uuid,
  request_context jsonb, resolved_at timestamptz, resolved_by uuid, created_at   -- разрешение: details.resolution {action acknowledge|close_placement, placementId, comment, by, at}
)
-- Протокол змін статусу завдань (docs/33 D-020, D-034; `debts-4`): единая точка «завдання завершено» для всех
-- 11 типов контента + траектория. Пишет только хук `onTaskCompleted` (server/services/taskCompletion.ts) из
-- модуля, фиксирующего завершение; из него же подтверждаются компетенции назначения (Г-19.2). Отчёт по типам
-- без собственной записи прохождения (resource, workshop, poll, assessment, check_list, meetup, webinar, notice)
-- читает последний статус отсюда; enrollment_events для курса/программы остаются.
task_status_log(
  id, tenant_id, user_id,
  content_type text not null,     -- content_type | trajectory (CHECK)
  content_id uuid not null,
  assignment_id uuid,             -- назначение, по которому завершено; null — самостоятельно/каталог
  enrollment_id uuid,
  status text not null,           -- enrollment_status: только done | failed (CHECK); повтор того же статуса не пишется
  result text,                    -- %, балл — числом строкой, как enrollments.score
  source_kind text not null,      -- enrollment | attempt | complex_attempt | resource_view | meetup_attendance | notice_ack | survey_response | assessment_cycle | checklist_run | workshop_submission | program_enrollment | trajectory_enrollment
  source_id uuid, actor_id uuid,  -- строка-источник; кто зафиксировал (наставник, наблюдатель), null — сам/система
  request_context jsonb, created_at
-- Протокол змін статусу завдань — это enrollment_events (payload {from, to, result}) ∪ attempt_results ∪ pass_events.
-- Программы и траектории (docs/33 D-045): своя таблица событий по аналогии с enrollment_events
pass_events(
  id, tenant_id, subject_type text,   -- training_program | trajectory
  subject_id uuid, enrollment_id uuid, user_id uuid,
  event text,                          -- created | started | completed | failed | cancelled | reset
  payload jsonb,                       -- {from, to, result, reason, source}
  actor_id uuid, request_context jsonb, created_at
)
-- report_exports.active_role_id uuid — роль, активная в момент запроса выгрузки (`01` §1.9.2); область считается по ней.

-- Правило автоматизации (`17` §14.2)
automation_rules(
  id, tenant_id, name, description,
  trigger text not null,          -- first_activation | attributes_acquired (оба сразу — норма)
  delay_days int,                 -- «Призначення через (кількість днів)»
  on_leave_condition text not null default 'keep',  -- keep | cancel_unstarted | cancel_all  [решение]
  status text
)
-- Четыре измерения; на каждое — свой режим и свой список значений
automation_rule_dimensions(
  id, tenant_id, rule_id,         -- tenant_id ради RLS (CLAUDE.md п. 1); unique (rule_id, dimension)
  dimension text not null,        -- city | position | org_unit | tag
  mode text not null,             -- any | include | exclude   («Будь-яке» / список / «Всі, окрім»)
  value_ids uuid[]                -- для tag — id из tags; сопоставление с users.tags по имени
)

-- Правило «должность → роль» (`01` §1.9.1): роли в сети раздаются не руками.
-- scope_id null при scope_type location | org_unit — «точка/подразделение размещения»;
-- применяется при смене должности и импорте, выданная роль помечена user_roles.is_org_derived
position_role_map(id, tenant_id, position_id, role_id, scope_type, scope_id,
                  unique (tenant_id, position_id, role_id, scope_type, scope_id))

-- Группа вопросов внутри теста — см. §2.6
-- Разделы и элементы плана курса — см. §2.4

-- Дополнительные параметры назначений (`15` §14.5)
task_parameters(id, tenant_id, name, kind text,    -- text | select | number
                options jsonb, is_required boolean, unique (tenant_id, name))
task_parameter_values(tenant_id, task_id, parameter_id, value jsonb,   -- tenant_id ради RLS (CLAUDE.md п. 1)
                      primary key (task_id, parameter_id))

-- Заявки: внешнее обучение и карьерное развитие сведены в одну таблицу (`19` Г-19.1)
requests(
  id, tenant_id, user_id,
  kind text not null,             -- external_learning | career
  title, description jsonb, attachments jsonb,
  target_position_id uuid,        -- для career
  provider text, cost numeric(12,2), currency text,   -- для external_learning
  status text not null,           -- draft | pending_manager | pending_budget | approved | rejected | cancelled
  assignee_id uuid,               -- «Відповідальний»
  decided_by uuid, decided_at timestamptz
)
request_approvals(request_id, step int, approver_id, decision text, comment, decided_at)

-- Уровень компетенции человека — расчётное значение с источником (`19` Г-19.2)
user_competencies(
  user_id, competency_id, level int,
  source text not null,           -- assessment | task | manual
  source_ref_id uuid, reason text,
  assessed_at timestamptz, valid_until timestamptz
)
-- Spec 19: в коде — существовавшая с этапа 4 `competency_assessments` (лог оценок, не одна строка
-- на пару человек+компетенция — приоритет источника считается на чтении, `currentLevels()`).
-- `evidence_id` играет роль `source_ref_id`, `comment` — роль `reason` (обязателен при source=manual).
-- Миграция 0040: старые значения source нормализованы (self|manager → manual, test → task,
-- assessment не менялся), CHECK на состав, `valid_until` по умолчанию 12 месяцев на всех источниках.

-- Группы доступа базы знаний и каталога (`21` §14.1, `10` §14.1)
access_groups(id, tenant_id, name, description, applies_to text)  -- knowledge | catalog
access_group_members(id, tenant_id, group_id, subject_type text, subject_id uuid) -- position | org_unit | user | role (tenant_id — ради RLS)
content_access_groups(id, tenant_id, content_type, content_id, group_id)          -- ресурс без групп открыт всем

-- Единая лента комментариев (`10` §14.2)
comments(
  id, tenant_id, author_id, body text,
  source_type text,               -- task | course | program | knowledge | notice
  source_id uuid,
  is_read boolean, read_by uuid, read_at timestamptz,
  routed_to uuid,                 -- автор материала  [решение]
  reply_to_id uuid
)
```

## Перечисления, снятые с эталона (не выдумывать свои)

```sql
-- Статус прохождения. Пять значений, не четыре (`22` §13.3).
-- not_assigned отличается от not_started: первое — элемент ещё не выдан,
-- второе — выдан, но не открыт. Руководитель реагирует на них по-разному.
enrollment_status: not_assigned | not_started | in_progress | done | failed

-- Тип назначения (вкладки списка эталона)
task_type: manual | auto | catalog | trajectory | archive

-- Тип контента: одиннадцать значений эталона + notice (Lola: объявление назначается
-- как обучение, `21` §14.5; срок и аудитория — в назначении, не в объявлении)
content_type: course | training_program | resource | test | complex_test | workshop
            | poll | assessment | check_list | meetup | webinar | notice

-- Режим назначения траектории и объявления
assign_mode: manual | catalog_free | catalog_request | automation

-- Узлы траектории (`17` §14.3; branch — Г-17.1, mentor «Призначити наставника» — Г-17.2, наши)
trajectory_node_kind: start | finish | task | and | or | delay | stop_delay | branch | mentor

-- Тип объявления
notice_kind: acknowledge | event | notification

-- Уровень события журнала безопасности
security_severity: info | warning | critical

-- Типы вопросов: семь эталона (`12` §14.3) + три Lola (number, text_short, file)
-- + cloze — пропуски в тексте (`12` §3.3 п. 11, R2, докс/33 D-015)
question_kind: single | multi | free | ordering | classification | comparison | answer_by_map
            | number | text_short | file | cloze

-- «Метод підрахунку балів» (`12` §14.6): «За формулою» | «Все або нічого»
scoring_method: formula | all_or_nothing

-- Статус запроса дополнительной попытки (`12` §14.5: «Очікує» по умолчанию, «Надано»; «Відмовлено» — по кнопке «Відмовити» `12` §6.3)
attempt_request_status: pending | approved | rejected

-- Область действия метки (`16` §14.2; `30`): обязательна
tag_scope: user | course | resource | question | task

-- Вид конфликта оргструктуры (`16` §7, §14; Spec 22; unit_missing — по мокапу OrgConflicts, Spec 16)
org_conflict_kind: double_unit | placement_replaced | manager_self | manager_cycle | unit_missing

-- Коды событий журнала безопасности (`16` §15 Г-16.2); Spec 16
security_event: login.success | login.failed | login.blocked | otp.sent | otp.failed | session.revoked
              | user.created | user.blocked | user.unblocked | user.archived
              | password.changed | password.reset_by_admin
              | roles.changed | contacts.changed | impersonation.started | impersonation.ended
              | export.personal_data | settings.security_changed | api_token.created | api_token.revoked

-- Тип анкеты оценки (`20` §14.2: «Оцінка за критеріями» | «Оцінка за компетенціями»); Spec 20
assessment_kind: by_criteria | by_competencies

-- Режим опроса (`20` §14.5: «Лінійне опитування» | «Опитування з умовами»); Spec 20
poll_mode: linear | conditional

-- Типы вопросов опроса (`20` §14.7: «Одиночне» · «Множинне» · «Вільна відповідь» · «По шкалі»); Spec 20
poll_question_kind: single | multi | free | scale

-- Источник уровня компетенции человека (`19` Г-19.2): приоритет assessment > task > manual; Spec 19
competency_source: assessment | task | manual

-- Спосіб відображення рівня компетенції (`19` §14.1 «Шкала компетенцій»): назва рівня чи число; Spec 19
display_as: label | value

-- Матеріал, який можна оцінити читачем («Оцінок: N», `21` §14.1); докс/33 D-042, своє
content_rating_target: resource | knowledge_article
```

## Что проверяет тест схемы

Кроме теста полноты RLS (`25` §11) в CI работает `tests/integration/schema-parity.spec.ts`:

1. У каждой таблицы с `tenant_id` есть политика и индекс, начинающийся с `tenant_id`.
2. Ни одна таблица контента не содержит колонок `attempts`, `pass_score`, `due_at`,
   `time_limit` — правила живут в `assignments.params` (`15` §14.3).
3. Все перечисления из раздела выше объявлены ровно в этом составе; лишнее значение
   или недостающее валит тест.
4. `enrollment_status` используется во всех отчётных представлениях одинаково.
5. У каждой таблицы-журнала есть колонка `request_context jsonb`; `security_log.severity`
   ограничен CHECK ровно значениями `security_severity`.

## Дельта пакета v2

> Патч `docs/v2/39-patches.md` П-02. Пакет `docs/v2/` (рекрутинг, этапы жизненного цикла и
> офбординг, ИИ в отборе, библиотека контента, оргструктура, хранилище, тарифы, обратная связь
> по контенту, делегирование проверки, расширения карточки человека) заявляет 73 новые таблицы
> и 14 `alter table` к существующим. Полная схема — `docs/v2/40-data-model-delta.md`; сверка с
> фактическим состоянием репозитория — `docs/v2/43-reconciliation.md` §1 (три таблицы из 73 не
> заводятся отдельно и заменяются `alter table` уже существующих: `org_conflicts` вместо
> `org_structure_conflicts`, `user_notes` вместо `person_notes`, `tenant_addons` вместо
> `storage_quota_addons` — итого 70 новых таблиц). Список одной строкой на подсистему:

| Подсистема | Документ пакета | Новых таблиц |
|---|---|---:|
| Рекрутинг: кандидаты и вакансии | `docs/v2/28-recruiting-candidates.md`, `29-vacancies.md` | по счётчикам `40` §2 |
| Жизненный цикл и офбординг | `docs/v2/33-lifecycle.md` | — |
| ИИ-собеседование | `docs/v2/30-ai-interview.md` | — |
| Библиотека модулей | `docs/v2/31-module-library.md` | — |
| Оргструктура | `docs/v2/32-org-structure.md` | — |
| Хранилище | `docs/v2/34-storage.md` | — |
| Тариф и лимиты | `docs/v2/35-billing-limits.md` | — |
| Обратная связь по контенту | `docs/v2/36-content-feedback.md` | — |
| Делегирование проверки | `docs/v2/37-review-delegation.md` | — |
| Расширения карточки человека | `docs/v2/38-people-extensions.md` | — |

Точный список таблиц и колонок каждой подсистемы — в `docs/v2/40-data-model-delta.md` §2 и §3;
этот документ переносить построчно не нужно, он остаётся источником истины и обновляется по
мере реализации PR пакета (`docs/v2/45-plan.md`).

**Отдельно:** `users.hired_at` уже существует и имеет тип `date`; пакет **не переопределяет**
её тип и не добавляет её заново (`docs/v2/28-recruiting-candidates.md` §3.2).
