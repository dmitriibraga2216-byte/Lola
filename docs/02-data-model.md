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
  candidates_enabled boolean not null default false, -- рекрутинг выключен, пока тенант его не включил
                                             -- (`v2/28` §3, `v2/44` В-14): до включения кандидатов в тенанте нет
                                             -- ни одного, и откат `users.kind` сводится к выключению флага
  archived_at timestamptz,                   -- `25` §8: мягкое удаление, tenant.purge через 30 дней; Spec 25
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- status: CHECK на active | suspended | archived (Spec 25). suspended — вход закрыт (403 tenant_suspended),
-- задачи стоят, данные целы; archived — команда оператора на удаление, исполняется задачей tenant.purge.

-- Тариф (`24` §4.4, `v2/35` §3.1). Платформенная, без tenant_id и RLS. PK по code:
-- колонки id у тарифа нет и не заводится (`v2/44` В-5) — на code ссылается tenants.plan
create table plans (
  code text primary key,                     -- trial | point | network | custom
  name text not null, title_uk text,
  tier smallint not null default 0,          -- 9 тиров сетки (`v2/35` §3.4)
  max_users int, max_storage_gb int, max_sms_per_month int,        -- оси users_active, storage_bytes, sms_out
  max_candidates int, max_ai_generate_ops int, max_ai_review_ops int,
  max_ai_interview_ops int, max_export_rows int,                   -- пять новых осей (`v2/44` В-5)
  ai_included boolean not null default true, -- ИИ входит в план, а не продаётся подпиской (`v2/35` §7.7)
  ai_term_days int,                          -- собственный срок ИИ от даты подключения
  addons_allowed text[] not null default '{}', -- коды plan_addons, доступные на тарифе
  is_active boolean not null default true,
  valid_from date not null default current_date, valid_to date,
  features jsonb not null default '{}', modules text[], price_uah int, sort int not null default 0
);

-- Цена тарифа за месяц; за год списывается ×12 (`v2/35` §3.4). Платформенная, вне RLS.
-- FK на plan_code, а не plan_id uuid: у plans нет колонки id (`v2/44` В-5)
create table plan_prices (
  id uuid primary key default gen_random_uuid(),
  plan_code text not null references plans(code) on delete cascade on update cascade,
  billing_period text not null,              -- month | year
  currency char(3) not null default 'EUR',
  amount_minor bigint not null check (amount_minor >= 0),  -- деньги целым числом
  valid_from date not null default current_date, valid_to date,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (plan_code, billing_period, currency, valid_from)
);

-- Каталог докупаемых опций (`v2/35` §3.4). Платформенная, вне RLS.
-- unit_step — в единице своей оси: байты для storage_bytes, операции для ИИ-осей, дни для ai_term
create table plan_addons (
  code text primary key,                     -- storage_pack | ai_ops_pack | sms_pack | candidates_pack | ai_term
  name text not null,
  axis text not null,                        -- limit_axis либо служебное ai_term (растёт срок ИИ, а не ось)
  unit_step bigint not null check (unit_step > 0),
  term text not null,                        -- period | perpetual
  is_public boolean not null default true, sort int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- Докупленные опции тенанта (`v2/35` §3.5). С RLS
create table tenant_addons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  addon_code text not null references plan_addons(code) on delete restrict on update cascade,
  qty int not null check (qty > 0),
  unit_step bigint not null check (unit_step > 0), -- снимок шага на момент покупки
  valid_from date not null default current_date,
  valid_until date,                          -- null = до отключения оператором
  source text not null default 'purchase',   -- purchase | grant | compensation
  payment_id uuid,                           -- FK на tenant_payments — этап PR-10
  created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index on tenant_addons (tenant_id, addon_code, valid_until);

-- Подписка тенанта и переопределение лимитов (`24` §4.4, `25` §10, `v2/35` §3.2); в колонках
-- лимита null — значение берётся из тарифа plans. Одиннадцать осей `limit_axis` — ЯВНЫМИ
-- колонками (`v2/44` В-5): шесть прежних под своими именами плюс пять новых; telegram_out
-- колонки не получает (мягкая ось, только наблюдение). С RLS. Spec 25, `v2/45` PR-08
create table tenant_limits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique,
  users int, storage_gb int, sms_per_month int, api_per_minute int, webhooks int,
  -- users = users_active · storage_gb = storage_bytes (лимит в ГБ, потребление в байтах) ·
  -- sms_per_month = sms_out · api_per_minute = api_rate_rpm · webhooks = integrations_active
  -- (смысл расширен на коннекторы, колонка не переименовывается)
  candidates int, ai_generate_ops int, ai_review_ops int, ai_interview_ops int, export_rows int,
  active_jobs int,                           -- квота задач тенанта на круг воркера (`25` §5), по умолчанию 100; ось вне пакета
  billing_period text not null default 'month',  -- month | year
  status text not null default 'trial',      -- trial | active | grace | readonly | suspended (`v2/35` §4)
  paid_until date, grace_until date, ai_until date,  -- таймер ИИ не зависит от таймера тарифа
  autorenew boolean not null default true,
  currency char(3) not null default 'EUR',
  ai_status text not null default 'active',  -- active | expired | off
  updated_by uuid references platform_admins(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Счётчик потребления за биллинговый период (`v2/35` §3.5, §7.5). Реальное время: строка
-- пополняется там же, где ось проверяется на лимит. Лимит здесь не считается — формула одна
-- и живёт в effectiveLimits() (`v2/35` §7.3, `v2/44` В-5). С RLS. `v2/45` PR-09
create table usage_counters (
  tenant_id uuid not null references tenants(id) on delete cascade,
  axis text not null,                        -- limit_axis (`v2/35` §7.1)
  period_start date not null, period_end date not null,
  used bigint not null default 0,
  limit_snapshot bigint,                     -- снимок лимита на момент ОТКРЫТИЯ периода; null = без обмежень
  updated_at timestamptz not null default now(),
  primary key (tenant_id, axis, period_start)
);
create index usage_counters_axis_idx on usage_counters (tenant_id, axis, period_end desc);

-- Журнал расхода, хранение 400 дней (`v2/35` §3.5, §9 «Журнал ШІ-операцій»). Пишется только
-- измеряемыми операциями — шесть usage_ref_kind; моментальные оси строк расхода не создают. С RLS
create table usage_events (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  axis text not null,                        -- limit_axis
  delta bigint not null,
  ref_kind text not null,                    -- usage_ref_kind
  ref_id uuid, actor_user_id uuid,
  meta jsonb not null default '{}',
  request_context jsonb,                     -- как у остальных журналов (правило «журналы пишут одинаково»)
  occurred_at timestamptz not null default now()
);
create index usage_events_axis_idx on usage_events (tenant_id, axis, occurred_at desc);

-- Открытое предупреждение по оси — состояние баннера, а не журнал (`v2/35` §3.5, §7.9).
-- Частичный уникальный индекс держит «одно открытое предупреждение на ось и уровень». С RLS
create table limit_notices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  axis text not null,                        -- limit_axis
  level text not null,                       -- limit_notice_level: warn | exceeded
  value_at_raise bigint not null, limit_at_raise bigint,
  resolved_at timestamptz,                   -- потребление вернулось ниже 80 % — запись закрыта
  dismissed_by uuid, dismissed_until timestamptz, -- крестик прячет баннер на 24 часа; exceeded закрыть нельзя
  raised_at timestamptz not null default now()
);
create unique index limit_notices_open_uidx on limit_notices (tenant_id, axis, level) where resolved_at is null;
create index on limit_notices (tenant_id, raised_at desc);

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
  kind text not null default 'employee',      -- user_kind: employee | candidate (`v2/28` §2, `v2/44` В-8, В-14).
                                              -- Кандидат и сотрудник — одна запись с разным kind; перевод в штат
                                              -- меняет kind, а не заводит вторую строку. CHECK users_kind_chk.
                                              -- Любая списочная выборка людей идёт через server/services/repo/people.ts
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
  -- Колонки кандидата (`v2/28` §3.2, миграция 0064_v2_candidates; `v2/40` §3.2 — 11 из 16).
  -- У сотрудника они пусты: users_candidate_coherence_chk требует candidate_state ровно
  -- у кандидата и запрещает его у сотрудника. vacancy_id приезжает развязкой PR-15 (`v2/44` В-13)
  candidate_state text,                       -- candidate_state, CHECK users_candidate_state_chk
  candidate_status_id uuid references candidate_statuses(id) on delete set null, -- колонка канбана
  source text,                                -- candidate_source, CHECK users_candidate_source_chk
  source_detail text,                         -- площадка или ФИО рекомендателя
  recruiter_id uuid references users(id) on delete set null,
  access_until date,                          -- право входа, НЕ дедлайн прохождения (`v2/28` §3.2)
  comm_language text not null default 'uk',   -- язык писем и интерфейса кандидата
  resume_asset_id uuid references media_assets(id) on delete set null, -- origin='candidate_cv'
  converted_from_candidate_at timestamptz,    -- факт прихода сотрудника через воронку
  consent_given_at timestamptz,               -- согласие на обработку ПД (`v2/28` §7.9)
  consent_expires_at date,                    -- дата, после которой ПД подлежат стиранию
  -- Воронка (`v2/28` §7.5, §7.9; миграция 0068_v2_candidates_funnel)
  candidate_state_at timestamptz,             -- когда состояние менялось в последний раз: от него считает auto_archive
  anonymized_at timestamptz,                  -- отметка необратимого стирания ПД по истёкшему согласию
  unique (tenant_id, phone),
  unique (tenant_id, email)
);
-- Индекс под списки сотрудников: (tenant_id, status) where kind = 'employee' (`v2/44` В-14).
-- Полный (tenant_id, status) остаётся — по нему идут выборки кандидатов и платформенные счётчики.
-- Рекрутинг добавляет idx_users_tenant_kind и два частичных where kind = 'candidate':
-- idx_users_tenant_candidate_status и idx_users_tenant_recruiter (`v2/28` §3.2).
-- Воронка (0068) добавляет ещё три частичных: idx_users_candidate_board
-- (tenant_id, candidate_status_id, created_at desc, id) — страница колонки канбана по 50 карточек;
-- idx_users_candidate_state_at и idx_users_candidate_consent — два ночных прохода `v2/28` §11.

