# Lola LMS — ТЗ. 29. Вакансии, шаблоны и публикация на площадках

## 1. Назначение и границы

Вакансия — описание открытой позиции, порождающее **публичную ссылку на отбор**. Человек с улицы открывает
ссылку без авторизации, оставляет отклик и становится кандидатом (`users.kind='candidate'`,
`docs/v2/28-recruiting-candidates.md`).

**Входит:** реестр вакансий и её жизненный цикл; форма с rich-text блоками и AI-генерацией; шаблоны вакансий;
критерии оценки кандидата; публичная страница и форма отклика; защита от ботов; интеграции с job-площадками и
журнал публикаций.

**Не входит:** кандидаты, воронка и оценки как сущность — `docs/v2/28-recruiting-candidates.md`; авто-собеседование
и «3Д-резюме» — `docs/v2/30-ai-interview.md`; правила прохождения — `lola-spec/docs/15-assignments.md`; OAuth и
хранение секретов — `lola-spec/docs/09-integrations.md`; ось `ai_generate_ops` — `docs/v2/35-billing-limits.md`.

**Границы ответственности (инвариант 1).** Вакансия **не носитель правил прохождения**. Она указывает, *какой*
курс назначить откликнувшемуся и *с какими* параметрами, но параметры лежат в ней как **шаблон**, а применяются
созданием обычной `assignments`. После создания назначения правки вакансии на него не влияют (§7.12).

**Зачем это Lola.** У первого тенанта массовый найм линейного персонала при текучести, когда управляющий не
успевает обзванивать отклики. Публичная ссылка переносит первичный фильтр с человека на систему.

---

## 2. Роли и скоупы

Новые скоупы: `vacancy.view`, `vacancy.edit`, `vacancy.publish`, `vacancy.close`, `vacancy.template.manage`,
`vacancy.criteria.manage`, `vacancy.ai.use`, `jobboard.connect`, `jobboard.publish`.

| Действие | Рекрутер | Керівник точки | HR | Админ | Оператор платформы |
|---|---|---|---|---|---|
| Видеть список вакансий | ✓ свои + своих точек | ✓ своей точки | ✓ | ✓ | — |
| Создавать и править вакансию | ✓ свои | — | ✓ | ✓ | — |
| Публиковать (выдать публичную ссылку) | ✓ | — | ✓ | ✓ | — |
| Приостановить / закрыть | ✓ свои | — | ✓ | ✓ | — |
| Архивировать | — | — | ✓ | ✓ | — |
| Править критерии оценки | ✓ свои | — | ✓ | ✓ | — |
| Пользоваться «Створити з AI» | ✓ | — | ✓ | ✓ | — |
| Создавать и править шаблоны | — | — | ✓ | ✓ | — |
| Подключить компанейский аккаунт площадки | — | — | — | ✓ | — |
| Подключить свой личный аккаунт | ✓ | ✓ | ✓ | ✓ | — |
| Публиковать на площадке | ✓ доступными аккаунтами | — | ✓ | ✓ | — |
| Видеть отклики и очередь модерации | ✓ своих вакансий | — | ✓ | ✓ | — |

[решение] Керівник точки не создаёт вакансии: вакансия порождает публичную страницу от имени компании и уходит
на внешние площадки — это действие уровня бренда, не точки. [решение] Оператор платформы доступа к вакансиям и
откликам не имеет: публичная страница собирает ПД людей, с которыми оператор не в отношениях (зеркало `docs/28`
§2).

---

## 3. Сущности и поля

Во всех таблицах `tenant_id` обязателен, RLS `enable` + `force`, политика с `using` и `with check`, доступ через
`withTenant(...)`.

### 3.1 `vacancies`

```sql
create table vacancies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null, state text not null default 'draft',
  category_id uuid references course_categories(id), recruiter_id uuid references users(id),
  course_id uuid references courses(id), course_version_id uuid references course_versions(id),
  location_id uuid references locations(id), org_unit_id uuid references org_units(id),
  position_id uuid references positions(id),
  description_html text, requirements_html text, duties_html text, extra_html text,
  ai_blocks jsonb not null default '{}'::jsonb,
  employment_type text, work_format text, country_code char(2), city text,
  experience_level text, education_level text,
  salary_from numeric(12,2), salary_to numeric(12,2), salary_currency char(3) not null default 'UAH',
  salary_visible boolean not null default false,
  assignment_template jsonb not null default '{}'::jsonb,
  public_token text, public_enabled boolean not null default false,
  public_apply_otp boolean not null default true, apply_daily_cap int not null default 200,
  source_budget numeric(12,2), template_id uuid references vacancy_templates(id) on delete set null,
  published_at timestamptz, closed_at timestamptz, close_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint vacancies_state_chk check (state in ('draft','published','paused','closed','archived')),
  constraint vacancies_employment_chk check (employment_type is null or employment_type in
    ('full_time','part_time','shift','temporary','internship','contract')),
  constraint vacancies_format_chk check (work_format is null or work_format in ('on_site','hybrid','remote')),
  constraint vacancies_experience_chk check (experience_level is null or experience_level in
    ('none','under_1y','1_3y','3_5y','over_5y')),
  constraint vacancies_education_chk check (education_level is null or education_level in
    ('none','secondary','vocational','incomplete_higher','higher')),
  constraint vacancies_salary_chk check (salary_from is null or salary_to is null or salary_from <= salary_to),
  constraint vacancies_title_chk check (length(title) between 3 and 200),
  constraint vacancies_cap_chk check (apply_daily_cap between 10 and 5000),
  constraint vacancies_public_chk check (not public_enabled or
    (course_id is not null and location_id is not null and public_token is not null)),
  unique (tenant_id, public_token)
);
create index idx_vacancies_tenant on vacancies (tenant_id, state, updated_at desc);
create index idx_vacancies_tenant_location on vacancies (tenant_id, location_id);
create index idx_vacancies_tenant_recruiter on vacancies (tenant_id, recruiter_id);
create unique index uq_vacancies_public_token on vacancies (public_token) where public_token is not null;
```

| Поле | Тип | Обяз. | По умолчанию | Валидация | Комментарий |
|---|---|---|---|---|---|
| `recruiter_id` | uuid | для публикации | текущий пользователь | скоуп `vacancy.edit` | попадает в `users.recruiter_id` откликнувшегося |
| `course_id` | uuid | для публикации | — | опубликованный курс | «Рекрутинговий курс»: что назначается откликнувшемуся |
| `course_version_id` | uuid | нет | текущая на момент публикации | FK | правка курса не меняет отбор на лету |
| `location_id` | uuid | для публикации | — | доступная пользователю | «Точка» |
| `position_id` | uuid | нет | — | FK `positions` | используется при найме (`docs/28` §5.5) |
| `*_html` | text | нет | — | ≤20000 после санитайза | четыре rich-text блока |
| `salary_visible` | boolean | да | `false` | — | скрывает вилку на публичной странице и в выгрузке на площадку |
| `assignment_template` | jsonb | да | `{}` | §3.5 | шаблон параметров назначения, не правила |
| `public_token` | text | нет | — | 22 знака base62, криптослучайный | часть публичного URL |
| `apply_daily_cap` | int | да | `200` | 10–5000 | суточный потолок откликов по вакансии |
| `source_budget` | numeric | нет | — | ≥0 | бюджет продвижения, питает отчёт «Джерела» (`docs/28` §9.3) |

[решение] Правило эталона «без курса и точки ссылка не создаётся» вынесено в **констрейнт БД**, а не только в
форму: ссылка без назначения — это отклик, который некуда девать. Порядок миграции: `vacancy_templates` (§3.4)
создаётся раньше `vacancies` — на неё ссылается `template_id`.

> [исправлено, PR-16: §7.20 требует язык страницы, а колонки под него в §3.1 не было]
> Ранее перечень колонок заканчивался на `created_by`. Добавлена `public_language text`
> (`null` — язык пространства, констрейнт `vacancies_public_language_chk` на `uk | en | ru`,
> миграция `0074_v2_vacancy_apply`). Без неё §7.20 неисполним: «`comm_language` = язык
> публичной страницы» не на что сослаться, а язык администратора, открывшего форму вакансии,
> к посетителю отношения не имеет.

> [исправлено, PR-15: реализация добавила перечень причин закрытия и уникальность токена]
> Ранее `close_reason` был свободным текстом без констрейнта. Свободная строка не группируется
> в отчёте §9.2, поэтому заведён `vacancies_close_reason_chk` с пятью значениями
> (`filled` · `no_need` · `budget` · `postponed` · `other`, перечисление `vacancy_close_reason`
> в `docs/02`), а пояснение при `other` уходит в `audit_log` перехода, не в колонку.
> Токен уникален **глобально** (`uq_vacancies_public_token`), а не только внутри тенанта:
> публичная страница приходит без сессии, и тенант выводится из самого токена (§10, П-04) —
> два тенанта с одним токеном сделали бы этот вывод неоднозначным.

### 3.2 `vacancy_languages`

```sql
create table vacancy_languages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vacancy_id uuid not null references vacancies(id) on delete cascade,
  lang_code text not null, level text not null,
  is_required boolean not null default true, sort int not null default 0,
  constraint vacancy_languages_level_chk check (level in ('a1','a2','b1','b2','c1','c2','native')),
  unique (tenant_id, vacancy_id, lang_code));
create index idx_vacancy_languages_tenant on vacancy_languages (tenant_id, vacancy_id, sort);
```

`lang_code` — из языков тенанта (`docs/v2/32-org-structure.md`); шкала CEFR плюс `native`.

### 3.3 `vacancy_criteria`, `vacancy_criterion_scores` — критерии оценки кандидата

```sql
create table vacancy_criteria (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vacancy_id uuid not null references vacancies(id) on delete cascade,
  name text not null, description text, weight numeric(5,2) not null default 1,
  scale_min numeric(6,2) not null default 0, scale_max numeric(6,2) not null default 5,
  is_critical boolean not null default false, origin text not null default 'manual',
  sort int not null default 0, is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint vacancy_criteria_origin_chk check (origin in ('manual','ai','template')),
  constraint vacancy_criteria_weight_chk check (weight > 0 and weight <= 100),
  constraint vacancy_criteria_scale_chk check (scale_max > scale_min),
  constraint vacancy_criteria_name_chk check (length(name) between 2 and 120));
create index idx_vacancy_criteria_tenant on vacancy_criteria (tenant_id, vacancy_id, sort);

create table vacancy_criterion_scores (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid not null references users(id) on delete cascade,
  criterion_id uuid not null references vacancy_criteria(id) on delete cascade,
  value_num numeric(6,2) not null, comment text,
  author_id uuid not null references users(id), created_at timestamptz not null default now(),
  unique (tenant_id, candidate_id, criterion_id, author_id));
create index idx_vacancy_criterion_scores_tenant on vacancy_criterion_scores (tenant_id, candidate_id);
```

[решение] Критерии — **рамка человеческого решения, а не правило прохождения**: ничего не блокируют и не влияют
на `enrollments`/`attempts`. Единственный выход — свёртка в одну строку `candidate_scores` с `kind='recruiter'`
(`docs/28` §3.4): каждый балл нормируется к 0–10 как `(value − scale_min)/(scale_max − scale_min) × 10`, итог —
`Σ(норм × weight)/Σ(weight)`, округление до 0.01, `source_type='vacancy_criteria'`, `source_id = vacancy_id`,
`comment` = «Оцінено за N критеріями». Пересчёт при каждом изменении, новая строка снимает `is_current` с
предыдущей.

[решение] `is_critical` не запрещает найм: минимальный балл даёт лишь предупреждение «Критичний критерій
«<назва>» оцінено мінімальним балом». Жёсткий стоп-фактор был бы автоматизированным решением по человеку,
запрещённым `docs/28` §7.4.

### 3.4 `vacancy_templates`

```sql
create table vacancy_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null, description text, payload jsonb not null,
  criteria jsonb not null default '[]'::jsonb, languages jsonb not null default '[]'::jsonb,
  usage_count int not null default 0, is_active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint vacancy_templates_name_chk check (length(name) between 3 and 120),
  unique (tenant_id, name));
create index idx_vacancy_templates_tenant on vacancy_templates (tenant_id, is_active, name);
```

`payload` — снимок полей вакансии **кроме** `location_id`, `recruiter_id`, `public_token`, `published_at`,
`state` и статистики; `criteria` и `languages` вложены, чтобы применение шло одной транзакцией. [решение] Шаблон
— **самостоятельная сущность, а не вакансия-черновик**: иначе шаблоны попадут в реестр вакансий, в отчёты
воронки и получат публичные ссылки.

### 3.5 `assignment_template` — шаблон параметров назначения

```jsonc
{ "subject_type": "course", "due_mode": "relative", "due_days": 3, "is_mandatory": true,
  "params": { "attempts": 2, "pass_score": 70, "time_limit_min": 30, "shuffle": true },
  "reminders": { "enabled": true, "before_days": [1], "channels": ["telegram"] },
  "notify_on_assign": true }
```

Ключи — подмножество полей `assignments` (`lola-spec/docs/15-assignments.md` §3.1, 3.3, 3.4), неизвестные
отбрасываются zod-схемой.

> [исправлено, PR-15: имена ключей — те же, что у назначения в репозитории; абсолютного срока нет]
> Ранее пример показывал `attempts`, `pass_score`, `time_limit_min`. Фактические имена приходят
> **из одной схемы** `shared/schemas/assignments.ts` (`attemptsAllowed`, `passScore`,
> `timeLimitSec`, `dueMode`/`dueDays`): второго перечня ключей прохождения в продукте нет и не
> заводится — это и есть инвариант 1 в коде. `dueMode` в шаблоне принимает только `none` и
> `relative`: вакансия живёт месяцами, и зафиксированное в ней «до 3 березня» тихо протухает,
> выдавая откликнувшемуся просроченное назначение в момент создания. При отклике создаётся обычная `assignments`: `kind='manual'`, `subject_id =
vacancies.course_id`, `subject_version_id = course_version_id`, `audience = {"rules":[{"type":"user","ids":["<id
кандидата>"]}],"match":"any"}`, `auto_sync=false`, `tags=['vacancy:<id>']`.

### 3.6 `ai_blocks` — маркировка сгенерированного текста

```jsonc
{ "requirements_html": { "generated_at": "2026-09-20T10:11:00Z", "generated_by": "<user_id>",
  "model": "<код>", "prompt_hash": "sha256:…", "edited_at": null,
  "chars_at_generation": 812, "acknowledged": false } }
```

`edited_at` — первая правка человеком, `acknowledged` — нажатие «Текст перевірено». Публикация запрещена, пока
есть блок без обоих (§7.9).

### 3.7 `job_board_accounts` — аккаунты внешних площадок

```sql
create table job_board_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null, owner_type text not null,
  owner_user_id uuid references users(id) on delete cascade,
  label text, status text not null default 'not_connected',
  secret_ref uuid references tenant_secrets(id), scopes text[] not null default '{}',
  last_ok_at timestamptz, last_error text,
  connected_by uuid references users(id), connected_at timestamptz,
  created_at timestamptz not null default now(),
  constraint job_board_accounts_provider_chk check (provider in ('work_ua','robota_ua','telegram')),
  constraint job_board_accounts_owner_chk check (owner_type in ('company','personal','recruiter')),
  constraint job_board_accounts_coherence_chk check ((owner_type = 'company' and owner_user_id is null)
    or (owner_type <> 'company' and owner_user_id is not null)),
  constraint job_board_accounts_status_chk check (status in
    ('not_connected','connecting','active','failing','revoked','disabled')));
create unique index uq_job_board_accounts_owner on job_board_accounts
  (tenant_id, provider, owner_type, coalesce(owner_user_id,'00000000-0000-0000-0000-000000000000'::uuid));
create index idx_job_board_accounts_tenant on job_board_accounts (tenant_id, provider, status);
```

Токены здесь не лежат: `secret_ref` → `tenant_secrets` (`lola-spec/docs/09-integrations.md` §9.4), значение
зашифровано AES-GCM и наружу не отдаётся. Статусы — из §9.3 базового ТЗ.

[решение] **Зачем три уровня владения.** `company` — корпоративный кабинет, подключает админ; публикации
переживают увольнение любого сотрудника. `personal` — кабинет текущего пользователя, у которого свой оплаченный
доступ и нежелание отдавать пароль компании. `recruiter` — кабинет конкретного рекрутера, заведённый HR: так
устроена реальная закупка, где у каждого рекрутера свой пакет объявлений и своя квота. Схлопнуть нельзя: при
увольнении компанейские публикации обязаны выжить, а личные — отвалиться, и система должна знать, какие какие.
Технически `personal` и `recruiter` — одна строка с `owner_user_id`; различает их то, кто ею распоряжается
(§7.14).

### 3.8 `vacancy_publications` — журнал публикаций

> [исправлено, PR-17: `44` §8 предписывает обходной путь «рекрутер публикує вручну, без
> площадки» — состоянию нужно имя] Ранее `state_chk` заканчивался на `conflict`. Добавлено
> восьмое значение `manual`: строка публикации без вызова адаптера — рекрутер сам разместил
> об'яву на площадці і вставив готове посилання. Индекс `uq_vacancy_publications_active`
> тоже включает `manual` — вторая ручная запись того же аккаунта тоже `409 publication.duplicate`.

```sql
create table vacancy_publications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vacancy_id uuid not null references vacancies(id) on delete cascade,
  account_id uuid not null references job_board_accounts(id) on delete restrict,
  state text not null default 'queued',
  external_id text, external_url text, payload_hash text,
  published_at timestamptz, expires_at timestamptz, removed_at timestamptz,
  attempts int not null default 0, last_error_code text, last_error text,
  requested_by uuid not null references users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint vacancy_publications_state_chk check (state in
    ('queued','publishing','active','failed','removed','expired','conflict','manual')));
create unique index uq_vacancy_publications_active on vacancy_publications
  (tenant_id, vacancy_id, account_id) where state in ('queued','publishing','active','conflict','manual');
create index idx_vacancy_publications_tenant on vacancy_publications (tenant_id, vacancy_id, state);
```