-- Рекрутинг: воронка кандидата (`v2/28` §3.3–§3.6, миграция 0064_v2_candidates).
-- Записи самого кандидата здесь нет — он живёт в users с kind='candidate'.
create table candidate_statuses (             -- колонки канбана, расширяемый справочник тенанта
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null,
  name_uk text not null, name_en text,
  color text not null default 'ink',          -- токен бренд-бука: ink | sun | teal | coral
  sort int not null,
  is_system boolean not null default false,   -- шесть системных: нельзя удалить и сменить code
  maps_to text not null default 'active',     -- candidate_state, к которому приравнена колонка
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references users(id) on delete set null,
  unique (tenant_id, code)
);

create table candidate_scores (               -- четыре независимых вида оценки, с историей
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid not null references users(id) on delete cascade,
  kind text not null,                         -- candidate_score_kind
  value_num numeric(6,2),
  scale_id uuid references scales(id),
  scale_level_id uuid references scale_levels(id),
  comment text,
  source_type text, source_id uuid,           -- чем порождена: попытка, практикум, собеседование
  author_id uuid references users(id) on delete set null,
  is_current boolean not null default true,   -- действующая одна: uq_candidate_scores_current
  created_at timestamptz not null default now()
);

create table candidate_comments (             -- служебная переписка о кандидате; ему не видна
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid not null references users(id) on delete cascade,
  author_id uuid not null references users(id),
  body text not null,                         -- 1–4000
  visibility text not null default 'recruiters', -- candidate_comment_visibility
  created_at timestamptz not null default now(),
  edited_at timestamptz, deleted_at timestamptz
);

create table candidate_status_history (       -- лента смен колонки канбана: журнал
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid not null references users(id) on delete cascade,
  from_status_id uuid references candidate_statuses(id) on delete set null,
  to_status_id uuid not null references candidate_statuses(id),
  reason_code text, reason_text text,
  actor_id uuid references users(id) on delete set null,
  is_automatic boolean not null default false,
  request_context jsonb,                      -- CLAUDE.md п. 14: журнал пишет контекст одинаково
  created_at timestamptz not null default now()
);

-- Рекрутинг: вакансия (`v2/29` §3.1–§3.4, миграции 0071_v2_vacancies и 0072_v2_users_vacancy_fk).
-- Вакансия НЕ носитель правил прохождения (CLAUDE.md п. 11, инвариант 1 `v2/29` §1): она
-- хранит шаблон параметров назначения, а применяется созданием обычной assignments.
-- Ни attempts, ни pass_score, ни due_at, ни time_limit колонками здесь не заводятся.
create table vacancy_templates (              -- самостоятельная сущность, а не вакансия-черновик
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,                         -- 3–120, unique (tenant_id, name)
  description text,
  payload jsonb not null default '{}'::jsonb,  -- снимок полей вакансии КРОМЕ точки и рекрутера
  criteria jsonb not null default '[]'::jsonb, -- вложены, чтобы применение шло одной транзакцией
  languages jsonb not null default '[]'::jsonb,
  usage_count int not null default 0,
  is_active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table vacancies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null,                        -- 3–200
  state text not null default 'draft',        -- vacancy_state
  category_id uuid references course_categories(id) on delete set null,
  recruiter_id uuid references users(id) on delete set null,   -- попадает в users.recruiter_id откликнувшегося
  course_id uuid references courses(id) on delete set null,    -- «рекрутинговий курс»: что назначается
  course_version_id uuid references course_versions(id) on delete set null, -- фиксируется при публикации
  location_id uuid references locations(id) on delete set null,
  org_unit_id uuid references org_units(id) on delete set null,
  position_id uuid references positions(id) on delete set null,
  description_html text, requirements_html text, duties_html text, extra_html text,
  ai_blocks jsonb not null default '{}'::jsonb, -- маркировка сгенерированного ИИ текста (§3.6)
  employment_type text,                       -- vacancy_employment_type
  work_format text,                           -- vacancy_work_format
  country_code char(2), city text,
  experience_level text,                      -- vacancy_experience_level
  education_level text,                       -- vacancy_education_level
  salary_from numeric(12,2), salary_to numeric(12,2),
  salary_currency char(3) not null default 'UAH',
  salary_visible boolean not null default false,
  assignment_template jsonb not null default '{}'::jsonb, -- ШАБЛОН параметров, не правила (§3.5)
  public_token text,                          -- 22 знака base62; uq_vacancies_public_token — глобально
  public_enabled boolean not null default false,
  public_apply_otp boolean not null default true,
  apply_daily_cap int not null default 200,   -- 10–5000
  source_budget numeric(12,2),
  template_id uuid references vacancy_templates(id) on delete set null,
  published_at timestamptz, closed_at timestamptz,
  close_reason text,                          -- vacancy_close_reason
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  -- Правило эталона «без курса и точки ссылка не создаётся» — констрейнтом, а не только формой:
  -- ссылка без назначаемого курса это отклик, который некуда девать (`v2/29` §7.1)
  constraint vacancies_public_chk check (not public_enabled or
    (course_id is not null and location_id is not null and public_token is not null))
);