### 3.9 `vacancy_applications`, `public_apply_attempts` — отклики и попытки

```sql
create table vacancy_applications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vacancy_id uuid not null references vacancies(id) on delete cascade,
  state text not null default 'pending',
  full_name text not null, phone text, email text, comment text,
  resume_asset_id uuid references media_assets(id),
  source text not null default 'vacancy_link', source_detail text, utm jsonb not null default '{}'::jsonb,
  consent_given_at timestamptz not null, consent_text_version text not null,
  candidate_id uuid references users(id) on delete set null,
  spam_score int not null default 0, spam_reasons text[] not null default '{}',
  ip_hash text not null, user_agent_hash text, form_nonce text not null, fill_seconds int,
  otp_confirmed_at timestamptz,
  reviewed_by uuid references users(id), reviewed_at timestamptz, reject_reason text,
  created_at timestamptz not null default now(),
  constraint vacancy_applications_state_chk check (state in
    ('pending','pending_review','accepted','merged','rejected','spam','expired')),
  constraint vacancy_applications_contact_chk check (phone is not null or email is not null),
  constraint vacancy_applications_name_chk check (length(full_name) between 2 and 120));
create index idx_vacancy_applications_tenant on vacancy_applications (tenant_id, vacancy_id, state, created_at desc);
create index idx_vacancy_applications_ip on vacancy_applications (tenant_id, ip_hash, created_at desc);

create table public_apply_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vacancy_id uuid references vacancies(id) on delete cascade,
  ip_hash text not null, outcome text not null, reason text,
  created_at timestamptz not null default now(),
  constraint public_apply_attempts_outcome_chk check (outcome in
    ('view','submit_ok','submit_blocked','otp_sent','otp_failed')));
create index idx_public_apply_attempts_tenant on public_apply_attempts (tenant_id, ip_hash, created_at desc);
create index idx_public_apply_attempts_vacancy on public_apply_attempts (tenant_id, vacancy_id, created_at desc);
```

[решение] Отклик — **отдельная сущность, а не сразу кандидат**: подозрительный отклик надо уметь придержать, не
засоряя воронку и не занимая место в лимите `candidates_active`; повторный отклик того же человека — событие в
истории существующего кандидата (`docs/28` §12.10), а не второй профиль; сырые данные из публичного интернета не
попадают в `users` без единой точки проверки. `ip_hash` — HMAC-SHA256 от IP с посолью тенанта, сырой IP не
хранится.

### 3.10 `vacancy_ai_generations` — журнал AI-генераций

```sql
create table vacancy_ai_generations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vacancy_id uuid references vacancies(id) on delete cascade,
  target text not null, input jsonb not null, output_chars int, model text,
  ops_charged int not null default 1, status text not null default 'ok', error_code text,
  author_id uuid not null references users(id), created_at timestamptz not null default now(),
  constraint vacancy_ai_generations_target_chk check (target in
    ('description','requirements','duties','extra','criteria')),
  constraint vacancy_ai_generations_status_chk check (status in ('ok','failed','limited')));
create index idx_vacancy_ai_generations_tenant on vacancy_ai_generations (tenant_id, created_at desc);
```

### 3.11 Что НЕ заводим

Правила прохождения вакансии (они в `assignments`, инвариант 1); таблицу кандидатов (`users.kind`, `docs/28`
§3.1); оценки вакансии (`candidate_scores` с `kind='recruiter'`, `docs/28` §3.4); историю состояний вакансии —
переходы пишутся в `audit_log`.

---

## 4. Состояния и переходы

```
draft ──publish──→ published ⇄ paused        closed ──reopen──→ published
published/paused ──close──→ closed ──archive──→ archived ──restore──→ draft
draft ──archive──→ archived
```

| Из | В | Кто | Условие | Последствие |
|---|---|---|---|---|
| `draft` | `published` | `vacancy.publish` | заданы `course_id`, `location_id`, `recruiter_id`, `title`; AI-блоки подтверждены (§7.9) | выдаётся `public_token`, `public_enabled=true`, фиксируется `course_version_id` |
| `published` | `paused` | `vacancy.edit` | — | страница отдаёт 410 «Набір тимчасово призупинено»; внешние публикации **не снимаются** |
| `paused` | `published` | `vacancy.edit` | условия публикации выполнены | тот же токен, страница снова доступна |
| `published`/`paused` | `closed` | `vacancy.close` | указана причина | страница 410; публикации в очередь на снятие; кандидаты — `docs/28` §12.3 |
| `closed` | `published` | `vacancy.publish` | ≤90 дней после `closed_at` | **новый** токен, старая ссылка мертва |
| `closed` | `archived` | HR, админ | нет откликов `pending`/`pending_review` | уходит из реестра во вкладку «Архів» |
| `draft` | `archived` | HR, админ | — | — |
| `archived` | `draft` | админ | — | токен не восстанавливается |

[решение] Переоткрытие выдаёт новый токен: старая ссылка расходится по чатам и агрегаторам, и человек, пришедший
через полгода, должен видеть «Вакансію закрито», а не форму на позицию, переоткрытую с другими условиями.
[решение] Приостановка **не снимает** объявления с площадок — снятие и повторная постановка стоят денег и теряют
позицию в выдаче; вместо этого 410 с кнопкой «Повідомити, коли відкриється». Снятие делает только закрытие.
Согласовано с `docs/28` §12.3: закрытие **не прерывает** прохождение, рекрутер получает
`vacancy.closed_with_candidates` и решает по каждому.

---

## 5. Экраны

Раздел `/vacancies` — три вкладки: «Вакансії» · «Шаблони» · «Інтеграції».

**5.1 Список — `/vacancies`.** Колонки: Назва · Точка · Рекрутинговий курс · Рекрутер · Відгуки (всього / нових)
· Кандидати в роботі · Публікації (иконки площадок со статусом) · Створено · Статус · «⋮». Фильтры: статус (по
умолчанию `published` + `paused`), точка, подразделение, рекрутер, категория, курс, период создания; поиск по
названию. Кнопка «+ Створити вакансію» → меню «Нова вакансія» / «Обрати шаблон». «⋮»: «Редагувати», «Копіювати
посилання», «Зберегти як шаблон», «Опублікувати на майданчику», «Призупинити», «Закрити», «Архівувати». Пустое:
«Немає відкритих вакансій» + «+ Створити вакансію»; загрузка — скелет из 6 строк; ошибка — «Не вдалося
завантажити вакансії» + «Оновити». Рекрутер видит свои и вакансии своих точек; керівник точки — свою точку без
кнопок создания и публикации; HR и админ — все.

**5.2 Форма — `/vacancies/new`, `/vacancies/:id/edit`.** Полноэкранная, sticky-шапка: бейдж состояния,
«Зберегти», «Опублікувати», «⋮ → Зберегти шаблон». Блоки: основное; четыре rich-text блока, у каждого «Створити
з AI»; условия работы; опыт и образование; зарплата; языки; критерии оценки; параметры назначения; параметры
публикации. «Параметри публікації» — карточки подключённых аккаунтов с чекбоксами, при их отсутствии «Немає
підключених інтеграцій» со ссылкой на вкладку «Інтеграції». Ниже публичная ссылка: до публикации коралловая
плашка «Оберіть курс і точку, щоб створити посилання на автоматичний відбір», после — ссылка с кнопками
«Копіювати», «QR-код», «Оновити посилання».

**5.3 Шаблоны — `/vacancies/templates`.** Назва · Опис · Використано разів · Оновлено · «⋮» («Редагувати»,
«Створити вакансію з шаблону», «Дублювати», «Деактивувати»). Пустое: «Немає готових шаблонів» + «Створити
шаблон».

**5.4 Интеграции — `/vacancies/integrations`.** Строка «Пошук за рекрутером». Карточки площадок сгруппированы по
владельцу: группа компании (заголовок — название тенанта), «Персональний» (аккаунт текущего пользователя), затем
группа на каждого рекрутера. Карточка: логотип, название, ссылка на сервис, статус по `docs/09` §9.3, кнопка
«Підключити» / «Відключити» / «Спробувати ще раз». Чужие личные аккаунты видны только HR и админу и всегда без
кнопки «Підключити» (§7.14).

**5.5 Отклики — `/vacancies/:id/applications`.** Вкладки «Нові» · «На модерації» · «Прийняті» · «Спам» ·
«Відхилені». Колонки: Ім'я · Контакт · Джерело · Отримано · Резюме · Ознаки (чипы из `spam_reasons`) · Дії
(«Прийняти», «Відхилити», «Позначити спамом»). Пустое: «Відгуків ще немає. Поділіться посиланням на вакансію.» +
кнопка копирования.

**5.6 Публичная страница — `/j/:public_token`.** Без авторизации и без меню приложения. Состав: логотип и
название компании (брендинг, `docs/32`), название вакансии, город и формат, тип занятости, опыт, образование,
вилка **только при `salary_visible`**, языки с уровнями, четыре текстовых блока, кнопка «Відгукнутися», форма
отклика, ссылка «Як ми обробляємо ваші дані». **Никогда не показывается:** внутренняя категория, курс и его
название, рекрутер и его контакты, точка и подразделение во внутренних терминах (только город), критерии оценки,
параметры назначения, число откликов, бюджет, данные других кандидатов. Состояния: `published` — форма; `paused`
— 410 «Набір тимчасово призупинено» + «Повідомити, коли відкриється»; `closed`, `archived` и неизвестный токен —
единый 404 «Вакансію не знайдено або її вже закрито»; превышен потолок — 429 «Забагато відгуків сьогодні.
Спробуйте, будь ласка, завтра.». SSR, кеш 60 секунд, CSP без сторонних скриптов, индексация разрешена.

---

## 6. Формы

### 6.1 Форма вакансии

| Поле | Контрол | Обяз. | Подсказка | Валидация | Текст ошибки (uk) |
|---|---|---|---|---|---|
| Рекрутер | селект | для публикации | — | скоуп `vacancy.edit` | «Оберіть рекрутера» |
| Назва вакансії | текст | да | — | 3–200 | «Вкажіть назву вакансії» |
| Категорія | селект | нет | — | `course_categories` | — |
| Рекрутинговий курс | селект с поиском | для публикации | «Цей курс буде призначено кандидату одразу після відгуку» | опубликованный курс | «Оберіть курс, який проходитиме кандидат» |
| Точка | селект | для публикации | — | доступная пользователю | «Оберіть точку» |
| Підрозділ / Посада | селект | нет | «Посада використовується під час найму» | FK | — |
| Опис · Вимоги · Обов'язки · Додаткова інформація | rich-text + «Створити з AI» | нет | — | ≤20000 после санитайза | «Текст задовгий: максимум 20000 символів» |
| Тип зайнятості / Формат | селект | нет | — | 6 / 3 значения | — |
| Країна / Місто | селект / текст | нет | — | ISO-3166-1 alpha-2 / 2–80 | — |
| Досвід роботи / Освіта | селект | нет | — | 5 / 5 значений | — |
| Зарплата від / до | число | нет | — | ≥0, `від ≤ до` | «Нижня межа більша за верхню» |
| Валюта | селект | да | `UAH` | ISO-4217 | — |
| Показувати кандидатам | чекбокс | да | «Вилку зарплати буде видно на публічній сторінці» | — | — |
| Іноземні мови | список «+ Додати мову» | нет | — | язык уникален | «Цю мову вже додано» |
| Критерії оцінки | список + «Додати» + «Згенерувати критерії (AI)» | нет | «Критерії допомагають рекрутеру, але нічого не блокують» | Σ весов > 0 | — |
| Параметри призначення | подформа | да | «Ці параметри буде скопійовано у призначення кандидата» | §3.5 | «Прохідний бал має бути від 1 до 100» |
| Майданчики для публікації | чекбоксы аккаунтов | нет | — | статус `active` | «Акаунт майданчика не підключено» |

**6.2 Форма критерия.** «Назва критерію» (обяз., 2–120, «Вкажіть назву критерію») · «Опис» (≤500) · «Вага»
(обяз., 0.01–100, по умолчанию 1, «Вага має бути більшою за нуль») · «Шкала від / до» (обяз., `до > від`, по
умолчанию 0/5, «Верхня межа шкали має бути більшою») · «Критичний» (чекбокс).

### 6.3 Публичная форма отклика — `/j/:public_token`

| Поле | Контрол | Обяз. | Подсказка | Валидация | Текст ошибки (uk) |
|---|---|---|---|---|---|
| Ім'я та прізвище | текст | да | — | 2–120, минимум 2 слова | «Вкажіть ім'я та прізвище» |
| Телефон | телефон, по умолчанию +380 | да* | «Ми надішлемо код підтвердження» | E.164 | «Перевірте номер телефону» |
| Email | email | да* | — | RFC 5322 | «Перевірте адресу пошти» |
| Резюме | загрузка файла | нет | «PDF, DOC, DOCX або зображення, до 10 МБ» | тип и размер | «Формат не підтримується» |
| Коментар | текстовая область | нет | «Кілька слів про себе — необов'язково» | ≤1000 | «Коментар задовгий» |
| Згода на обробку персональних даних | чекбокс со ссылкой на текст | **да** | «Я даю згоду на обробку моїх персональних даних для участі у відборі» | `true` | «Без згоди на обробку даних відгук надіслати не можна» |
| `website` | скрытое поле (honeypot) | — | — | должно остаться пустым | — |
| `form_nonce` | скрытое поле | — | — | подпись сервера, TTL 4 с – 60 мин | «Форма застаріла. Оновіть сторінку.» |

> [исправлено, PR-16: загрузка резюме отнесена к следующему PR]
> Поле «Резюме» в публичной форме пока не отображается. Загрузка файла из контура без
> сессии — это анонимная запись в хранилище тенанта, ограниченная только частотным
> правилом: ставить её **до** подтверждения контакта нельзя, а после подтверждения человек
> уже кандидат и приносит резюме обычным путём, через единственный вход загрузки
> (`docs/v2/34` §7.1, решение В-17). Колонка `vacancy_applications.resume_asset_id` заведена,
> уборка файла у истёкшего отклика (критерий §13 к. 6) реализована — приём файла приедет
> с PR-17 вместе с площадками, где анонимная загрузка решается один раз для всего контура.

\* Телефон **или** e-mail обязателен, но не оба (`docs/28` §6.1); при `public_apply_otp=true` обязателен тот
канал, на который уйдёт код. После отправки: «Дякуємо! Ми надіслали вам код підтвердження на <канал>.» → ввод 6
цифр → «Ваш відгук прийнято. На <канал> надійшло посилання для проходження відбору.» При выключенном OTP — сразу
второй текст.

**6.4 Закрытие вакансии.** Причина (селект, обяз.): «Позицію закрито» · «Кандидата знайдено» · «Позицію
скасовано» · «Дублікат» · «Інше» (текст 10–500). Чекбоксы: «Зняти оголошення з майданчиків» (включён),
«Повідомити кандидатів у роботі» (выключен). При наличии кандидатов: «N кандидатів зараз проходять відбір. Їхнє
проходження не буде перервано.»

---

## 7. Правила и алгоритмы

1. **Публичная ссылка не существует без курса и точки.** `public_enabled=true` допустим только при заполненных
   `course_id` и `location_id`: констрейнт `vacancies_public_chk` и `422 vacancy.link_requirements` — «Оберіть
   курс і точку, щоб створити посилання на автоматичний відбір».
2. **Токен.** 22 знака base62 из криптоисточника (≈132 бита). Несуществующий, закрытый и архивный токены дают
   идентичный 404 с идентичным временем ответа (выравнивание задержкой 120 мс ± 20 мс), поэтому перебор не даёт
   информации.
3. **Приём отклика — одна транзакция.** Проверки по порядку: состояние вакансии → суточный потолок → частота по
   IP (п. 4) → `form_nonce` → honeypot → согласие → наличие контакта → лимит `candidates_active` (`docs/35`).
   При провале любой проверки, кроме первой, ответ один и тот же: `202` с текстом благодарности — форма
   **никогда** не сообщает боту, какая проверка сработала. Внутри растёт `spam_score`, отклик уходит в
   `pending_review` или `spam`.
4. **Ограничение частоты по IP (вместо внешней капчи).** Не более **3** успешных откликов с одного `ip_hash` за
   час на тенант; **10** за 24 часа; **1** на одну вакансию за 24 часа; **30** просмотров публичной страницы за
   10 минут (дальше 429 с `Retry-After: 600`). Каждое превышение — строка `public_apply_attempts` с
   `outcome='submit_blocked'` и причиной.
5. **Подтверждение контакта кодом — главная мера.** При `public_apply_otp=true` отклик становится кандидатом
   только после ввода 6-значного кода на указанный телефон или почту: TTL 10 минут, 5 попыток ввода, не более 3
   отправок на контакт за час (`otp_codes` базового ТЗ). Неподтверждённые отклики через 24 часа → `expired`,
   лимит кандидатов не занимают. [решение] Это заменяет капчу внешнего вендора: подтверждение владения контактом
   дороже для бота, чем распознавание картинки, и полезно бизнесу — рекрутер получает проверенный номер. Внешние
   капчи отвергнуты ещё и потому, что это передача поведения посетителей третьей стороне на странице, где
   собираются ПД.