create table vacancy_languages (              -- пара «язык + уровень» плюс обязательность
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vacancy_id uuid not null references vacancies(id) on delete cascade,
  lang_code text not null,
  level text not null,                        -- vacancy_language_level (CEFR + native)
  is_required boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, vacancy_id, lang_code)
);

create table vacancy_criteria (               -- рамка решения человека, а не правило прохождения
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vacancy_id uuid not null references vacancies(id) on delete cascade,
  name text not null,                         -- 2–120
  description text,
  weight numeric(5,2) not null default 1,     -- > 0 и <= 100
  scale_min numeric(6,2) not null default 0,
  scale_max numeric(6,2) not null default 5,  -- строго больше scale_min
  is_critical boolean not null default false, -- предупреждение, а не запрет найма (инвариант 18)
  origin text not null default 'manual',      -- vacancy_criterion_origin
  sort int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table vacancy_criterion_scores (       -- балл одного автора по одному критерию
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid not null references users(id) on delete cascade,
  criterion_id uuid not null references vacancy_criteria(id) on delete cascade,
  value_num numeric(6,2) not null,            -- в пределах шкалы своего критерия
  comment text,
  author_id uuid not null references users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (tenant_id, candidate_id, criterion_id, author_id)
);
-- Свёртка баллов — одна строка candidate_scores с kind='recruiter', source_type='vacancy_criteria':
-- каждый балл нормируется к 0–10 как (value − min)/(max − min) × 10, итог — Σ(норм × weight)/Σ(weight).

create table vacancy_applications (           -- отклик по публичной ссылке (`v2/29` §3.9, миграция 0074)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vacancy_id uuid not null references vacancies(id) on delete cascade,
  state text not null default 'pending',      -- vacancy_application_state
  full_name text not null,                    -- 2–120
  phone text, email text, comment text,       -- телефон ИЛИ почта обязательны
  resume_asset_id uuid references media_assets(id) on delete set null,
  source text not null default 'vacancy_link', -- candidate_source: метка площадки даёт job_board
  source_detail text, utm jsonb not null default '{}'::jsonb,
  consent_given_at timestamptz not null,      -- момент ИЗ ФОРМЫ: от него считается срок стирания ПД
  consent_text_version text not null,
  candidate_id uuid references users(id) on delete set null,
  spam_score int not null default 0,          -- слагаемые `v2/29` §7.7
  spam_reasons text[] not null default '{}',
  ip_hash text not null,                      -- HMAC-SHA256 адреса с посолью тенанта; сырой IP не хранится
  user_agent_hash text, form_nonce text not null, fill_seconds int,
  otp_confirmed_at timestamptz,
  reviewed_by uuid references users(id) on delete set null,
  reviewed_at timestamptz, reject_reason text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public_apply_attempts (          -- журнал обращений к публичной форме (`v2/29` §7.4)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vacancy_id uuid references vacancies(id) on delete cascade,
  ip_hash text not null,
  outcome text not null,                      -- public_apply_outcome
  reason text,                                -- причина блокировки: ip_hour, ip_day, daily_cap…
  created_at timestamptz not null default now()
);
-- Ответ публичной формы одинаков при успехе и при отказе (`v2/29` §7.3), поэтому «почему не
-- приняли» видно только здесь. Строки старше 30 дней убирает задача vacancy.attempts_gc.

-- Язык публичной страницы вакансии — колонка vacancies.public_language (`v2/29` §7.20,
-- миграция 0074), null = язык пространства: язык администратора, открывшего форму, к
-- посетителю отношения не имеет, а §7.20 требует записать откликнувшемуся comm_language.

-- Развязка цикла «кандидаты ↔ вакансии» (`v2/44` В-13, миграция 0071): колонка users.vacancy_id
-- и её ключ users_vacancy_id_fk (on delete set null) заводятся ОТДЕЛЬНОЙ миграцией после
-- vacancies — порядка создания таблиц, снимающего цикл, не существует. Плюс частичный индекс
-- idx_users_tenant_vacancy (tenant_id, vacancy_id) where kind = 'candidate'.

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
  default_scope_type text not null default 'location', -- «область по умолчанию» роли: tenant | org_unit | location (у `owner` — tenant: владение не бывает «на точке»)
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
  is_owner boolean not null default false,    -- это назначение роли `owner` (`01` §1.9.4); пишет только триггер user_roles_is_owner_trg из roles.code
  unique (tenant_id, user_id, role_id, scope_type, scope_id)
);
-- Владелец в тенанте ровно один (`01` §1.2, §1.9.4). Инвариант держится здесь, а не в сервисе:
-- условие частичного индекса не умеет читать соседнюю таблицу, поэтому код роли денормализован
-- в `is_owner` триггером, который больше никто не перебивает.
create unique index user_roles_single_owner_uq on user_roles (tenant_id) where is_owner;

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
  sort int not null default 0,
  -- владелец категории — адресат жалобы на материал её курсов, когда все авторы неактивны
  -- (`v2/36` §7.5 в; PR-24, миграция 0077_v2_content_routing)
  owner_id uuid references users(id) on delete set null
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

> [дополнено пакетом `docs/v2`, П-15] Состав ключей режет **второй** фильтр — возможности
> этапа курса (`docs/v2/33-lifecycle.md` §3.3, §7.5). Если у этапа выключена возможность,
> соответствующий ключ `params` **не сохраняется вовсе** — а не сохраняется со значением по
> умолчанию: иначе у курса «Бази знань» в `params` оказался бы `deadline_mode`, и отчёт
> «нарушены сроки» начал бы считать нарушения там, где сроков нет. Соответствие «ключ →
> возможность» объявлено один раз в `server/services/taskParams.ts` (`PARAM_KEY_CAPABILITY`),
> решение по ключу принимает `stageCan()`. Правила прохождения при этом остаются в назначении
> (правило 11 CLAUDE.md): этап ограничивает **набор** ключей, но ни одного правила не хранит.
> Индекс `assignments (tenant_id, content_type, content_id)` (в коде — `subject_type`,
> `subject_id`; миграция `0058`) обслуживает чтение этапа при записи `params` и сквозную
> проверку 14 (`docs/v2/42-stages-delta.md` §5).

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
  -- карточка жалобы, из которой запущено «Перерахувати» (`v2/36` §7.8, П-12.4, PR-24): логика
  -- пересчёта одна, точек входа две — запись одна и та же, различает их эта ссылка
  issue_id uuid references content_issues(id) on delete set null,
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
  sent_at timestamptz,
  -- `23` §6.6, миграция 0075 (PR-30): эскалация обработана / кому ушла. `escalated_at` без
  -- `escalated_to_id` — «эскалировать некому» (руководителя нет по `resolveManager()`):
  -- строка закрыта и в следующий проход `escalationScan` не попадает.
  escalated_at timestamptz,
  escalated_to_id uuid references users(id) on delete set null
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
  checksum_sha256 text,                        -- sha256, дедупликация в тенанте (`11` §7 п. 7)
  owner_user_id uuid references users(id) on delete set null, -- чей файл по смыслу (`v2/34` §7.1); кто загрузил — событие media.upload в audit_log (`v2/44` В-4)
  origin text not null default 'other',        -- media_origin, 15 значений (`v2/40` §4.2); задаётся при выдаче presigned URL
  course_id uuid references courses(id) on delete set null,
  stage_code text,                             -- ключ разбивки хранилища = код этапа (`v2/44` В-10), снимок на момент создания
  enrollment_id uuid references enrollments(id) on delete set null,
  source_entity text, source_id uuid,          -- мягкая полиморфная ссылка (`v2/44` В-11), без FK
  lifecycle text not null default 'active',    -- media_lifecycle; ось отдельная от status (`v2/34` §3.1)
  is_evidence boolean not null default false,  -- файл, на который опирается кадровое решение (`v2/34` §7.1)
  retention_until timestamptz, orphaned_at timestamptz, purge_after timestamptz,
  last_accessed_at timestamptz,
  deleted_at timestamptz,                      -- мягкое удаление: объект в S3 остаётся до purge_after (`v2/34` §7.2)
  deleted_by uuid references users(id) on delete set null,
  delete_reason text,                          -- обязательна для is_evidence (`v2/34` §6.1)
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

> [исправлено, `gamification` (24.09.2026): книга построена, миграция `gamification`] Ранее:
> `points_ledger(id, tenant_id, user_id, delta, reason, ref_id, created_at)` — одна валюта без
> остатка в строке. Эталон держит **две** валюты в назначении («Бали за виконання завдання» —
> в рейтинг, «Бонуси за виконання завдання» — в магазин, `15` §14.3) и журнал «с остатком в
> каждой строке» (`21` §14.9). Итоговая книга ниже; `badges`/`user_badges` по-прежнему не
> построены (D-068, `33`) — правил бейджей в ТЗ нет.

Книга операций — **единственный источник баланса**. `[решение]` Баланс не хранится отдельным
полем и не кешируется: это `balance_after` последней строки человека по валюте (индекс
`(tenant_id, user_id, currency, id)`). Кеш был бы второй правдой, которую пришлось бы пересобирать
и сверять, а последняя строка читается так же дёшево. Согласованность `balance_after` держит
блокировка счёта (`pg_advisory_xact_lock` по тенанту, человеку и валюте) на время записи —
`server/services/pointsLedger.ts`. Расхождение с суммой `delta` ищет ночная сверка
(`ledgerDrift`) и пишет в лог ошибок, книга не правится. Строки не правятся и не удаляются:
списание — отрицательная строка, возврат при отмене заказа — компенсирующая `refund`.

```sql
-- Итоговая книга (миграция `gamification`); `reason` стала `event` (перечисление
-- points_event), тип ссылки задаёт событие — отдельной колонки `ref_type` из `21` §14.9 нет
points_ledger(
  id bigserial primary key,          -- порядок строк = порядок вставки под блокировкой счёта
  tenant_id uuid not null references tenants on delete cascade,
  user_id uuid not null references users on delete cascade,
  currency text not null,            -- points_currency: points (рейтинг) | bonuses (магазин)
  delta int not null,                -- <> 0; списание — отрицательное
  balance_after int not null,        -- >= 0: «Бонуси після операції» журнала эталона
  event text not null,               -- points_event: task_completed | manual | purchase | refund
  ref_id uuid,                       -- task_completed → assignments.id; purchase/refund → shop_orders.id; manual → null
  title text,                        -- «Деталі»: название задания/товара на момент операции
  comment text,                      -- причина ручной операции или отмены
  actor_id uuid references users on delete set null,  -- кто провёл (`granted_by` из `21` §3.7); null — система
  request_context jsonb,             -- CLAUDE.md п. 14
  created_at timestamptz not null default now(),
  check ((event = 'manual') = (ref_id is null))
)
-- Идемпотентность: одно событие со ссылкой — одна строка (manual без ссылки — сколько угодно)
create unique index points_ledger_once_uq on points_ledger (tenant_id, user_id, currency, event, ref_id);
```

Исходный набросок этапа 5 (оставлен для истории):

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

## Очередь проверки

> [исправлено, `docs/v2/43-reconciliation.md` Р-3 и решение `docs/v2/44-decisions.md` В-2:
> таблицы не было ни в этом документе, ни в базе — «витрина» была реализована двумя запросами
> на лету] Ранее: раздела не существовало; `14` §3.3 оставлял выбор реализации открытым.

Единая очередь проверки — **таблица**, а не витрина и не матвью: на строку очереди ссылаются
делегирование, события SLA, «каким правилом назначено» и суточная статистика проверяющего,
а у строки, собранной запросом, устойчивого идентификатора нет (обоснование целиком —
`docs/v2/44-decisions.md` В-2). Содержание работы сюда не копируется: текст ответа, файлы и
критерии читаются из источника по `(task_type, source_id)`.

```sql
-- Миграция 0066_v2_review_queue. Наполняется только server/services/reviewQueue.ts
-- (enqueueReview / closeReview) в транзакции самого события: ни триггера, ни матвью
-- «раз в минуту», ни пересборки с нуля (`v2/42` §5, сквозная проверка 21).
create table review_queue_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- идентичность работы: одна ось `task_type` (review_task_type), ссылка полиморфная
  task_type text not null,
  source_id uuid not null,        -- attempt_answers.id | workshop_submissions.id | …
  user_id uuid not null references users(id) on delete cascade,
  subject_kind text not null default 'employee',   -- снимок users.kind на момент постановки
  -- снимки для списка: экран рисуется одним запросом, без join к четырём источникам
  task_title text, track_id uuid,
  location_id uuid references locations(id) on delete set null,
  position_id uuid references positions(id) on delete set null,
  submitted_at timestamptz not null default now(),
  completed_at timestamptz,       -- «Дата виконання»: момент решения, у waiting пусто
  attempt_no int not null default 1,
  estimated_seconds int, content_seconds int not null default 0,
  attempt_seconds int not null default 0, time_confidence text not null default 'ok',
  -- состояние очереди
  status text not null default 'waiting', priority int not null default 0,
  -- маршрутизация и делегирование (наполняется PR-19; два FK ставит его же миграция)
  assigned_reviewer_id uuid references users(id) on delete set null,
  assigned_at timestamptz, assigned_by_rule_id uuid, delegation_id uuid,
  origin_reviewer_id uuid references users(id) on delete set null,
  delegation_depth int not null default 0,
  -- сроки
  sla_hours int not null default 48, sla_due_at timestamptz,
  sla_warned_at timestamptz, sla_breached_at timestamptz,
  escalated_at timestamptz, escalated_to_id uuid references users(id) on delete set null,
  constraint rqi_task_type_chk check (task_type in
    ('quiz_open_answer','workshop','offline_confirm','survey_open','ai_interview_review')),
  constraint rqi_subject_kind_chk check (subject_kind in ('employee','candidate')),
  constraint rqi_status_chk check (status in ('waiting','in_review','done')),
  constraint rqi_time_confidence_chk check (time_confidence in ('ok','partial','unreliable')),
  constraint rqi_depth_chk check (delegation_depth between 0 and 2),
  constraint rqi_sla_hours_chk check (sla_hours between 1 and 720),
  constraint rqi_attempt_no_chk check (attempt_no >= 1),
  constraint rqi_seconds_chk check (content_seconds >= 0 and attempt_seconds >= 0
    and (estimated_seconds is null or estimated_seconds between 60 and 216000))
);
create index idx_review_queue_items_tenant on review_queue_items (tenant_id, status, sla_due_at);
create index idx_review_queue_items_reviewer on review_queue_items (tenant_id, assigned_reviewer_id, status) where status <> 'done';
create index idx_review_queue_items_origin on review_queue_items (tenant_id, origin_reviewer_id) where delegation_id is not null;
-- одна единица работы — одна строка: повторная сдача после доработки открывает ту же строку
create unique index uq_review_queue_items_source on review_queue_items (tenant_id, task_type, source_id);
```

`workshop_submissions.reviewer_id`, `claimed_at`, `sla_due_at` на переходный период остаются и
заполняются той же транзакцией — **зеркало для совместимости**. Новому коду читать их нельзя;
удаляются отдельной миграцией через один PR после перевода читателей (В-2).

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
-- Построено (`gamification`, 24.09.2026). Дополнено против строк выше `[решение]`:
--   shop_categories(name, sort)  — справочник категорий тенанта (`21` §14.3 «Додати нову
--     категорію»); стартовые «Мерч · Вихідні дні · Знижки · У закладі» — решение владельца
--     продукта 24.09.2026, засеваются ensureTenantDefaults и миграцией, дальше их ведёт администратор;
--   shop_items: stock null — без ограничения (выходной, скидка, «щось у закладі»: физического
--     остатка нет, выдача — отметкой ответственного); image_key — media_assets.id (origin
--     content_cover); created_by; deleted_at — мягкое удаление (на товар ссылаются заказы и книга);
--   shop_orders: price_bonuses — снимок цены (возврат = ровно списанное); ready_at; cancelled_at,
--     cancelled_by (null при cancelled — автоотмена по сроку резерва), cancel_reason.
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
       sms_month int, courses_count int, assignments_count int, attempts_month int,
       -- восемь колонок пакета (`v2/35` §3.3, `v2/45` PR-09); plan_code, а не plan_id:
       -- колонки id у тарифа нет (`v2/44` В-5). sms_month остаётся календарным месяцем,
       -- sms_out — расход оси за биллинговый период
       plan_code text references plans(code), candidates_active int,
       storage_by_category jsonb, ai_ops jsonb, sms_out int, telegram_out int,
       integrations_active int, axes jsonb)  -- axes — нетарифная ось без своей колонки
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
-- points_ledger (книга баллов и бонусов, §2.10; `gamification`).
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
  kind text not null,             -- org_conflict_kind, десять значений (см. перечисления; `v2/44` В-7)
  severity text not null default 'warning',  -- org_conflict_severity (PR-30)
  node_id uuid,                   -- узел дерева, на котором конфликт найден; null — конфликт про человека (PR-30)
  source text not null default 'manual',  -- manual | import
  import_job_id uuid, details jsonb, actor_id uuid,
  request_context jsonb, resolved_at timestamptz, resolved_by uuid, created_at   -- разрешение: details.resolution {action acknowledge|close_placement, placementId, comment, by, at}
)
-- Открытый конфликт — `resolved_at is null`. Колонок `status` и `detected_at` из `v2/32` §3.3
-- здесь нет намеренно (`v2/44` В-7): `detected_at` — второе имя `created_at`, а третье место
-- для факта «разобран» неизбежно разойдётся с парой resolved_at / resolved_by.