6. **Honeypot и время заполнения.** Поле `website` есть в DOM, скрыто CSS (`position:absolute;left:-9999px`),
   `tabindex="-1"`, `autocomplete="off"`; заполнено → `+60` к `spam_score`. `form_nonce` подписан сервером и
   несёт время выдачи: отправка раньше **4 секунд** → `+40`; позже 60 минут → отказ с просьбой обновить
   страницу; повтор nonce → `+100` и отказ.
7. **Модерация подозрительных.** `spam_score` 50–99 → `pending_review`, вкладка «На модерації», in-app
   рекрутеру; кандидат не создаётся, лимит не тратится. `≥100` → `spam` без уведомления. Слагаемые: honeypot 60;
   быстрая отправка 40; повтор nonce 100; ссылки в «Коментар» 30; имя из одних латинских согласных 20; `ip_hash`
   ранее помечен спамом 50; контакт в чёрном списке тенанта 100.
> [исправлено, PR-16: §7.7 и критерий §13 к. 3 расходились в арифметике]
> Ранее п. 7 читался как «в `pending_review` уходит отклик со `spam_score` 50–99», но
> критерий приёмки 3 требует `pending_review` при быстрой отправке, которая стоит 40 —
> ниже порога, и выполнить оба правила буквально нельзя. Реализация разводит их так:
> **порог решает, показывать ли отклик рекрутеру или отсеять молча**, а к человеку отклик
> уводит **любая сработавшая причина**. То есть: ≥100 — `spam`; иначе хотя бы одна причина
> (включая частотное ограничение §7.4) — `pending_review`; ни одной — обычный путь.
> Так ни одна сработавшая проверка не теряется молча, чего п. 7 и добивается.
>
> Там же: слагаемое «контакт в чёрном списке тенанта» (100) не реализовано — ни таблицы,
> ни экрана чёрного списка в продукте нет, и заводить сущность мимо ТЗ ради одного
> слагаемого нельзя (CLAUDE.md «не выдумывать поля»). Остальные шесть слагаемых на месте.

8. **Всплеск.** Более 20 заблокированных попыток по вакансии за час: лимиты п. 4 для неё ужесточаются вдвое на 6
   часов, уходит `vacancy.spam_burst`. Кнопка «Оновити посилання» даёт новый токен, старый умирает немедленно.
9. **Публикация запрещена с непроверенным AI-текстом.** Есть блок без `edited_at` и без `acknowledged` → `409
   vacancy.ai_text_unreviewed`, «Перевірте згенерований текст перед публікацією: <перелік блоків>». Человек либо
   правит блок, либо нажимает «Текст перевірено» — второе пишется в `audit_log` с его id.
10. **AI-генерация текста.** Вход модели: название вакансии, должность, категория, город, тип занятости, формат,
    опыт, образование, уже заполненные соседние блоки, тон компании из настроек тенанта (`docs/32`), язык
    страницы. **Не передаются:** вилка зарплаты, контакты, данные кандидатов, название курса, критерии оценки.
    Ответ ≤2500 знаков на блок. Одна генерация = **1 операция оси `ai_generate_ops`** (`docs/35` §7.1),
    списывается в той же транзакции; при исчерпании кнопка отключается: «Ліміт ШІ-операцій вичерпано.
    Залишилось: 0.» Повтор того же блока — новая операция; `status='failed'` операцию не списывает.
11. **Генерация критериев (AI).** Вход — те же поля плюс «Вимоги» и «Обов'язки». Выход — 3–8 критериев с
    названием, описанием и предложенным весом, `origin='ai'`, в **черновик**: до нажатия «Зберегти критерії» ни
    одна строка в `vacancy_criteria` не появляется. Стоимость — 1 `ai_generate_ops`.
12. **Правка вакансии не трогает созданные назначения.** Изменение `assignment_template`, `course_id` или
    `course_version_id` действует только на отклики после сохранения. Форма пишет: «Зміни вплинуть лише на нові
    відгуки. Кандидатів у роботі: N.» Инвариант 1 нарушается ровно там, где правка вакансии начинает менять
    чужие назначения, — такого пути нет ни в UI, ни в API.
13. **Публикация на площадке — подтверждаемое действие.** Модальное окно «Опублікувати вакансію на <майданчик>
    від імені <власник акаунта>?» со списком уходящих наружу полей и явным указанием, видна ли вилка; кнопка
    названа действием («Опублікувати»), не «OK». Запрос с `Idempotency-Key`. Результат — строка
    `vacancy_publications` и запись в `audit_log` с кодом `vacancy.published_external`, `account_id`,
    `provider`, `payload_hash`, `request_context`. Снятие журналируется как `vacancy.unpublished_external`.
14. **Кто чем распоряжается.** `company` — создаёт и отключает только админ, публикует любой со скоупом
    `jobboard.publish`. `personal` — создаёт, видит статус и отключает только владелец; HR и админ видят факт
    подключения и метку, кнопки «Відключити» у них нет. `recruiter` — создаёт HR или админ для конкретного
    сотрудника, отключает он сам или HR. При блокировке сотрудника его `personal` и `recruiter` аккаунты →
    `disabled`, их публикации → `conflict`.
15. **Отзыв токена площадкой.** Адаптер, получив признак недействительного токена, ставит аккаунту `revoked`,
    удаляет секрет из `tenant_secrets`, переводит его публикации в `conflict`, шлёт `vacancy.account_revoked`
    владельцу и админу. Повторных обращений к провайдеру нет: `409 jobboard.account_revoked`.
16. **Ошибка публикации.** Ретраи 3 раза через 1, 5 и 25 минут только на временные ошибки (сеть, `429`, `5xx`).
    Постоянные (валидация полей, нет прав, исчерпан пакет объявлений) ретраям не подлежат: `failed`,
    `last_error_code`, уведомление `vacancy.publication_failed` с текстом площадки как есть и кнопкой
    «Спробувати ще раз».
17. **Дублирующая публикация.** Частичный уникальный индекс физически не даёт второй активной публикации той же
    вакансии в тот же аккаунт → `409 publication.duplicate` со ссылкой на существующую. Если площадка отвечает,
    что объявление с такими данными уже есть (создано мимо Lola), публикация → `conflict`, `external_id`
    сохраняется, предлагается «Прив'язати існуюче оголошення» или «Створити нове».
18. **Абстракция провайдера.** Продукт не знает API площадок. Адаптер реализует семь операций: `isConfigured()`,
    `getAuthUrl(state)`, `handleCallback(code, state)`, `publish(payload)` → `{external_id, external_url,
    expires_at}`, `update(external_id, payload)`, `remove(external_id)`, `health()`. `payload` — нормализованная
    структура: заголовок, четыре блока в HTML-подмножестве, город, страна, тип занятости, формат, опыт,
    образование, вилка с флагом видимости, языки, публичная ссылка отклика. Неподдерживаемое адаптер отбрасывает
    сам и возвращает список отброшенного, который показывается в окне подтверждения: «Майданчик не підтримує:
    <перелік>». Точные эндпоинты и лимиты площадок в ТЗ не фиксируются.
19. **Источник отклика.** В ссылку, отдаваемую площадке, добавляется `?s=<код публикации>`; он ложится в
    `vacancy_applications.utm` и далее в `users.source='job_board'`, `source_detail` = название площадки. Без
    параметра источник — `vacancy_link`.
20. **Что происходит после принятого отклика** (одна транзакция, при ошибке полный откат): поиск человека по
    телефону и e-mail (`docs/28` §7.2); найден активный кандидат или сотрудник → `state='merged'`, в его историю
    «Повторний відгук <дата>, вакансія <назва>», новый профиль не создаётся; не найден → создаётся `users` с
    `kind='candidate'`, `candidate_state='active'`, `candidate_status_id` = системный `new`, `source`,
    `source_detail`, `vacancy_id`, `recruiter_id` из вакансии, `comm_language` = язык публичной страницы,
    `consent_given_at` из отклика, `consent_expires_at` по настройке тенанта, `resume_asset_id` при загруженном
    файле; создаётся `assignments` по §3.5; уходят `vacancy.applied_welcome` кандидату и
    `vacancy.application_received` рекрутеру.

> [исправлено, PR-15: правило аудитории П-16.1 пришлось уточнить, чтобы этот пункт был исполним]
> Раскрытие аудитории (`server/services/audience.ts`) отсекало кандидатов во **всех** правилах,
> включая перечень людей поимённо, — и назначение из §7.20 не создавалось бы никогда. Теперь
> фильтр по виду стоит на правилах-условиях («посада», «мітка», «точка», сегмент), где
> появление кандидата всегда случайно, и снят с правила `user`, где людей называют поимённо:
> это и есть явный выбор вида, которого требует П-16.1. Курс чужого этапа кандидату по-прежнему
> не назначить — `stageForbidsCandidates()` (`docs/v2/33` §7.9) проверяет ровно названных
> поимённо, и написана эта проверка была именно под этот случай.
21. **Шаблоны.** «Зберегти шаблон» снимает текущие значения (кроме исключённых в §3.4), просит уникальное имя,
    создаёт `vacancy_templates`. Применение заполняет пустые поля; заполненные не перезаписываются без
    подтверждения «Замінити заповнені поля значеннями шаблону?».
22. **Санитайз rich-text.** Разрешены `p, br, strong, em, u, ul, ol, li, h3, h4, a[href]`; ссылки только
    `https://` с `rel="nofollow noopener"`; остальное вырезается на сервере при сохранении.
23. **Согласие на обработку ПД.** Версия текста — в `consent_text_version`, сам текст версионируется в
    настройках тенанта. Отклик без `consent_given_at` не создаётся никогда (`not null` в БД, `422
    consent.required` в API); значение переносится в `users.consent_given_at` без изменения (`docs/28` §3.2),
    поэтому срок стирания ПД отсчитывается от реального согласия.

---

## 8. Уведомления

| Код | Событие | Канал | Кому | Шаблон (uk), кратко |
|---|---|---|---|---|
| `vacancy.apply_otp` | отправлен код подтверждения | SMS, e-mail | откликнувшемуся | «Ваш код для підтвердження відгуку: <код>. Діє 10 хвилин.» |
| `vacancy.applied_welcome` | отклик принят, кандидат создан | e-mail, Telegram, SMS | кандидату | «Дякуємо за відгук на вакансію <назва>. Перший крок відбору — за посиланням. Доступ до <дата>.» |
| `vacancy.application_received` | принят новый отклик | in-app | рекрутеру вакансии | «Новий відгук на вакансію <назва>.» |
| `vacancy.application_review` | отклик ушёл на модерацию | in-app | рекрутеру, HR | «Відгук на <назва> потребує перевірки: підозра на спам.» |
| `vacancy.spam_burst` | >20 блокировок по вакансии за час | in-app, e-mail | HR, админу | «Незвична активність на сторінці вакансії <назва>. Посилання тимчасово обмежено.» |
| `vacancy.published_external` | успешная публикация | in-app | инициатору | «Вакансію <назва> опубліковано на <майданчик>.» |
| `vacancy.publication_failed` | ошибка после ретраев | in-app, e-mail | инициатору, HR | «Не вдалося опублікувати <назва> на <майданчик>: <текст помилки>.» |
| `vacancy.account_revoked` | площадка отозвала токен | in-app, e-mail | владельцу аккаунта, админу | «Акаунт <майданчик> більше не авторизований. Підключіть його заново.» |
| `vacancy.publication_expiring` | объявление истекает через 3 дня | in-app | рекрутеру | «Оголошення <назва> на <майданчик> завершується <дата>.» |
| `vacancy.closed_with_candidates` | закрытие с кандидатами в работе | in-app, e-mail | рекрутеру, HR | «Вакансію <назва> закрито. N кандидатів ще проходять відбір.» |
| `vacancy.subscriber_reopened` | набор возобновлён | e-mail | подписавшимся на странице 410 | «Набір на <назва> знову відкрито.» |
| `vacancy.ai_quota` | исчерпана ось `ai_generate_ops` | in-app | админу | «Ліміт ШІ-операцій вичерпано. Генерація текстів недоступна.» |

[решение] Откликнувшийся получает ровно два сообщения: код подтверждения и приглашение к отбору. О публикации,
состоянии вакансии и модерации своего отклика он не уведомляется — «ваш відгук на перевірці» это прямая
подсказка спамеру.

> [исправлено, PR-17] Три поправки к таблице выше, по прецеденту PR-14 (`docs/v2/28` §8: «точка
> в коде уведомления означала бы второе соглашение об именах рядом с полусотней существующих
> кодов»):
> 1. **Коды — `snake_case`, не через точку**: `vacancy_application_review`, `vacancy_spam_burst`,
>    `vacancy_published_external`, `vacancy_publication_failed`, `vacancy_account_revoked`,
>    `vacancy_closed_with_candidates` (плюс уже сданные PR-16 `vacancy_applied_welcome`,
>    `vacancy_application_received`). Решение `44` В-16 предлагало обратное для пакета в целом —
>    отменено тем же прецедентом второй раз, теперь и для этого документа.
> 2. **`vacancy.ai_quota` не заводится** — решение `44` В-16: «`vacancy.ai_quota` и
>    `ai_ops_exhausted` — один `limit_exceeded` с `axis=ai_generate_ops`». Уведомление админу
>    уже шлёт `billing.limit_scan` (PR-09) для любой исчерпанной оси, включая эту, — второй код
>    о том же факте только дал бы второе письмо.
> 3. **`vacancy.publication_expiring` и `vacancy.subscriber_reopened` не реализованы** — их
>    фоновые задачи (`vacancy.publication_expiry`, подписка на странице 410) вне объёма PR-17,
>    см. `docs/v2/46-progress.md`, запись PR-17, «Что осталось».
> `vacancy.apply_otp` — не отдельный код: контакт подтверждается тем же `otp_code`
> (`server/services/otpChannel.ts`), что и вход в систему (PR-16, `otp.ts#issueContactCode()`).

---

## 9. Отчёты и выгрузки

1. **Эффективность вакансии.** Вакансия · точка · просмотров · откликов · принято · конверсия «просмотр →
   отклик» · «отклик → завершил отбор» · нанято · срок до первого найма. Фильтры: период, точка, рекрутер,
   категория, состояние.
2. **Эффективность площадок.** Площадка · аккаунт (тип владельца) · активных публикаций · откликов · нанято ·
   `source_budget` / число наймов = стоимость найма. Питает «Джерела» в `docs/28` §9.3.
3. **Журнал публикаций.** Вакансия · площадка · владелец аккаунта · инициатор · состояние · `published_at` ·
   `expires_at` · ретраев · последняя ошибка.
4. **Защита публичных страниц.** Сутки · просмотров · отправок · заблокировано · на модерации · спам · топ-5
   причин. Без IP в любом виде.
5. **Использование ИИ.** Пользователь · блок · генераций · списано операций · доля текстов, опубликованных без
   правки человеком.
6. **Выгрузка откликов.** CSV/XLSX: имя, контакт, источник, дата, состояние, признаки спама, ссылка на
   кандидата. Требует `vacancy.view` в полном объёме, пишется в `audit_log` с числом строк — как выгрузка
   кандидатов в `docs/28` §9.6.

---

## 10. API

Префикс `/api/v1`, формат `{data}` / `{error:{code,message,details}}`, курсорная пагинация, `Idempotency-Key` на
мутациях, чужой тенант — `404`.

| Метод | Путь | Вход | Выход | Ошибки |
|---|---|---|---|---|
| GET / POST | `/vacancies` | фильтры, `cursor` / тело §6.1 | список / вакансия | `403`, `422 validation` |
| GET / PATCH | `/vacancies/:id` | — / изменяемые поля | вакансия с критериями и языками | `404`, `409 conflict`, `422` |
| POST | `/vacancies/:id/publish` | — | `{public_url}` | `422 vacancy.link_requirements`, `409 vacancy.ai_text_unreviewed` |
| POST | `/vacancies/:id/pause` | — | вакансия | `409 vacancy.not_published` |
| POST | `/vacancies/:id/close` | `{reason, remove_external, notify_candidates}` | вакансия | `409`, `422 reason.required` |
| POST | `/vacancies/:id/archive` | — | вакансия | `409 vacancy.has_pending_applications` |
| POST | `/vacancies/:id/rotate-token` | — | `{public_url}` | `409 vacancy.not_published` |
| GET / POST | `/vacancies/:id/criteria` | — / `{name, weight, scale_min, scale_max, is_critical}` | критерии | `422` |
| PATCH / DELETE | `/vacancies/:id/criteria/:cid` | поля | критерий / `204` | `404` |
| POST | `/vacancies/:id/criteria/generate` | — | черновик критериев | `409 limit_exceeded` с `details.axis=ai_generate_ops` (решение `44` В-16) |
| POST | `/vacancies/:id/ai-text` | `{target, tone?}` | `{html, generation_id}` | `409 limit_exceeded` с `details.axis=ai_generate_ops` (решение `44` В-16 — не именованный код), `404` |
| POST | `/vacancies/:id/ai-text/:gid/acknowledge` | — | вакансия | `404` |
| POST | `/candidates/:id/criterion-scores` | `[{criterion_id, value_num, comment?}]` | свёрнутая `candidate_scores` | `404`, `422 criterion.out_of_scale` |
| GET / POST | `/vacancy-templates` | — / `{name, payload, criteria, languages}` | шаблоны | `409 template.name_exists` |
| POST | `/vacancy-templates/from-vacancy/:id` | `{name}` | шаблон | `409 template.name_exists` |
| POST | `/vacancies/from-template/:tid` | `{location_id, recruiter_id}` | вакансия-черновик | `404` |
| GET | `/job-board-accounts` | `?provider=&owner_type=` | список, сгруппированный по владельцу | — |
| POST | `/job-board-accounts` | `{provider, owner_type, owner_user_id?, label?}` | аккаунт (см. ниже) | `403 jobboard.owner_forbidden`, `422` |
| POST | `/job-board-accounts/:id/disconnect` | — | `{ok:true}` | `403`, `404` |