-- Дерево подчинения (`v2/32` §3, миграция 0075). Кто кому подчиняется — третья сущность,
-- отдельная от `org_units` («до якого шматка компанії належить») и `positions` («як
-- називається робота»). Единственный вход для вопроса «хто керівник людини X» —
-- resolveManager() (server/services/orgManager.ts), патч П-16.4.
org_nodes(
  id, tenant_id, parent_id uuid,  -- null = корень, до 10 корней на тенант
  path ltree not null, depth int not null default 1, sort int not null default 0,  -- depth = nlevel(path), глубина ≤ 12
  type text not null default 'position',   -- org_node_type
  title text not null,            -- 2…120, без < >
  external_key text, note text,   -- ключ импорта (PR-31); заметка, в витрине не видна
  position_id uuid, org_unit_id uuid, location_id uuid,
  holder_user_id uuid,            -- кэш держателя именного узла; источник истины — org_node_assignments
  headcount_planned int not null default 1, is_manager_point boolean not null default false,
  state text not null default 'vacant',    -- org_node_state
  created_by uuid, archived_at timestamptz, created_at, updated_at,
  unique (tenant_id, path), unique (tenant_id, external_key)
)
-- Триггер org_nodes_guard: путь ребёнка = путь родителя + метка, depth = nlevel(path),
-- родитель того же тенанта и **никаких циклов** — предка нельзя подчинить его потомку.
org_node_assignments(
  id, tenant_id, node_id, user_id, placement_id uuid,
  is_primary boolean not null default true,  -- ровно одно активное основное на человека (частичный уникальный индекс)
  role_in_node text not null default 'holder',   -- org_assignment_role
  started_at date not null default current_date, ended_at date,
  ended_reason text,              -- org_assignment_end_reason
  created_by uuid, created_at, updated_at
)
org_manager_map(                  -- проекция resolveManager(); пишет только rebuildManagerMap()
  tenant_id, user_id, manager_user_id uuid,
  source text not null default 'none',   -- org_manager_source
  node_id uuid, chain uuid[] not null default '{}',  -- цепочка снизу вверх, ≤ 12
  computed_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
)
org_structure_snapshots(          -- снимок дерева; импорт и откат — PR-31
  id, tenant_id, label text not null,
  kind text not null default 'manual',   -- org_snapshot_kind
  tree jsonb not null, node_count int not null default 0, created_by uuid, created_at, updated_at
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

-- Этапы жизненного цикла (`v2/33` §3.2, `v2/40` 0005; PR-05 пакета, миграция 0057).
-- Справочник тенанта с ПЛАТФОРМЕННЫМ перечнем кодов: тенант включает, переименовывает
-- и сортирует, девятый код не заводит (`v2/33` §12.8). Поведение продукта зависит не от
-- названия этапа, а от карты возможностей `capabilities` — её читает единственная функция
-- `stageCan()` (server/services/lifecycle.ts); ветвление `if (stage.code === …)` запрещено
-- и ловится сквозной проверкой 1 в scripts/v2-crosschecks.sh.
lifecycle_stages(
  id, tenant_id, created_at, updated_at,
  code text not null,             -- lifecycle_stage_code (см. перечисления), неизменяем, CHECK
  name_uk text not null, name_en text, icon text,
  color text not null default 'ink',     -- токен бренд-бука: ink | sun | teal | coral, CHECK
  sort int not null,
  is_enabled boolean not null default true,
  expected_days int,              -- норма времени в этапе (`v2/33` §7.11), только сигнал
  capabilities jsonb not null default '{}',  -- ключи stage_capability, CHECK на состав ключей
  applies_to_candidate boolean generated always as
    (coalesce((capabilities->>'applies_to_candidate')::boolean, false)) stored,
  unique (tenant_id, code)
)
-- Восемь этапов сеются при создании тенанта (server/db/tenantDefaults.ts), значения — `v2/33` §3.3.
-- Возможности меняет только оператор платформы; тенанту — `403 capabilities.readonly` (`v2/33` §2).
-- courses += lifecycle_stage_id uuid (FK, необязателен: курс без этапа = полный набор
-- возможностей, `v2/33` §7.3), stage_locked boolean not null default false (запирается после
-- первого завершённого прохождения, §7.4; смена без подтверждения — `409 course.stage_locked`).

-- Где человек находится в цикле (`v2/33` §3.5, `v2/40` 0021; PR-07 пакета, миграция 0060).
-- Этап человека и этап курса — разные вещи и друг из друга не выводятся: человек «на
-- онбординге» параллельно проходит курс этапа «база знань». Текущая запись ровно одна —
-- частичным уникальным индексом, а не проверкой в коде.
employee_lifecycle_state(
  id, tenant_id, created_at, updated_at,
  user_id uuid not null,          -- FK users on delete cascade
  stage_id uuid not null,         -- FK lifecycle_stages
  entered_at timestamptz not null default now(),
  left_at timestamptz,            -- заполняется при переходе дальше
  entered_by uuid,                -- кто перевёл; null — автоматический переход
  reason_code text,               -- hire | rehire | advance | offboarding | manual | backfill
  is_current boolean not null default true
)
-- unique (tenant_id, user_id) where is_current; index (tenant_id, user_id, entered_at desc).
-- Переход вперёд автоматический, когда закрыты ВСЕ обязательные назначения этапа (`v2/33` §7.6);
-- граф переходов — LIFECYCLE_STAGE_FLOW в shared/enums.ts (кодов этапов в логике нет).

-- Процесс увольнения (`v2/33` §3.6, §4.2, §7.7; PR-07 пакета, миграция 0060).
offboarding_cases(
  id, tenant_id, created_at, updated_at,
  user_id uuid not null,          -- FK users on delete cascade
  state text not null default 'started',   -- offboarding_state (см. перечисления), CHECK
  reason_code text not null,      -- offboarding_reason (см. перечисления), CHECK
  reason_text text,               -- обязателен при reason_code = 'other' (форма §6.2)
  last_working_day date not null, -- не раньше чем сегодня − 30 дней (`v2/33` §12.7)
  initiated_by uuid, responsible_id uuid,  -- инициатор и ответственный — разные люди
  exit_interview_enrollment_id uuid,       -- FK enrollments; null — интервью не назначалось
  handover_done_at timestamptz, access_revoked_at timestamptz, completed_at timestamptz,
  cancelled_at timestamptz, cancel_reason text
)
-- unique (tenant_id, user_id) where state not in ('done','cancelled') — `409 offboarding.active_exists`;
-- index (tenant_id, state). Завершение транзакционно: сессии закрыты, незавершённые назначения
-- переведены в `not_assigned` с пометкой «звільнення», человек вышел из лимита активных
-- (`status = 'archived'`), запись и вся история обучения сохранены, сертификаты НЕ отозваны (П-14).

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
-- + scale — «Лінійна шкала»: числовой диапазон с настраиваемыми границами и подписями
-- концов, снято со второго эталона (патч П-12.1 `v2/39`, PR-23)
question_kind: single | multi | free | ordering | classification | comparison | answer_by_map
            | number | text_short | file | cloze | scale

-- «Метод підрахунку балів» (`12` §14.6): «За формулою» | «Все або нічого»
scoring_method: formula | all_or_nothing

-- Статус запроса дополнительной попытки (`12` §14.5: «Очікує» по умолчанию, «Надано»; «Відмовлено» — по кнопке «Відмовити» `12` §6.3)
attempt_request_status: pending | approved | rejected

-- Область действия метки (`16` §14.2; `30`): обязательна
tag_scope: user | course | resource | question | task

-- Вид конфликта оргструктуры (`16` §7, §14; Spec 22; unit_missing — по мокапу OrgConflicts, Spec 16).
-- Пять последних добавил PR-30 вместе с деревом `org_nodes` (`v2/32` §3.3, решение `v2/44` В-7).
-- Три имени пакета в перечень не вошли: `self_manager`, `multi_primary` и `orphan_user` —
-- переименования manager_self, double_unit и unit_missing, а не новые виды конфликта.
org_conflict_kind: double_unit | placement_replaced | manager_self | manager_cycle | unit_missing
                 | no_manager | manager_mismatch | depth_exceeded | dismissed_holder | position_mismatch

-- Важность конфликта оргструктуры (`v2/32` §3.3, `v2/44` В-7): взят существующий
-- security_severity, а не своя пара error | warning — один смысл, одно написание
org_conflict_severity: info | warning | critical

-- Вид узла дерева подчинения (`v2/32` §3.2): штатная точка со счётчиком «N з M» либо именная
org_node_type: position | employee

-- Состояние узла (`v2/32` §4): физического удаления нет, красная корзина эталона — архивация
org_node_state: vacant | occupied | archived

-- Роль человека в узле (`v2/32` §3.3): тримач посади | виконувач обов'язків | заступник
org_assignment_role: holder | acting | deputy

-- Почему назначение на узел закрыто (`v2/32` §3.3); обратного перехода нет
org_assignment_end_reason: moved | dismissed | node_archived | manual

-- Откуда взят руководитель — результат resolveManager() (`v2/32` §7.8, патч П-16.4).
-- Строгий приоритет: дерево → точка → роль в области → никого
org_manager_source: org_tree | location | functional | role_scope | none

-- Вид снимка дерева (`v2/32` §3.3); откат по снимку — PR-31
org_snapshot_kind: manual | auto_daily | pre_import | pre_bulk_move

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

-- Коды этапов жизненного цикла (`v2/33` §3.2, `v2/44` В-3): платформенный перечень,
-- тенант включает и переименовывает, но девятый код не выдумывает (`v2/33` §12.8)
lifecycle_stage_code: recruiting | onboarding | integration | training
                    | attestation | psychological | knowledge | offboarding

-- Возможности этапа (`v2/33` §3.3) — фиксированный перечень ключей `lifecycle_stages.capabilities`;
-- неизвестный ключ отвергается 422, отсутствующий читается как false (`v2/44` В-3)
stage_capability: progress | deadline | grading | attempts | review | certificate | graph
                | ai_generate | applies_to_candidate | applies_to_employee | counts_in_rating

-- Почему человек оказался на этапе — `employee_lifecycle_state.reason_code` (`v2/33` §3.5).
-- `backfill` — догоняющее состояние миграции 0060 для уже работавших сотрудников
lifecycle_reason_code: hire | rehire | advance | manual | backfill | offboarding
                     | offboarding_cancelled

-- Состояния случая увольнения (`v2/33` §3.6, §4.2): отмена возможна до `done`, после —
-- только повторный найм (правило `v2/33` §7.8)
offboarding_state: started | handover | interview | done | cancelled

-- Причины увольнения (`v2/33` §3.6, форма §6.2): свободный текст обязателен только при `other`;
-- разрез отчёта «Офбординг» (`v2/33` §9 п. 3) строится по этим кодам
offboarding_reason: own_wish | probation_failed | performance | redundancy
                  | no_show | end_of_contract | transfer_out | other

-- Матеріал, який можна оцінити читачем («Оцінок: N», `21` §14.1); докс/33 D-042, своє
content_rating_target: resource | knowledge_article

-- Вид человека в `users` (`v2/28` §2, `v2/44` В-8, В-14): кандидат и сотрудник — одна запись
-- с разным `kind`, а не две таблицы. Перевод кандидата в штат меняет `kind`, а не создаёт
-- вторую строку: история откликов, оценок и обучения остаётся на том же `users.id`.
user_kind: employee | candidate

-- Оси лимитов тарифа (`v2/35` §7.1, `v2/44` В-5, патч П-25.1 «шесть осей → одиннадцать»).
-- Десять осей тарифицируются и имеют явную колонку лимита в tenant_limits; telegram_out —
-- мягкая: канал бесплатный, ось только наблюдается и живёт в tenant_usage.axes jsonb
limit_axis: users_active | candidates_active | storage_bytes | ai_generate_ops | ai_review_ops
          | ai_interview_ops | sms_out | telegram_out | integrations_active | api_rate_rpm
          | export_rows

-- Вид операции в журнале расхода (`v2/35` §3.5, `usage_events.ref_kind`): шесть измеряемых
-- операций. Моментальные оси (люди, кандидаты, интеграции) строки расхода не создают —
-- их счётчик сходится пересчётом факта, а не суммой журнала (`v2/35` §7.1, §7.5)
usage_ref_kind: ai_generation | ai_review | ai_interview | sms | upload | export

-- Уровень предупреждения по оси (`v2/35` §3.5, §7.9; `limit_notices.level`): 80 % и 100 %
-- эффективного лимита. Третьего уровня нет — ниже 80 % запись закрывается resolved_at
limit_notice_level: warn | exceeded

-- Происхождение файла (`v2/34` §3.2, §7.1; итоговая редакция `v2/40` §4.2, решение В-6):
-- шестнадцать значений и ровно один check по колонке `media_assets.origin`. Три документа
-- пакета описывали перечень по-разному, поэтому он собран один раз и правится только
-- через `v2/40` §4 новой миграцией. Задаётся клиентом при выдаче presigned URL,
-- без него `POST /media/upload-url` отвечает 400 origin_required; `other` — «не отнесено»,
-- доля выше 5 % объёма считается дефектом классификации, а не нормой.
-- issue_screenshot — скриншот к жалобе на материал (`v2/36` §3.2, §6.1), добавлен PR-23
media_origin: content_cover | lesson_attachment | workshop_submission | video_answer | candidate_cv
            | certificate | import | checklist_photo | avatar | brand_asset | ai_artifact
            | report_export | interview_answer | person_document | issue_screenshot | other

-- Положение файла в хранилище (`v2/34` §3.1, §4): ось, отдельная от `media_assets.status`
-- (uploading | processing | ready | failed — техническая готовность объекта). Файл бывает
-- status='ready' и lifecycle='orphaned' одновременно. purged терминально: строка
-- media_assets не удаляется никогда, на неё ссылаются audit_log и workshop_submissions.files
media_lifecycle: active | orphaned | pending_delete | purged

-- Терминальное состояние воронки кандидата (`v2/28` §3.2, §4.2; `users.candidate_state`).
-- Первая из двух независимых осей (§4.1): на неё смотрят отчёты, лимиты и уведомления.
-- Вторая — колонка канбана `users.candidate_status_id` → candidate_statuses, расширяемая
-- тенантом; связывает их candidate_statuses.maps_to. hired терминален: ошибочный найм
-- исправляется офбордингом (`v2/33`), а не возвратом в воронку
candidate_state: active | hired | rejected | archived | withdrawn

-- Откуда пришёл кандидат (`v2/28` §3.2, `users.source`). Уточнение — в source_detail
candidate_source: manual | vacancy_link | job_board | referral | import | api

-- Вид оценки кандидата (`v2/28` §3.4, `candidate_scores.kind`): четыре независимых вида,
-- не сводимые в одно число — усреднение прячет «блестящее тестовое, провальное
-- собеседование», ради которого воронка и существует
candidate_score_kind: manual | task | ai | recruiter

-- Видимость комментария рекрутера (`v2/28` §3.5): самому кандидату комментарий не виден
-- ни при какой видимости — это служебная переписка о человеке, а не с человеком
candidate_comment_visibility: recruiters | managers | all_staff

-- На что жалуются (`v2/36` §3.1, `content_issues.target_type`): девять видов элементов
-- контента. Жалоба всегда адресна — «где-то в курсе» автор чинить не может
content_issue_target_type: resource | lesson | block | quiz | question | workshop | survey
                         | knowledge_article | media

-- Тип проблемы (`v2/36` §7.3) — закрытый список, он же фильтр «Тип» очереди. Построен по
-- тому, кто чинит и чем: три broken_* — три разные починки, bad_question и wrong_key —
-- единственные, что тянут пересчёт результатов, tech уходит администратору, а не автору
content_issue_type: typo | wrong_fact | outdated | unclear | broken_media | broken_link
                  | broken_file | bad_question | wrong_key | tech | other

-- Статус карточки дефекта (`v2/36` §4). Автоматического переоткрытия нет: новая жалоба
-- после closed создаёт новую карточку, и история «чинили трижды» не теряется
content_issue_status: new | in_progress | fixed | rejected | deferred | closed

-- Резолюция разбора (`v2/36` §4, §6.2): question_fixed и question_void — единственные,
-- после которых считается пересчёт результатов (`v2/36` §7.8)
content_issue_resolution: fixed | question_fixed | question_void | not_an_error | duplicate
                        | wont_fix | spam

-- Важность карточки (`v2/36` §7.4): считает система по типу проблемы и обязательности
-- урока, а не человек — иначе всё становится blocking
content_issue_severity: blocking | normal | cosmetic

-- Состояние пересчёта результатов по карточке (`v2/36` §7.8): needed попадает в очередь
-- с пометкой «впливає на бали» и не даёт закрыть карточку тихо
content_issue_rescore_state: none | needed | in_progress | done | skipped

-- Точка, из которой подана жалоба (`v2/36` §3.2, §5.1); в каталоге флажка нет —
-- там нечему быть неверным
content_report_source: lesson | attempt | workshop | catalog | knowledge | review

-- Событие журнала карточки (`v2/36` §3): created и merged пишутся при подаче,
-- остальные — при разборе
content_issue_event_kind: created | merged | status_changed | assigned | commented
                        | rescored | reopened

-- Причина отказа кандидату (`v2/28` §6.2); при other комментарий обязателен (10–500).
-- Попадает в candidate_status_history.reason_code и в отчёт «Отказы по причинам» (§9)
candidate_reject_reason: skills | experience | no_contact | conditions | vacancy_closed | other

-- Вид работы в очереди проверки (`review_queue_items.task_type`, раздел «Очередь проверки» ниже, `v2/37` §3.1,
-- решение `v2/44` В-2). Он же «Тип завдання»: колонка, фильтр и таб экрана «Черга перевірки».
-- Одна ось, а не две: В-2 называл её `source` с четырьмя значениями, `v2/37` — `task_type`
-- с пятью; значение однозначно указывает и таблицу источника (`source_id`), и подпись в
-- интерфейсе, поэтому вторая колонка не заводится
review_task_type: quiz_open_answer | workshop | offline_confirm | survey_open | ai_interview_review

-- Состояние элемента очереди проверки (`review_queue_items.status`, раздел «Очередь проверки» ниже).
-- done терминально; повторная сдача после доработки открывает ту же строку заново
-- (`enqueueReview()` через on conflict do update) — второй строки не появляется,
-- удаления не происходит
review_queue_status: waiting | in_review | done

-- Достоверность измерения времени (`review_queue_items.time_confidence`, `v2/37` §7.15):
-- partial — биения дошли не все (офлайн-досылка), unreliable — в расчёт нормы не входит
review_time_confidence: ok | partial | unreliable

-- Состояние вакансии (`vacancies.state`, `v2/29` §4). Переоткрытие закрытой выдаёт новый
-- токен: старая ссылка расходится по чатам и агрегаторам, и пришедший через полгода
-- должен видеть «вакансію закрито», а не форму на позицию с другими условиями
vacancy_state: draft | published | paused | closed | archived

-- Тип занятости и формат работы (`vacancies.employment_type`, `work_format`, `v2/29` §3.1);
-- оба снимаются с формы эталона и уходят наружу в выгрузке на площадку
vacancy_employment_type: full_time | part_time | shift | temporary | internship | contract
vacancy_work_format: on_site | hybrid | remote

-- Требуемые опыт и образование (`vacancies.experience_level`, `education_level`, `v2/29` §3.1)
vacancy_experience_level: none | under_1y | 1_3y | 3_5y | over_5y
vacancy_education_level: none | secondary | vocational | incomplete_higher | higher

-- Уровень языка (`vacancy_languages.level`, `v2/29` §3.2): шкала CEFR плюс native
vacancy_language_level: a1 | a2 | b1 | b2 | c1 | c2 | native

-- Происхождение критерия оценки кандидата (`vacancy_criteria.origin`, `v2/29` §3.3):
-- рука рекрутера, принятый человеком черновик ИИ (§7.11) или шаблон вакансии (§3.4)
vacancy_criterion_origin: manual | ai | template

-- Причина закрытия вакансии (`vacancies.close_reason`, `v2/29` §4). Перечня в `29` нет:
-- выведен из причин отказа кандидату (`v2/28` §6.2) и колонки отчёта §9.2 — свободная
-- строка в отчёте не группируется (`docs/28-implementation-notes.md` §28.17)
vacancy_close_reason: filled | no_need | budget | postponed | other

-- Состояние отклика по публичной ссылке (`vacancy_applications.state`, `v2/29` §3.9).
-- Отклик — отдельная сущность, а не сразу кандидат: подозрительный придерживается
-- (pending_review) и не занимает места в оплачиваемой оси candidates_active; merged —
-- человек уже есть в тенанте, второго профиля не будет; expired — код не введён за сутки
vacancy_application_state: pending | pending_review | accepted | merged | rejected | spam | expired

-- Исход обращения к публичной форме (`public_apply_attempts.outcome`, `v2/29` §7.4):
-- журнал нужен затем, что ответ формы одинаков при успехе и при отказе (§7.3)
public_apply_outcome: view | submit_ok | submit_blocked | otp_sent | otp_failed

-- Валюта книги операций (`points_ledger.currency`, §2.10). Снято с эталона: в назначении
-- два разных поля «Нагороди» (`15` §14.3) — «Бали за виконання завдання» идут в рейтинг,
-- «Бонуси за виконання завдання» тратятся в магазине подарков. Трата бонусов рейтинг не трогает
points_currency: points | bonuses

-- Событие книги операций (`points_ledger.event`, колонка «Подія» журнала эталона `21` §14.9):
-- «Виконання завдання», «Ручне нарахування», «Покупка» + refund — возврат при отмене заказа
-- отдельной строкой, не удалением покупки (`21` Г-21.1)
points_event: task_completed | manual | purchase | refund

-- Статус заказа в магазине (`shop_orders.status`, `21` Г-21.1 [решение]): reserved — бонусы
-- списаны и остаток уменьшен; cancelled возвращает и то, и другое строками книги
shop_order_status: reserved | ready | issued | cancelled
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

**Обратная связь по контенту** (`docs/v2/36`) реализована двумя миграциями: `0069_v2_content_issues`
(PR-23: `content_issues`, `content_reports`, `content_issue_events`, `content_reporter_stats`) и
`0077_v2_content_routing` (PR-24: `content_issue_routing_rules` — фильтр по типу элемента, типу
проблемы и категории курса → человек или роль, запасное правило одно на тенант частичным
уникальным индексом; плюс колонки `course_categories.owner_id` и `attempt_results.issue_id` выше).

**Отдельно:** `users.hired_at` уже существует и имеет тип `date`; пакет **не переопределяет**
её тип и не добавляет её заново (`docs/v2/28-recruiting-candidates.md` §3.2).