> [исправлено, PR-17: заглушка не делает сетевого вызова — пара `GET .../auth-url` +
> `GET .../callback` описывала бы редирект в никуда] Ранее было две ручки выше плюс
> `POST /job-board-accounts` не существовал. Подключение — один синхронный `POST
> /job-board-accounts`: право решает `owner_type` (§7.14), секрет-заглушка создаётся сразу.
> Когда придёт настоящий вендор (не в этом пакете), `getAuthUrl`/`handleCallback` из §7.18
> встанут под тот же интерфейс адаптера без переписывания вызывающего кода — контракт
> подключения (кто может подключить, что сохраняется) не меняется, меняется реализация.
| GET / POST | `/vacancies/:id/publications` | — / `{account_ids[], confirm:true}` | публикации | `409 publication.duplicate`, `409 jobboard.account_revoked`, `422 publication.confirm_required` |
| DELETE | `/vacancies/:id/publications/:pid` | — | `204` | `404`, `409 publication.not_active` |
| POST | `/vacancies/:id/publications/:pid/link-external` | `{external_id}` | публикация | `409 publication.not_conflict` |
| GET | `/vacancies/:id/applications` | `?state=` | отклики | `404` |
| POST | `/vacancies/:id/applications/:aid/accept` | — | кандидат | `409 limit.candidates_exceeded` |
| POST | `/vacancies/:id/applications/:aid/reject` | `{reason}` | отклик | `422` |
| POST | `/vacancies/:id/applications/:aid/spam` | — | отклик | `404` |

> [исправлено фазой 1, `43` §5 и `44` В-9] Ранее: «Публичный контур — префикс `/api/public/v1`».
> Фактически в `main` уже работает `/api/v1/public/*` (`guest-page.get.ts`, `signup.post.ts`,
> `mystery/[token]/`): префикс задаётся деревом каталогов Nitro, а не строкой в коде, и
> переносить три работающие ручки под другой путь нет смысла. Ниже путь `/j/:token` и его
> производные читаются как `/api/v1/public/j/:token` и т. д.

**Публичный контур** — префикс `/api/v1/public/*`, без авторизации, свои лимиты и свой лог:

| Метод | Путь | Вход | Выход | Ошибки |
|---|---|---|---|---|
| GET | `/j/:token` | — | публичная карточка + `form_nonce` | `404 vacancy.not_found`, `410 vacancy.paused`, `429 rate.too_many` |
| POST | `/j/:token/apply` | `{full_name, phone?, email?, comment?, consent, form_nonce, website}` | `202 {application_id, otp_required}` | `422 consent.required`, `422 contact.required`, `429 rate.too_many`, `410` |
| POST | `/j/:token/apply/:aid/confirm` | `{code}` | `200 {status:"accepted"}` | `400 otp.invalid`, `429 otp.too_many` |
| POST | `/j/:token/apply/:aid/resume` | multipart | `{asset_id}` | `413 media.too_big`, `415 file.type` |
| POST | `/j/:token/subscribe` | `{email}` | `202` | `429` |

**Вебхук `vacancy.application_received`** (докс/v2/44 В-18, реализован в PR-37): новый отклик
(`POST /j/:token/apply`, он же попадает в `GET /vacancies/:id/applications`) шлёт наружу
событие `vacancy.application_received` с `payload.data = {vacancyId, applicationId,
receivedAt}` — без ФИО и контактов откликнувшегося. Вызов `emitWebhook()` стоит в
`convertApplication()` (`server/services/publicApply.ts`), в обеих ветках конверсии —
`accepted` и `merged` (§7.20); `receivedAt` — момент подачи формы (`vacancy_applications
.created_at`), а не момент конверсии, который может быть отложен модерацией §7.7.

[решение] Публичный контур живёт в собственном каталоге `server/api/v1/public/`, а не спрятан
за обычными скоупами: здесь нет сессии, `tenant_id` выводится из токена, действуют отдельные
лимиты и запрещены любые операции чтения списков. Правило контура, обязательное для каждой
новой ручки под `public/` — вывод тенанта из токена или хоста, вход в `withTenant`,
`hitRateLimit`, ответ `404` на несуществующий токен, выровненный по времени, — записано в
`docs/v2/39-patches.md` П-04.

---

## 11. Фоновые задачи

| Имя | Расписание | Что делает |
|---|---|---|
| `vacancy.publish_external` | по событию | публикация через адаптер, ретраи 1/5/25 мин |
| `vacancy.remove_external` | по событию | снятие объявлений при закрытии вакансии |
| `vacancy.publication_health` | каждые 30 мин | `health()` по активным аккаунтам, перевод в `failing` |
| `vacancy.publication_expiry` | ежедневно 08:00 | перевод в `expired`, уведомление за 3 дня |
| `vacancy.application_expire` | ежечасно | `pending` без OTP старше 24 ч → `expired`, удаление временного резюме |
| `vacancy.spam_watch` | каждые 10 мин | всплеск блокировок → `vacancy.spam_burst` и ужесточение лимитов на 6 часов |
| `vacancy.attempts_gc` | ежедневно 03:40 | удаление `public_apply_attempts` старше 30 дней |
| `vacancy.subscriber_notify` | по событию | письмо подписавшимся при возобновлении набора |
| `vacancy.stats_rollup` | ежечасно | пересчёт просмотров и конверсий для §9.1 |

---

## 12. Крайние случаи

1. **Курс вакансии снят с публикации или архивирован.** Вакансия автоматически → `paused`, ссылка отдаёт 410,
   рекрутер уведомлён. Отклик без назначаемого курса не принимается никогда.
2. **Лимит кандидатов исчерпан в момент отклика.** Отклик сохраняется как `pending_review` с причиной `limit`,
   человеку показан обычный текст благодарности, рекрутер видит «Відгук не створив кандидата: вичерпано ліміт
   тарифу» и кнопку на тариф (зеркало `docs/28` §12.5).
3. **Точка вакансии удалена или деактивирована.** Вакансия → `paused`, публикация останавливается, форма требует
   выбрать новую точку.
4. **Рекрутер уволен.** `recruiter_id` не обнуляется; вакансия попадает в фильтр «Без відповідального» и в
   дайджест HR (`docs/28` §12.4); публикации через его личный и рекрутерский аккаунты → `conflict`.
5. **Один человек откликнулся на две вакансии.** Один кандидат; `users.vacancy_id` остаётся от первого отклика,
   второй фиксируется событием истории и вторым `assignments`.
6. **Отклик от действующего сотрудника.** Кандидат не создаётся: `merged`, в истории сотрудника «Відгукнувся на
   вакансію <назва>», уведомление рекрутеру и HR; человеку на публичной странице — обычный текст благодарности
   (правило `docs/28` §12.1 соблюдено, но наружу не раскрыто).
7. **Резюме загружено, отклик не подтверждён.** Файл в `media_assets` с `origin='candidate_cv'` и
   `owner_user_id = null`; при `expired` удаляется задачей `vacancy.application_expire` (`docs/v2/34-storage.md`).
8. **Площадка вернула успех без `external_id`.** Публикация → `conflict`, а не `active`: без идентификатора её
   нельзя ни обновить, ни снять; предлагается привязать вручную (§7.17).
9. **Два рекрутера публикуют одну вакансию на одну площадку одновременно.** Второй падает на уникальном индексе
   → `409 publication.duplicate` со ссылкой на созданную.
10. **Вилку скрыли после публикации.** Изменение `salary_visible` ставит активные публикации в очередь `update`;
    если адаптер не поддерживает обновление — `conflict` с текстом «Майданчик не підтримує оновлення. Зніміть і
    опублікуйте заново.» Молча оставлять скрытые данные наружу нельзя.
11. **Кандидат отозвал согласие сразу после отклика.** Обезличивание по `docs/28` §7.9; строка
    `vacancy_applications` теряет `full_name`, `phone`, `email`, `comment`, `resume_asset_id`, сохраняя
    `created_at`, `source`, `spam_score` для статистики.

---

## 13. Критерии приёмки

1. **Дано** вакансия без курса, **коли** нажата «Опублікувати», **тоді** `422 vacancy.link_requirements`, токен
   не выдан, состояние осталось `draft`.
2. **Дано** опубликованная вакансия, **коли** неавторизованный человек открывает `/j/<token>`, **тоді** страница
   отдаётся за ≤300 мс, вилка видна только при `salary_visible=true`, в HTML нет названия курса, рекрутера и
   внутренних идентификаторов.
3. **Дано** публичная форма, **коли** отправка приходит через 1 секунду после выдачи nonce, **тоді** ответ `202`
   с обычным текстом благодарности, отклик в `pending_review` с причиной `fast_submit`, кандидат не создан.
4. **Дано** honeypot заполнен, **коли** форма отправлена, **тоді** `spam_score ≥ 60`, отклик в `pending_review`
   или `spam`, человеку показан тот же текст, что и при успехе.
5. **Дано** один IP, **коли** приходит четвёртый отклик за час, **тоді** он блокируется, в
   `public_apply_attempts` есть `submit_blocked` с причиной `ip_hour`, ответ внешне неотличим от успешного.
6. **Дано** `public_apply_otp=true`, **коли** код не введён 24 часа, **тоді** отклик `expired`, кандидат не
   создан, `candidates_active` не изменился, файл резюме удалён.
7. **Дано** подтверждённый отклик, **коли** транзакция §7.20 завершилась, **тоді** создан `users` с
   `kind='candidate'`, `source='vacancy_link'`, `consent_given_at` равен моменту из формы, и ровно одна
   `assignments` с параметрами из `assignment_template`.
8. **Дано** кандидат по вакансии в работе, **коли** в вакансии изменён проходной балл, **тоді** его
   `assignments.params` не изменились, форма показала «Кандидатів у роботі: 1».
9. **Дано** блок «Вимоги», сгенерированный ИИ и не тронутый человеком, **коли** нажата «Опублікувати», **тоді**
   `409 vacancy.ai_text_unreviewed` с перечнем блоков.
10. **Дано** лимит `ai_generate_ops` исчерпан, **коли** нажата «Створити з AI», **тоді** `409
    limit_exceeded` с `details.axis=ai_generate_ops` (решение `44` В-16), текст не сгенерирован, счётчик не изменился.
11. **Дано** критерии с весами 3, 1, 1 и баллами 5, 2, 0 по шкале 0–5, **коли** рекрутер сохраняет оценку,
    **тоді** создаётся одна `candidate_scores` с `kind='recruiter'` и `value_num = 6.80`, предыдущая строка того
    же вида получает `is_current = false`.
12. **Дано** площадка отозвала токен, **коли** запускается фоновая публикация, **тоді** аккаунт `revoked`,
    секрет удалён из `tenant_secrets`, публикация `conflict`, владелец и админ уведомлены, повторных обращений к
    провайдеру нет.
13. **Дано** вакансия с 3 кандидатами в работе, **коли** она закрывается, **тоді** прохождение не прервано,
    ссылка отдаёт 410, объявления сняты, рекрутер получил `vacancy.closed_with_candidates` со списком из трёх.
14. **Дано** пользователь другого тенанта, **коли** он запрашивает чужую вакансию, **тоді** `404`, а не `403`.
15. **Дано** публикация от имени компанейского аккаунта, **коли** она создана, **тоді** в `audit_log` есть
    `vacancy.published_external` с `account_id`, `provider`, `payload_hash`, инициатором и `request_context`.

---

## 14. Сверено с эталоном

Снято с Sintegrum (`/vacancies`, форма создания, вкладки «Шаблони» и «Інтеграції», панель «Про вакансію» в графе
трека):
- Три вкладки верхнего уровня раздела — §5; пустое состояние списка и меню «Нова вакансія» / «Обрати шаблон» —
  §5.1.
- Состав формы: рекрутер, название, категория, рекрутинговый курс, точка, подразделение; четыре rich-text блока
  с «Створити з AI»; условия работы (тип занятости, формат, страна, город); опыт и образование; вилка «від/до» с
  валютой по умолчанию UAH и чекбоксом «Показувати кандидатам»; динамический список иностранных языков; блок
  «Параметри публікації» с состоянием «Немає підключених інтеграцій»; кнопка «Зберегти шаблон» — §3.1, §6.1.
- Подсказка красным «Оберіть трек та філію для створення посилання на автоматичну співбесіду» — превращена в
  констрейнт `vacancies_public_chk` и правило §7.1.
- Вкладка «Шаблони» с пустым состоянием «Немає готових шаблонів» и кнопкой «Створити шаблон» — §3.4, §5.3.
- Вкладка «Інтеграції»: карточки трёх площадок, сгруппированные по владельцу — компания, личный кабинет
  пользователя, по группе на каждого рекрутера; строка поиска — §3.7, §5.4.
- Блок «Оцінка кандидата по критеріях» с кнопками «Додати» и «Згенерувати критерії (AI)» из панели «Про
  вакансію» в графе трека — §3.3, §7.11.
- Read-only зеркало текстовых блоков вакансии внутри графа трека — учтено тем, что тексты живут в `vacancies`, а
  не в узлах трека.

Не снималось с эталона и является решением Lola: публичная страница и форма отклика целиком; защита от ботов без
внешней капчи; отклик как сущность, отдельная от кандидата; пять состояний вакансии и правила переходов;
`assignment_template` как шаблон, а не носитель правил; свёртка критериев в `candidate_scores.kind='recruiter'`;
абстракция провайдера и семь операций адаптера; маркировка AI-текста и запрет публикации непроверенного.

---

## 15. Гипотезы и принятые по ним решения

**Г-29.1. Колонки списка вакансий.** На эталоне ноль вакансий, список не раскрыт. [гипотеза] Название, точка,
статус, счётчик откликов. [решение] Состав §5.1 выведен из задачи рекрутера «где что горит»: отдельно новые
отклики, отдельно кандидаты в работе, отдельно статусы публикаций. *Чем проверяется:* создать на эталоне
тестовую вакансию и посмотреть список.

**Г-29.2. Где кнопка публикации.** Найдена только «Зберегти шаблон». [гипотеза] Кнопка в sticky-шапке или
появляется после заполнения обязательных полей. [решение] Sticky-шапка с тремя действиями: «Зберегти»,
«Опублікувати» (с проверками §7.1 и §7.9), «⋮ → Зберегти шаблон»; публикация — явное действие, не побочный
эффект сохранения. *Чем проверяется:* заполнить обязательные поля и осмотреть форму сверху и сбоку.

**Г-29.3. Назначение бейджа «Вакансія» на форме.** [гипотеза] Индикатор состояния. [решение] Бейдж состояния со
всеми пятью значениями §4 в цветах бренда: `draft` — чернила, `published` — бирюза, `paused` — солнце, `closed`
и `archived` — серый. *Чем проверяется:* сохранить черновик и сравнить бейдж с опубликованной вакансией.

**Г-29.4. Состав блока «Іноземні мови».** [гипотеза] Пара «язык + уровень». [решение] Пара плюс `is_required`:
требование «англійська B2 обов'язково, польська A2 бажано» обычно для линейного персонала, а без флага
невыразимо; шкала CEFR плюс `native` (§3.2). *Чем проверяется:* нажать «+ Додати мову» и раскрыть селект уровня.

**Г-29.5. Поля формы одного критерия.** Список критериев на эталоне пуст. [гипотеза] Название, вес, описание.
[решение] Добавлены шкала (`scale_min`/`scale_max`) и `is_critical`: без явной шкалы веса несравнимы между
критериями; формула свёртки зафиксирована в §3.3, чтобы число было воспроизводимым, а не «как посчитал
фронтенд». *Чем проверяется:* нажать «Додати» в блоке «Оцінка кандидата по критеріях».

**Г-29.6. Что делает «Згенерувати критерії (AI)».** [гипотеза] Создаёт критерии по тексту вакансии. [решение]
Генерирует черновик 3–8 критериев с явным сохранением, списывает 1 `ai_generate_ops`, помечает `origin='ai'`
(§7.11); автосоздание строк исключено — критерии влияют на решение о человеке. *Чем проверяется:* нажать кнопку
и посмотреть, появляются ли строки сразу или как черновик.

**Г-29.7. Есть ли AI-кнопка у блока «Додаткова інформація».** Не проверено. [решение] Есть, как у остальных
трёх: отсутствие кнопки у одного из четырёх одинаковых редакторов было бы необъяснимо (§6.1). *Чем проверяется:*
прокрутить форму до четвёртого блока.

**Г-29.8. Срок жизни объявления на площадке.** С эталона не снимался. [гипотеза] Площадки ограничивают срок
публикации. [решение] `expires_at` заполняется адаптером из ответа площадки; нет срока от провайдера — поле
пустое и напоминание не шлётся, собственный срок Lola не придумывает. *Чем проверяется:* подключить аккаунт и
опубликовать тестовое объявление.

**Г-29.9. Чем «персональний» аккаунт отличается от аккаунта рекрутера.** Визуально это две группы с одинаковыми
карточками. [гипотеза] «Персональний» — аккаунт текущего пользователя, группы ниже — аккаунты других рекрутеров,
видимые администратору. [решение] Одна таблица, `owner_type` с тремя значениями, права разведены в §7.14. *Чем
проверяется:* зайти под рекрутером и сравнить состав групп с видом админа.

**Г-29.10. Поведение публичной ссылки при приостановке.** Публичная страница на эталоне не наблюдалась (вакансий
не было). [гипотеза] Ссылка просто перестаёт работать. [решение] Три разных ответа: 410 с подпиской при
`paused`, единый 404 при `closed`, `archived` и неизвестном токене, 429 при превышении потолка (§5.6) —
различать закрытую и несуществующую вакансию наружу нельзя, иначе токены перебираются. *Чем проверяется:*
опубликовать вакансию, открыть ссылку, приостановить и открыть снова.
