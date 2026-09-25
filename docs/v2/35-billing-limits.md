# Lola LMS — ТЗ. 35. Тарифы, лимиты и потребление

## 1. Назначение и границы

За что тенант платит, что именно считается, где счёт упирается в стену, а где только предупреждает.

| Базовый документ | Что делает этот документ |
| --- | --- |
| `24-settings-platform.md` §4.4 | **заменяет** описание состава `plans`/`tenant_limits`: `price_per_active_user`, `min_users` и плоский `limits` не держат двухосевую модель и отдельно истекающий ИИ |
| `24` §4.4.1 (эталон `/statistics`) | **сохраняет дословно**: суточный сбор в 00:00, счёт по активным |
| `24` §8, коды `limit_warning` / `limit_exceeded` | **дополняет**: коды те же, добавлен параметр «ось» и правило повтора |
| `25-multitenancy.md` §10 | **расширяет** таблицу ресурсов (кандидаты, ИИ, интеграции); правило «обучение не останавливается лимитами» переносится буквально |
| `0001_foundation.sql` | **эволюционирует** `plans`, `tenant_limits`, `tenant_usage` через `alter table` (§3.1–3.3); ни одна колонка не удаляется |

Входит: оси лимитов, подсчёт потребления, жёсткие и мягкие лимиты, ИИ как отдельно истекающий ресурс, аддоны,
биллинговый период, grace и только-чтение, история платежей, баннер лимита, переопределения оператором. Не
входит: приём денег провайдером (R2, `27-gateway-public.md`), себестоимость ИИ-провайдера, механика обучения
(`10`–`19`). Суммы эталона — чужие: цены и пороги — **параметры оператора платформы** (§3.4).

## 2. Роли и скоупы

| Действие | employee | manager | admin | owner | platform_admin |
| --- | :-: | :-: | :-: | :-: | :-: |
| Видеть баннер лимита | — | — | ✓ | ✓ | ✓ |
| Экран «Тариф і ліміти» (`billing.view`) | — | — | ✓ | ✓ | ✓ |
| Счётчики потребления (`billing.usage.view`) | — | — | ✓ | ✓ | ✓ |
| Суммы и история платежей (`billing.payments.view`) | — | — | — | ✓ | ✓ |
| Сменить тариф, докупить аддон (`billing.manage`) | — | — | — | ✓ | ✓ |
| Экран «Сховище», удаление файлов (`storage.manage`) | — | — | ✓ | ✓ | ✓ |
| Тарифная сетка (`platform.plans.manage`) | — | — | — | — | ✓ |
| Переопределить лимит (`platform.limits.override`) | — | — | — | — | ✓ |
| Продлить ИИ, выдать пакет операций (`platform.ai.grant`) | — | — | — | — | ✓ |
| Отметить платёж принятым (`platform.payments.manage`) | — | — | — | — | ✓ |

`owner` — существующая системная роль тенанта (`01-roles.md`). Суммы видит только он, `admin` — потребление и
даты `[решение]`: администратор обучения и подписант договора — разные люди.

## 3. Сущности и поля

### 3.1 `plans` — платформенная таблица (вне RLS)

```sql
alter table plans
  add column title_uk text, add column tier smallint not null default 0,
  add column ai_included boolean not null default true, add column ai_term_days int,
  add column addons_allowed text[] not null default '{}', add column sort int not null default 0,
  add column is_active boolean not null default true,
  add column valid_from date not null default current_date, add column valid_to date;
```

> [исправлено фазой 1, `44` В-5, реализовано PR-08 — миграция `0059_v2_billing_plans.sql`]
> Ранее: `plans.limits jsonb` — карта осей §7.1. Фактически `plans` — **явные колонки**
> `max_*`, PK по `code`, колонки `id` нет. Лимиты новых осей добавлены пятью колонками
> (`max_candidates`, `max_ai_generate_ops`, `max_ai_review_ops`, `max_ai_interview_ops`,
> `max_export_rows`) рядом с прежними `max_users`, `max_storage_gb`, `max_sms_per_month`.
> Колонка `sort` уже существовала — в `alter` вошли восемь колонок, а не девять.

`plans` **вне RLS**: нет `tenant_id`, таблица общая (`25` §3.1); приложению
`grant select` с фильтром `is_public and is_active`, запись — роль `platform_admin`.

### 3.2 `tenant_limits` — состояние подписки тенанта

```sql
alter table tenant_limits
  add column billing_period text not null default 'month' check (billing_period in ('month','year')),
  add column status text not null default 'trial' check (status in ('trial','active','grace','readonly','suspended')),
  add column paid_until date, add column grace_until date, add column ai_until date,
  add column autorenew boolean not null default true, add column currency char(3) not null default 'EUR',
  add column ai_status text not null default 'active' check (ai_status in ('active','expired','off')),
  add column updated_at timestamptz not null default now(), add column updated_by uuid;
```

> [исправлено фазой 1, `44` В-5, реализовано PR-08] Ранее: `tenant_limits.overrides jsonb`.
> Фактически переопределение — **явная колонка на ось**: шесть прежних (`users`, `storage_gb`,
> `sms_per_month`, `api_per_minute`, `webhooks`, `active_jobs`) плюс пять новых (`candidates`,
> `ai_generate_ops`, `ai_review_ops`, `ai_interview_ops`, `export_rows`); `null` = лимит тарифа.
> «Снять лимит» оператор делает переопределением в `null` **при пустой колонке тарифа**:
> отсутствие значения в обеих колонках и есть «без обмежень» (§7.3).
>
> Строка `tenant_limits` с PR-08 держит и состояние подписки (колонки ниже), поэтому сброс
> всех переопределений больше не удаляет её, если в ней есть оплаченный срок (`docs/28`).

### 3.3 `tenant_usage` — суточный срез

```sql
alter table tenant_usage
  add column plan_id uuid references plans(id), add column candidates_active int not null default 0,
  add column storage_by_category jsonb not null default '{}'::jsonb, add column ai_ops jsonb not null default '{}'::jsonb,
  add column sms_out int not null default 0, add column telegram_out int not null default 0,
  add column integrations_active int not null default 0, add column axes jsonb not null default '{}'::jsonb;
create index tenant_usage_recent_idx on tenant_usage (tenant_id, collected_at desc);
```

> [исправлено фазой 3, `44` В-5, реализовано PR-09 — миграция `0061_v2_billing_usage.sql`]
> Ранее: `plan_id uuid references plans(id)`. Колонки `id` у тарифа нет (PK по `code`), поэтому
> колонка называется `plan_code text references plans(code)` — то же исправление, что уже
> внесено в §3.4 для `plan_prices` и в §3.5 для `tenant_payments`. Индекс
> `tenant_usage_recent_idx` не создаётся: полный эквивалент `(tenant_id, collected_at desc)`
> существует с базовой схемы под именем drizzle. Разбивку `storage_by_category` до появления
> `media_assets.stage_code` (PR-12) заполняет единственный определённый ключ `other`
> (`docs/28` §28.12) — выдуманных категорий не заводится.

`axes` — расширение без миграции: новая ось живёт здесь и получает колонку, только когда признана тарифной.
`storage_by_category` — разбивка по 10 категориям треков из `05-tracks.md` плюс `other` (снято с `/storage`
эталона).

### 3.4 `plan_prices` и `plan_addons` — цены и каталог опций (платформенные, вне RLS)

> [исправлено фазой 1, `44` В-5, реализовано PR-08] `plan_id uuid references plans(id)` →
> `plan_code text references plans(code)`: колонки `id` у тарифа нет, на `code` уже ссылается
> `tenants.plan`. То же — в `tenant_payments` и `plan_change_requests` §3.5 (их создаёт PR-10).

```sql
create table plan_prices (  -- цена за месяц; за год списывается ×12
  id uuid primary key default gen_random_uuid(),
  plan_code text not null references plans(code) on delete cascade on update cascade,
  billing_period text not null check (billing_period in ('month','year')),
  currency char(3) not null default 'EUR', amount_minor bigint not null check (amount_minor >= 0),
  valid_from date not null default current_date, valid_to date,
  unique (plan_code, billing_period, currency, valid_from));

create table plan_addons (  -- каталог опций; unit_step: 100 ГБ, 1000 операций, 90 дней
  code text primary key, name text not null, axis text not null, unit_step bigint not null,
  term text not null check (term in ('period','perpetual')),
  is_public boolean not null default true, sort int not null default 0);
```

Обе таблицы — платформенные, без `tenant_id` и вне RLS. У `plan_addons.code` значения `storage_pack`,
`ai_ops_pack`, `sms_pack`, `candidates_pack`, `ai_term` (у `ai_term` увеличивается срок ИИ, а не ось).
`axis` ограничен CHECK'ом: одиннадцать значений `limit_axis` плюс служебное `ai_term`; `unit_step` —
**в единице своей оси** (байты для `storage_bytes`, операции для ИИ-осей, дни для `ai_term`), иначе
«+100 ГБ» и лимит тарифа складывались бы в разных шкалах (PR-08).

Структура сетки `[решение]`: **9 тиров**, шаг по оси «співробітники» возрастающий (50 → 75 → 100 → 150 → 200 →
350 → 500 → 750 → 1000), «кандидати» ровно ×2 от сотрудников на каждом тире, «сховище» одинаковое на всех тирах,
годовая цена за месяц ниже помесячной на `platform_settings.annual_discount_pct` (ориентир эталона 35–38 %).
Конкретных сумм в коде и в ТЗ нет.

### 3.5 Новые тенантные таблицы

```sql
create table tenant_addons (   -- докупленные опции; unit_step — снимок на момент покупки
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  addon_code text not null references plan_addons(code), qty int not null check (qty > 0), unit_step bigint not null,
  valid_from date not null default current_date, valid_until date,   -- null = до отключения
  source text not null default 'purchase' check (source in ('purchase','grant','compensation')),
  payment_id uuid, created_by uuid, created_at timestamptz not null default now());
create index tenant_addons_active_idx on tenant_addons (tenant_id, addon_code, valid_until);

create table usage_counters (  -- счётчики периода, реальное время; limit_snapshot null = безлимит
  tenant_id uuid not null references tenants(id) on delete cascade, axis text not null,
  period_start date not null, period_end date not null, used bigint not null default 0, limit_snapshot bigint,
  updated_at timestamptz not null default now(), primary key (tenant_id, axis, period_start));
create index usage_counters_axis_idx on usage_counters (tenant_id, axis, period_end desc);

create table usage_events (    -- журнал расхода, хранение 400 дней
  id bigserial primary key, tenant_id uuid not null references tenants(id) on delete cascade,
  axis text not null, delta bigint not null, ref_id uuid, actor_user_id uuid, meta jsonb not null default '{}'::jsonb,
  ref_kind text not null check (ref_kind in ('ai_generation','ai_review','ai_interview','sms','upload','export')),
  occurred_at timestamptz not null default now());
create index usage_events_axis_idx on usage_events (tenant_id, axis, occurred_at desc);

> [исправлено фазой 3, реализовано PR-10 — миграция `0073_v2_billing_payments.sql`] Ранее:
> `plan_id uuid references plans(id)` в `tenant_payments`, `from_plan_id`/`to_plan_id uuid
> references plans(id)` в `plan_change_requests`. Фактически `plans` не имеет колонки `id`
> (PK по `code`, В-5) — то же исправление, что уже внесено выше для `plan_prices` и для
> `tenant_usage.plan_code` (`45` PR-08, PR-09): обе таблицы ссылаются на `plan_code`(s) text.

create table tenant_payments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('subscription','addon','adjustment')),
  plan_code text references plans(code), addon_code text references plan_addons(code), billing_period text,
  period_from date, period_to date,
  amount_minor bigint not null, currency char(3) not null default 'EUR', paid_at timestamptz,
  status text not null default 'pending' check (status in ('pending','paid','failed','refunded','written_off')),
  method text check (method in ('bank_transfer','card','manual')), invoice_number text, invoice_media_id uuid,
  comment text, created_by uuid, created_at timestamptz not null default now(), unique (tenant_id, invoice_number));
create index tenant_payments_recent_idx on tenant_payments (tenant_id, created_at desc);

create table plan_change_requests (   -- blockers: [{axis,current,new_limit,excess}]
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  from_plan_code text references plans(code), to_plan_code text not null references plans(code), billing_period text not null,
  status text not null default 'preflight' check (status in ('preflight','blocked','scheduled','applied','cancelled')),
  blockers jsonb not null default '[]'::jsonb, effective_at date, requested_by uuid, decided_by uuid,
  decided_at timestamptz, created_at timestamptz not null default now());
create index plan_change_requests_open_idx on plan_change_requests (tenant_id, status);

create table limit_notices (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  axis text not null, level text not null check (level in ('warn','exceeded')),
  value_at_raise bigint not null, limit_at_raise bigint, resolved_at timestamptz, dismissed_by uuid,
  raised_at timestamptz not null default now(), dismissed_until timestamptz);
create unique index limit_notices_open_uidx on limit_notices (tenant_id, axis, level) where resolved_at is null;
```

> [дополнено фазой 3, реализовано PR-09] `usage_events` получает **`request_context jsonb`** —
> правило «все журналы пишут технический контекст одинаково» (`CLAUDE.md` п. 14) сильнее
> краткости DDL. Перечень `ref_kind` остаётся шестизначным: журнал ведут только измеряемые
> операции, а моментальные оси (`users_active`, `candidates_active`, `integrations_active`)
> строки расхода не создают — их счётчик сходится **пересчётом факта** (§7.1, §7.5), и именно
> это проверяет сквозная проверка 15 (`42` §5). Рядом с частичным уникальным индексом
> `limit_notices` заведён полный `(tenant_id, raised_at desc)` — без него частичный не
> покрывает список баннера (контрактный тест `v2-contract-02`).

### 3.6 RLS

**Вне RLS** (нет `tenant_id`, общие для платформы, `25` §3.1): `plans`, `plan_prices`, `plan_addons`. **Под
RLS** по правилу `25` §3.2 (`enable` + `force` + политика `tenant_isolation` с `using` и `with check`):
`tenant_limits`, `tenant_usage`, `tenant_addons`, `usage_counters`, `usage_events`, `tenant_payments`,
`plan_change_requests`, `limit_notices`.

## 4. Состояния и переходы

**Подписка** (`tenant_limits.status`): `trial → active` (первый платёж) · `active → grace` (день после
`paid_until`) · `grace → active` (оплата) · `grace → readonly` (истёк `grace_until`) · `readonly → active` ·
`readonly → suspended` (через 60 дней, вручную оператором, `25` §8) · `suspended → active`.

**ИИ** (`ai_status`): `active → expired` (день после `ai_until`) · `expired → active` (продление) ·
`active|expired → off` и обратно (оператор). Таймер ИИ **не зависит** от таймера подписки.

**Заявка на смену тарифа**: `preflight → blocked` (есть превышения) · `preflight → scheduled` (вниз, с нового
периода) · `preflight → applied` (вверх, сразу) · `blocked → preflight` · любой → `cancelled`.

**Баннер**: `нет записи → warn` (≥80 %) · `warn → exceeded` (≥100 %) · `warn|exceeded → dismissed` (24 часа) ·
`dismissed → warn|exceeded` · `* → resolved` (ниже 80 %).

## 5. Экраны

> [уточнено, реализовано PR-10] Путь экранов — `/admin/settings/billing` и
> `/admin/settings/billing/history`, а не `/settings/billing*`: все тенантные экраны настроек
> этого репозитория живут под `/admin/settings/*` (тот же префикс, что уже занял
> `/admin/settings/usage`, PR-09) — отдельного пространства путей `/settings/*` в кодовой базе
> нет. «Продовжити тариф», «Змінити тариф», «Продовжити ШІ», «Докупити пакет ШІ-операцій» на
> `5.1` в этом PR не отправляют форму: самообслуживание (preflight/blocked, `/billing/plan-change*`,
> экран `§5.2`) не входит в «Входит» плана PR-10 (`45-plan.md`) и не встречается в других PR —
> кнопки показывают подсказку обратиться к менеджеру, который принимает платёж вручную
> (`POST /platform/tenants/:id/payments`). Полноценный self-service — отдельный PR, см.
> `docs/v2/46-progress.md`, запись «Фаза 3, PR-10».

**5.1 `/settings/billing` — «Тариф і ліміти»** (owner, admin). «Поточний тариф»: название плана, «Вартість на
місяць», «Період оплати» («Помісячно» / «Річно»), «Доступ оплачено до: DD.MM.YYYY · Залишилось N днів», кнопки
«Продовжити тариф» и «Змінити тариф»; у `admin` цена скрыта. «Використання» — строка на ось в формате эталона:
«Співробітників 42 із 50», «Кандидатів 0 із 100», «Треків 260 · без обмежень», «Сховище 5.27 Гб із 100 Гб»,
«ШІ-операції 180 із 200 цього періоду»; полоса солнечная при ≥80 %, коралловая при ≥100 %; ниже серым
«Статистика споживання збирається раз на добу о 00:00. Останній збір: DD.MM HH:MM» для суточных осей, «в
реальному часі» для моментальных. «Штучний інтелект»: «Доступно до: DD.MM.YYYY (N днів)», три ИИ-счётчика,
кнопка «Продовжити ШІ»; при `ai_status=expired` — плашка «Підписку на ШІ завершено DD.MM.YYYY. Генерація
контенту та ШІ-перевірка вимкнені, навчання і ручна перевірка працюють.» «Додаткові опції»: активные аддоны,
кнопки «Збільшити сховище» и «Докупити пакет ШІ-операцій»; ссылка «Історія платежів». Пусто (`trial`): «Ви на
пробному періоді до DD.MM.YYYY. Оберіть тариф, щоб продовжити роботу після цієї дати.» Загрузка — скелетоны;
ошибка — «Не вдалося завантажити дані тарифу» и «Повторити», показан последний срез.

**5.2 `/settings/billing/plans`** — карточки тиров по `sort`: название, цена за месяц при выбранном периоде,
лимиты по осям, кнопка «Підключити»; над сеткой переключатель «Помісячно / Річно» с подписью «Економія N %»;
текущий тариф — метка «Підключено»; тир ниже текущего с превышением — кнопка неактивна, кораллом «Перевищено:
Співробітників 42 із 25».

> [решение, PR-10] Этот экран не построен в PR-10: он часть самообслуживания владельца
> (preflight/blocked, `/billing/plan-change*`), которого нет в «Входит» плана. Таблица
> `plan_change_requests` заведена и используется прямой сменой тарифа оператором (§7.10,
> `/platform/tenants/:id/plan-change`) — статус сразу `applied`, без предпросмотра превышений.

**5.3 `/settings/billing/history`** (owner): «Дата», «Призначення», «Період», «Сума», «Статус», «Рахунок»
(файл); фильтры период, тип, статус; пусто — «Платежів ще не було».

> [уточнено, PR-10] Колонка «Рахунок» показывает номер счёта текстом (`invoice_number`), а не
> ссылку на файл: приём платежа в этом PR не имеет формы загрузки — `invoice_media_id` заведён
> в схеме, но никто его не заполняет. Прикрепление файла счёта — вместе с формой загрузки в
> будущем PR.

**5.4 `/settings/storage`** (admin, owner), снято с эталона: «Використовується: X Гб / Y Гб», разбивка по
категориям треков, кнопка «Збільшити сховище», фильтры «Категорія» и «Вибрати період», таблица «Файл»,
«Співробітник», «Трек», «Дата», «Розмір файлу» с чекбоксами и кнопкой «Видалити»; удаление уменьшает счётчик
немедленно (§7.5).

**5.5 Баннер лимита** — полоса под шапкой на **каждом** экране тенанта, как на эталоне; видят `admin` и `owner`,
`employee` и `manager` — никогда. `warn`: «Незабаром буде досягнуто ліміту: {ось} — {використано} із {ліміт}.»
плюс «Змінити тариф» и крестик. `exceeded`: «Ліміт вичерпано: {ось} — {використано} із {ліміт}. {последствие из
§7.4}», крестика нет.

**5.6 `/platform/tenants/:id/billing`** (оператор): план, период, даты, статус, срок ИИ, таблица осей «лимит
плана / переопределение / факт», кнопки «Змінити тариф», «Переозначити ліміт», «Продовжити доступ», «Продовжити
ШІ», «Видати пакет операцій», «Відзначити платіж»; каждое действие требует комментарий 10–500 знаков и пишется в
`platform_audit` (`25` §7.5).

> [уточнено, реализовано PR-10] Панель оператора не отдельная страница `/platform/tenants/:id/billing`
> — она диалоги над существующей таблицей тенантов `/ops` (мокап PlatformTenants, `docs/24` §4.1):
> «Ліміти» (уже была, PR-08/09), «Тариф і оплата» (новый диалог — статус подписки, історія
> платежів, форма «Записати платіж»), и підтвердження зміни тарифу через випадаючий список
> плану в тій самій таблиці. «Продовжити доступ» і «Продовжити ШІ» отдельных кнопок не имеют —
> это тот же `kind='subscription'` платёж (продлевает `paid_until`) и переопределение `ai_until`
> через существующий `/limits`; «Видати пакет операцій» — существующий `grantTenantAddon`
> (PR-08), диалог для него в этом PR не добавлен, вызывается тем же механизмом покупки аддона.

## 6. Формы

**6.1 Смена тарифа (owner).** «Тариф» — карточки-радио (обяз., активный публичный план, ошибка «Оберіть тариф»);
«Період оплати» — переключатель `month`/`year` (обяз.); «Підтвердження переходу вниз» — чекбокс (обяз. при
downgrade, ошибка «Підтвердьте, що ознайомились із новими лімітами»). Затем предпросмотр «Ось · зараз · новий
ліміт · статус», строки с превышением кораллом; «Підключити» заблокирована, пока есть хоть одна, под ней «Щоб
перейти на цей тариф, зменшіть використання до нових лімітів.» и список действий (§7.6).

**6.2 Докупка аддона (owner).** «Опція» — селект из `plan_addons`, отфильтрованный по `plans.addons_allowed`
(ошибка «Ця опція недоступна на вашому тарифі»); «Кількість» — степпер 1–20; «Період дії» — только чтение;
сумма; чекбокс подтверждения.

**6.3 Переопределение лимита (оператор).** «Тенант» (чтение), «Ось» (селект из §7.1), «Значення» (число или «Без
обмежень»), «Діє до» (дата или «безстроково»), «Причина» (10–500 знаков, обяз.). Значение ниже факта допускается
с предупреждением «Значення менше за поточне використання ({факт}). Перевищення виникне одразу.»

## 7. Правила и алгоритмы

### 7.1 Оси лимитов

| Ось | Единица | Как считается | Тип | При исчерпании |
| --- | --- | --- | --- | --- |
| `users_active` | человек | моментально: `count(users) where status='active' and kind='employee'`; суточный срез — для графика | жёсткий | активация и приглашение сотрудника отклоняются; блокировка освобождает место немедленно |
| `candidates_active` | человек | моментально: кандидаты не в архиве и не отклонённые | жёсткий | создание вручную, по ссылке вакансии и импортом отклоняется; архивация освобождает место |
| `storage_bytes` | байт | моментально при загрузке (текущее + размер файла); суточный пересчёт по префиксу `t/<tenant_id>/` | жёсткий | загрузка нового файла отклоняется, загруженное доступно |
| `ai_generate_ops` | операция | счётчик периода, инкремент в транзакции запроса | жёсткий | «Згенерувати трек» и «Створити з AI» отключаются |
| `ai_review_ops` | операция | счётчик периода | жёсткий с деградацией | ИИ-сверка не выполняется, задание идёт в обычную очередь ручной проверки (`06-review`) |
| `ai_interview_ops` | собеседование | счётчик периода, завершённое ИИ-собеседование = 1 | жёсткий | новые не запускаются, начатые доводятся до конца |
| `sms_out` | сообщение | счётчик периода | жёсткий | канал SMS отключается, доставка идёт Telegram и in-app (`23` §6) |
| `telegram_out` | сообщение | счётчик периода | мягкий | только наблюдение: канал бесплатный, всплеск — признак ошибки в правилах |
| `integrations_active` | подключение | моментально: активные вебхуки и коннекторы | жёсткий | создание нового подключения отклоняется |
| `api_rate_rpm` | запрос/мин | фиксированное окно 60 с на токен, по умолчанию 60 | жёсткий | `429` с `Retry-After` |
| `export_rows` | строка | на операцию | жёсткий с деградацией | выгрузка уходит в фоновую задачу со ссылкой на файл |

> [исправлено, `44` В-20, PR-39] Ранее у `api_rate_rpm`: «скользящее окно». Так не работает и не
> работало: `hitRateLimit` (`server/services/rateLimit.ts`) считает фиксированное окно 60 секунд на
> токен, значение по умолчанию — 60 запросов (`DEFAULT_API_PER_MINUTE`); вторая ось не заводится.

### 7.2 Почему треки не лимитируются

Трек — контент самого тенанта: хранение оплачено осью `storage_bytes`, ИИ-создание — `ai_generate_ops`,
прохождение — `users_active`. Лимит на число треков не защищает ресурсов платформы, зато мешает разложить работу
на мелкие треки по должностям и точкам (эталон: 260 треков без лимита). По той же причине не лимитируются
модули, вопросы, опросы, шаблоны уведомлений, роли, точки, подразделения и должности `[решение]`.

### 7.3 Эффективный лимит оси

> [исправлено фазой 1, `43` §5 и `44` В-5] Ранее: `effective = coalesce(overrides[axis],
> plans.limits[axis]) + Σ(tenant_addons.qty × unit_step…)`, то есть `plans.limits jsonb` и
> `tenant_limits.overrides jsonb`. Фактически `plans` — явные колонки с PK по `code` (колонки
> `id` нет), а `tenant_limits` уже имеет шесть явных колонок лимита (`users, storage_gb,
> sms_per_month, api_per_minute, webhooks, active_jobs`); пять мест сырого SQL сравнивают
> потребление с лимитом (`usage.ts:33-35`, `platform.ts:74-75, 96-97, 198, 234`) — опечатка в
> ключе `jsonb` там означала бы «без обмежень», то есть тихо сняла бы лимит и исказила счёт
> клиенту. Решение: `tenant_limits` доводится до **одиннадцати явных колонок** (пять новых:
> `candidates`, `ai_generate_ops`, `ai_review_ops`, `ai_interview_ops`, `export_rows`); `jsonb`
> остаётся только для нетарифной оси `telegram_out`, в `tenant_usage.axes` — она наблюдается,
> но не тарифицируется.

`effective(axis) = coalesce(tenant_limits[axis], plans[axis]) + Σ(tenant_addons.qty × unit_step
по этой оси, действующих на дату)`; отсутствие значения в обеих колонках означает «без
обмежень». Значение фиксируется в `usage_counters.limit_snapshot` при открытии периода, чтобы
смена тарифа в середине месяца не переписывала задним числом уже потраченное. Точный состав
колонок и миграция — `docs/v2/45-plan.md` PR-08.

**Формула живёт в одном месте** — `effectiveLimits()` / `effectiveLimit(tenantId, axis)` в
`server/services/tenantLimits.ts` (PR-08). Баннер лимита, проверка при операции и расчёт счёта
обязаны звать её, а не считать `coalesce(tl.*, p.max_*)` у себя: до PR-08 так считали в пяти
местах, и панель оператора уже показывала число, не знавшее ни про доплаты, ни про умолчания.
Результат возвращается **в единице оси** (§7.1): хранилище — в байтах, хотя колонка лимита
хранит гигабайты.

### 7.4 Жёсткие и мягкие лимиты: поимённо

**Блокируются:** активация сотрудника, отправка приглашения, импорт людей (целиком, если после импорта лимит был
бы превышен), создание кандидата, приём отклика по ссылке вакансии, загрузка файла, генерация трека ИИ,
генерация вакансии ИИ, запуск ИИ-собеседования, отправка SMS, создание интеграции, API сверх частоты. **Только
предупреждают:** число треков, модулей, вопросов, опросов, ролей, точек, должностей; Telegram-сообщения; число
назначений; объём отчёта на экране. **Не блокируются никогда:** открытие трека, прохождение модуля, ответ на
задание, попытка теста, сдача задания на проверку, ручная проверка ментором, выдача сертификата, вход, просмотр
своих результатов, in-app и Telegram-уведомления (правило `25` §10, сильнее любого лимита). Исключение одно —
`readonly` (§7.8), и оно тоже не закрывает прохождение назначенного.

### 7.5 Момент проверки и освобождение места

Жёсткие лимиты проверяются **в момент операции по текущему значению**, а не по ночному снимку (`25` §10);
суточный срез `tenant_usage` — для графиков и панели оператора. Блокировка сотрудника, архивация кандидата,
удаление файла и отключение интеграции уменьшают счётчик в той же транзакции; обратное действие снова
проверяется на лимит: «Ліміт активних співробітників вичерпано (50 із 50). Розблокуйте після зміни тарифу або
заблокуйте іншого.»

> [исправлено, fix-seat-limit, сводная проверка PR-40] Лимит `users_active` обходился: разблокировка,
> восстановление из архива, повторный найм, приглашение и первый вход приглашённого места не проверяли; найм
> кандидата проверял его отдельным подключением до транзакции (два найма на последнее место проходили оба);
> `POST /people` при сбое проверки считал «можно». Теперь **каждый путь, который добавляет активного
> сотрудника или обещает ему место, зовёт одну функцию** — `assertSeatsWithinLimit()`
> (`server/services/tenantLimits.ts`), решение внутри — `checkLimit()` §7.3, сырых сравнений нет:
>
> | Путь | Что происходит с человеком | Где проверяется |
> | --- | --- | --- |
> | создание (`POST /people`) | новый приглашённый | `people.createPerson` |
> | приглашение, в том числе массовое и из архива | место обещано: вход его займёт | `people.createInvitation` |
> | импорт CSV, `POST /sync/people`, импорт из Google Workspace | новые приглашённые | `importPeople.applyImport`, до первого батча, **целиком** (§12) |
> | разблокировка | `status = active`, `is_blocked = false` (и архивному тоже) | `people.setBlocked` |
> | восстановление из архива, снятие блокировки правкой карточки | активация | `people.updatePerson` |
> | найм и повторный найм (`POST /people/hire`) | активен сразу (найденный) или приглашён (новый) | `offboarding.hire` |
> | найм кандидата | `kind → employee`, активен | `candidateHire.hireCandidate` |
> | первый вход приглашённого (код, пароль, ссылка, выбор пространства, второй фактор) | активация | `session.markSignedIn` |
>
> Вход через Google ищет только уже активных и людей не заводит (`session.completeSignin`) — места не меняет.
>
> - **В той же транзакции, что изменение.** Проверка берёт транзакционную advisory-блокировку мест тенанта,
>   считает занятые места в этой же транзакции и только потом решает; отказ откатывает операцию целиком. Две
>   операции на последнее место выстраиваются в очередь — проходит ровно одна.
> - **Первый вход — это активация** (`01` §1.6, `25` §10 «проверка — при активации», к. 1 «коли активують
>   51-го»): приглашение обещает место, вход его занимает. Иначе приглашённые по одному, пока свободно одно
>   место, заходили бы все. «Вхід не блокується ніколи» (§7.4) — про того, кто место уже занимает, в том числе
>   сверх лимита после снижения оператором; кандидата лимит сотрудников не касается. Отказанному — «Зверніться
>   до адміністратора», ссылка-приглашение при этом не сгорает, админам — `limit_exceeded`.
> - **Импорт — целиком или никак** (§12): новых людей больше, чем свободных мест, — не применяется ни одна
>   строка, задача остаётся `ready`. Проверка до первого батча (батчи — свои транзакции), а гонка двух импортов
>   последнее место не отнимет: приглашённый места не держит, его вход проверяется снова.
> - **Fail-closed.** Проверку не удалось выполнить — сбой базы, блокировки или строки тарифа нет
>   (`tenants.plan` без внешнего ключа: без строки тарифа ось читалась бы как «без обмежень») — это
>   `503 limit.check_failed` с понятным текстом, операция не выполнена.
> - **Коды.** Мест нет — единый `409 limit_exceeded` с `details: {axis: 'users_active', used, limit}` (§10, `44`
>   В-16), в том числе у найма кандидата вместо прежнего `limit.users_exceeded` (в `details` — ещё
>   продлённое право входа `accessUntil`, `28` §12.5).
>
> Критерий §13 к. 1 и §12 проверяет `tests/integration/seat-limit.spec.ts`: каждый путь при N активных —
> отказ, при N−1 — проходит; гонка пяти разных путей за последнее место — проходит ровно один; сбой проверки —
> отказ по каждому пути.

### 7.6 Переход вниз по тарифу

1. Выбор тира ниже создаёт `plan_change_requests` в статусе `preflight`; считается таблица превышений: по каждой
   оси `current` против нового `effective`.
2. Превышений нет → `scheduled`, переход применяется **с первого дня следующего оплаченного периода**, деньги за
   текущий не возвращаются; в карточке «Тариф зміниться DD.MM.YYYY».
3. Превышения есть → `blocked`, кнопка неактивна, по каждой оси показано действие: «Співробітників 42 із 25 —
   заблокуйте 17 співробітників», «Кандидатів 60 із 50 — архівуйте 10 кандидатів», «Сховище 120 Гб із 100 Гб —
   видаліть 20 Гб файлів або залиште опцію “+100 Гб”».
4. «Перерахувати» пересчитывает превышения; при нуле статус возвращается в `preflight`; заблокированная заявка
   живёт 30 дней и затем `cancelled`. Переход **вверх** применяется немедленно, разница за остаток периода
   считается пропорционально дням `[решение]`.

### 7.7 ИИ как отдельно тарифицируемый и отдельно истекающий ресурс

1. ИИ **включён в план** (`plans.ai_included`), а не продаётся отдельной подпиской — как на эталоне, где суффикс
   «.AI» есть у всех девяти тиров.
2. У ИИ **собственная дата окончания** `ai_until` от даты подключения (`plans.ai_term_days`), а не от
   `paid_until`; даты расходятся при внеочередном продлении одной из них.
3. Операции считаются тремя раздельными осями (генерация, проверка, собеседование); исчерпание одной не мешает
   другим.
4. **ИИ истёк, тариф действует** (`ai_status='expired'`, `status='active'`): отключаются генерация трека и
   вакансии, ИИ-собеседование, ИИ-сверка ответа, ИИ-оценка кандидата; работают обучение, ручная проверка и
   оценка, ранее сгенерированные материалы и ранее выданные ИИ-оценки (в карточке как исторические, с датой);
   «Оцінка ШІ» у новых кандидатов пуста и подписана «Підписку на ШІ завершено».
5. **Тариф истёк, ИИ действует**: работает §7.8, ИИ уходит в только-чтение вместе со всем остальным.
6. Продление ИИ — отдельная операция и отдельная строка истории платежей (`kind='addon'`,
   `addon_code='ai_term'`), даже если по срокам совпало с тарифом.

> [дополнено, PR-27] Три ИИ-оси и срок ИИ проверяет **одно место** — шлюз модели
> `server/services/ai/gateway.ts` (`docs/v2/30` §3.2), через который идёт каждый вызов модели в
> продукте. Роль профиля определяет ось и способ списания (`server/services/ai/policy.ts`,
> `AI_PURPOSE_METER`): генерация — `ai_generate_ops` на вызов, ИИ-сверка — `ai_review_ops` на
> вызов, расшифровка, оценка и Підсумок — `ai_interview_ops` **один раз за сессию** резервом при
> старте (`30` §7.12), эмбеддинги поиска — вне тарифа. Поведение оси при исчерпании — по-прежнему
> столбец «При исчерпании» §7.1 (`AXIS_METER`, PR-09): генерация отклоняется (`refused`), сверка
> уходит в ручную проверку (`degraded`), новое собеседование не стартует, начатое доводится.
> Отказ поднимает `limit_exceeded` с `axis` админам (`ai_ops_exhausted` §8 сведён к нему `44` В-16).
> Истёкший (`ai_status='expired'`) или выключенный (`'off'`) ИИ и `readonly`/`suspended` дают
> `409 ai.unavailable` с `details.reason` — операцию, но не поиск и не начатую сессию. Списание
> идёт в одной транзакции с отметкой вызова и сохранением результата: упавший вызов и
> несохранённый результат не тарифицируются (§12, §13 к. 9).

### 7.8 Аддоны, биллинговый период, grace, только-чтение

1. Аддон увеличивает **одну** ось на `qty × unit_step`; модель эталона (фиксированное хранилище плюс опция
   «Збільшити сховище») принята дословно. `term='period'` продлевается вместе с тарифом при `autorenew`,
   `term='perpetual'` — пока не отключён оператором. При переходе вниз аддоны сохраняются и учитываются в
   предпросмотре превышений; по окончании аддона ось возвращается к лимиту плана, при факте выше поднимается
   `exceeded`, но автоматического удаления данных за неоплату нет никогда.
2. Период — месяц или год от даты подключения, `paid_until` — последний оплаченный день включительно; годовая
   оплата списывается разово за 12 месяцев по цене для `billing_period='year'`, скидка показывается как
   «Економія N %»; за 14, 7, 3 и 1 день уходит `plan_expiring_soon`.
3. После `paid_until` — **grace** длительностью `platform_settings.grace_days` (параметр, ориентир 7 дней
   `[решение]`): всё работает полностью, сверху плашка «Доступ оплачено до DD.MM.YYYY. Залишилось N днів
   пільгового періоду.»
4. После `grace_until` — **только-чтение**: запрещены создание и правка контента, создание назначений,
   добавление людей и кандидатов, загрузка файлов, SMS, вызовы ИИ, запись через API (`GET` остаётся); разрешены
   вход, прохождение **уже назначенного** обучения, ручная проверка ранее сданного, просмотр и выгрузка своих
   данных, оплата. Плашка: «Доступ у режимі лише читання. Щоб відновити роботу, продовжіть тариф.»
5. Через 60 дней в `readonly` оператор вправе перевести тенанта в `suspended` (`25` §8) — ручное решение с
   уведомлением, а не автоматика.
6. Оплата в любом состоянии немедленно возвращает `active` и сдвигает `paid_until` от **исходной** даты
   окончания, а не от даты оплаты: иначе пропуск платежа стал бы бесплатной отсрочкой.

### 7.9 Баннер: порог, повтор, закрытие

> [уточнено фазой 3, реализовано PR-09] Таблицы `platform_settings` в схеме нет ни одной
> строки: параметры платформы (`limit_warn_pct`, `grace_days`, `annual_discount_pct`) пока
> живут константами. Порог 80 % — `LIMIT_WARN_PCT` в `server/services/usageCounters.ts`, одно
> место на баннер, уведомление и экран потребления. Заводить таблицу ради одного числа PR-09
> не стал — решение и условие переноса в `docs/28` §28.12.

1. Порог — 80 % эффективного лимита (`platform_settings.limit_warn_pct`); в баннер попадают только жёсткие оси
   плюс `users_active` и `candidates_active`; при нескольких сработавших осях — одна полоса с наиболее тяжёлым
   уровнем и счётчиком «та ще N».
2. Крестик закрывает баннер на 24 часа (`dismissed_until`); возвращается, если истекли 24 часа, уровень вырос с
   `warn` до `exceeded` или сработала новая ось. `exceeded` закрыть нельзя: крестика нет.
3. Потребление ниже 80 % → `resolved_at`, запись закрывается; следующий подъём — новая.
4. `[исправлено 25.09.2026, долг §3]` Нулевой лимит оси (тариф вовсе без ИИ, `ai_*_ops = 0`) —
   не «без обмежень» и не повод молчать: ось, которую тенант не трогал (`used=0`), баннер не
   поднимает — `ok`; но попытка вызова, отклонённая `checkLimit()` (`35` §7.3), обязана дать
   `exceeded` и `limit_exceeded` админам, как и любая другая исчерпанная жёсткая ось. `callModel()`
   и `reserveSessionOp()` (`server/services/ai/gateway.ts`) поднимают её в момент отказа —
   плановый `billing.limit_scan` неиспользуемую ось с нулевым лимитом не трогает (счётчик у
   неё и не должен расти, раз лимит 0), поэтому увидеть исчерпание может только сам вызов.

### 7.10 Что переопределяет оператор платформы

Может: назначить любой план, включая `is_public=false`; переопределить любую ось в `overrides` в любую сторону,
включая «без обмежень»; сдвинуть `paid_until`, `grace_until`, `ai_until`; выдать пакет ИИ-операций
(`source='grant'`); отметить платёж принятым вручную; перевести в `suspended` и обратно. Не может: изменить
`usage_events`; удалить строку `tenant_payments` (только `refunded`/`written_off` новой строкой); снять правило
«обучение не останавливается». Каждое действие требует причины и пишется в `platform_audit` (`25` §7.5) и
`audit_log`.

## 8. Уведомления

| Код | Событие | Канал | Кому | Шаблон (uk) |
| --- | --- | --- | --- | --- |
| `limit_warning` | ось достигла 80 % | in-app, Telegram, email | owner, admin | «Незабаром буде досягнуто ліміту: {axis_label} — {used} із {limit}.» |
| `limit_exceeded` | ось достигла 100 % | in-app, Telegram, email | owner, admin | «Ліміт вичерпано: {axis_label} — {used} із {limit}. {consequence}» |
| `plan_expiring_soon` | 14/7/3/1 день до `paid_until` | Telegram, email | owner | «Доступ оплачено до {paid_until}. Залишилось {days} днів.» |
| `plan_grace_started` | начался grace | Telegram, email | owner, admin | «Строк оплати минув. Пільговий період до {grace_until}.» |
| `plan_readonly` | включён только-чтение | Telegram, email, in-app | owner, admin | «Простір переведено в режим лише читання. Навчання доступне, зміни заблоковані.» |
| `plan_changed` | тариф применён | in-app, email | owner, admin | «Тариф змінено на {plan_name} з {effective_at}.» |
| `plan_change_blocked` | заявка упёрлась в превышение | in-app | owner | «Перехід на {plan_name} неможливий: перевищено {axes}.» |
| `ai_expiring_soon` | 14/7/3/1 день до `ai_until` | Telegram, email | owner, admin | «Підписка на ШІ діє до {ai_until}. Залишилось {days} днів.» |
| `ai_expired` | `ai_status→expired` | Telegram, email, in-app | owner, admin | «Підписку на ШІ завершено. Генерація та ШІ-перевірка вимкнені.» |
| `ai_ops_exhausted` | ИИ-ось исчерпана | in-app | owner, admin | «Вичерпано {axis_label} цього періоду ({used} із {limit}).» |
| `payment_received` | платёж `paid` | email | owner | «Отримано платіж {amount} {currency}. Доступ продовжено до {paid_until}.» |
| `addon_activated` | аддон включён | in-app, email | owner | «Опцію “{addon_name}” підключено: +{value}.» |
| `addon_expiring` | 7 дней до конца аддона | in-app, email | owner | «Опція “{addon_name}” діє до {valid_until}.» |

`limit_warning` и `limit_exceeded` — те же коды, что в `24` §8; добавлен обязательный параметр `axis` в
`payload` и дедупликация: не чаще раза в 24 часа на связку `(tenant_id, axis, level)`.

## 9. Отчёты и выгрузки

**«Історія платежів»** (owner, CSV/XLSX): Дата, Призначення, Тариф, Період оплати, Період дії (з — по), Сума,
Валюта, Статус, Спосіб, Номер рахунку, Коментар; фильтры период, тип, статус.

**«Споживання»** (owner, admin): Ось, Одиниця, Ліміт, Пік, Середнє, Останнє значення, Дата останнього збору;
фильтры период, ось; клик по строке — график.

**«Сховище за категоріями»** (admin, owner): Категорія треку, Файлів, Обсяг, Частка. **«Журнал ШІ-операцій»**
(owner, admin): Дата, Ось, Хто, Об'єкт (трек / кандидат / завдання), Кількість; источник `usage_events`; фильтры
период, ось, человек.

**Платформа** (`platform_admin`): «Тенанти на межі ліміту» (тенант, ось, %, план), «Прострочені оплати» (тенант,
`paid_until`, днів прострочення, статус), «Споживання ШІ по тенантах».

## 10. API

> [исправлено фазой 1, `43` §5, `44` В-16, В-17] Ранее: пути с приписанным префиксом
> `/api/v1/billing/…`. Nitro добавляет префикс каталога сам — с ним в тексте вышло бы
> `/api/v1/api/v1/…`. Ниже пути без префикса, как и в остальных документах пакета. Строки
> `GET/DELETE /storage/files` (массовое освобождение места) вычёркиваются как второе имя
> `DELETE /media/:id` — см. `docs/v2/34-storage.md` §10.

| Метод | Путь | Вход / выход | Ошибки |
| --- | --- | --- | --- |
| GET | `/billing/summary` | план, период, даты, статус, ИИ-блок, аддоны | `403` без `billing.view` |
| GET | `/billing/usage` | `?period=` → `axis, used, limit, pct, source(live\|daily), collected_at` | |
| GET | `/billing/plans` | публичные планы с ценами обоих периодов | |
| POST | `/billing/plan-change/preflight` | `{plan_id, billing_period}` → `{allowed, blockers[]}` | `404` на непубличный план |
| POST/DELETE | `/billing/plan-change`, `/:id` | `{plan_id, billing_period, confirm}` → заявка; отмена | `409 limit_exceeded` с `details.blockers`; `409` если `applied` |
| GET/POST | `/billing/addons` | `{addon_code, qty}` | `422 addon_not_allowed` |
| GET | `/billing/payments` | курсор, фильтры | `403` без `billing.payments.view` |
| GET/POST | `/billing/notices`, `/notices/:id/dismiss` | активные записи; закрытие → `dismissed_until` | `409` при `level=exceeded` |
| GET/PUT | `/platform/plans/:id` | тарифная сетка и цены | только `platform_admin` |
| GET/PUT | `/platform/tenants/:id/limits` | `{overrides, reason}` | `422` без причины |
| POST | `/platform/tenants/:id/payments` | `{kind, planCode?, addonCode?, qty?, billingPeriod?, amountMinor, currency, method?, invoiceNumber?, status?, comment}` | `422` без причины / без валидной опции |
| POST | `/platform/tenants/:id/plan-change` | `{toPlanCode, billingPeriod, comment}` — прямая смена, без preflight (§7.10) | `422` без причины / без такого тарифа |

> [реализовано PR-10] Строка `/platform/tenants/:id/extend | /ai | /payments` документа —
> три задачи одной ручкой. Реализована только `/payments` (продление тарифа — оплата
> `kind='subscription'` через неё же, §7.8 п. 6); отдельных `/extend` и `/ai` не завёл: продление
> `paid_until`/`ai_until` без платежа уже покрыто существующим `/platform/tenants/:id/limits`
> (PUT принимает `paidUntil`/`aiUntil` наравне с прочими переопределениями — доработка вне
> схемы `tenantLimitsSchema` не потребовалась). `/billing/plan-change*`, `/billing/plans`,
> `/billing/addons`, `/platform/plans/:id` — самообслуживание владельца и каталог, не входят
> в «Входит» плана PR-10, см. пометки у §5.1–5.2.

Мутации идемпотентны по `Idempotency-Key`. Отказ по жёсткому лимиту в **любом** эндпоинте системы возвращает
единый вид `{error:{code:"limit_exceeded", message:"Ліміт вичерпано", details:{axis, used, limit}}}` со статусом
`409` — чтобы фронт показывал один диалог везде.

## 11. Фоновые задачи

| Задача | Расписание | Что делает |
| --- | --- | --- |
| `usage.collect` | 00:00 по таймзоне тенанта | суточный срез: активные люди, кандидаты, хранилище по категориям, ИИ-оси, каналы, интеграции (расширение задачи из `24` §4.4.1) |
| `usage.counters_roll` | 00:05 первого дня периода | закрывает счётчики прошлого периода, открывает новые со снимком лимита |
| `usage.storage_recount` | еженедельно | пересчёт по префиксу `t/<tenant_id>/`, сверка с моментальным счётчиком; расхождение >1 % — алерт оператору |
| `usage.prune` | ежемесячно | удаляет `usage_events` старше 400 дней |
| `billing.limit_scan` | ежечасно | поднимает и гасит `limit_notices`, шлёт `limit_warning` / `limit_exceeded` с дедупликацией |
| `billing.renew_scan` | ежедневно 09:00 | `plan_expiring_soon` за 14/7/3/1 день |
| `billing.grace_scan` | ежедневно 00:30 | `active→grace`, `grace→readonly` и уведомления |
| `billing.ai_expiry_scan` | ежедневно 09:00 | `ai_expiring_soon`, перевод `active→expired` |
| `billing.addon_expiry` | ежедневно 00:40 | закрывает истёкшие аддоны, пересчитывает лимиты, `addon_expiring` за 7 дней |
| `billing.plan_change_apply` | ежедневно 00:10 | применяет `scheduled` по `effective_at`, отменяет `blocked` старше 30 дней |

Все задачи — по тенантам, каждая внутри `withTenant()` (`25` §5).

## 12. Крайние случаи

- Импорт 300 человек при 40 свободных местах → отказ целиком, без частичного импорта: «Ліміт активних
  співробітників: 40 вільних із 50, у файлі 300 рядків».
- Кандидат принят на работу → освобождает место на `candidates_active` и занимает на `users_active` в одной
  транзакции; нет места сотрудника — конвертация отклоняется.
- ИИ-вызов упал по вине провайдера → `usage_events` не пишется, счётчик не растёт; повтор считается один раз по
  `Idempotency-Key`. ИИ истёк посреди начатого ИИ-собеседования → оно доводится до конца и учитывается, новые не
  запускаются.
- Хранилище переполнено, сотрудник записывает видеоответ → загрузка отклоняется («Сховище компанії заповнене.
  Зверніться до адміністратора.»), но задание можно сдать текстом.
- Оператор снизил переопределение ниже факта или истёк аддон «+100 Гб» при занятых 150 Гб → `exceeded` сразу,
  новые операции по оси блокируются, файлы целы, ничего не удаляется. новые операции по оси блокируются, файлы
  целы, ничего не удаляется.
- Тариф сменён вверх, затем в том же периоде вниз → вторая заявка `scheduled` на следующий период, доплата за
  первый переход не возвращается. Два администратора одновременно нажали «Підключити» на разных тирах →
  выигрывает первая транзакция, вторая получает `409 conflict`.
- Тенант в `readonly`, у сотрудника назначение с дедлайном → он проходит и завершает обучение, сертификат
  выдаётся; автоправила назначений ставятся в очередь и применяются после оплаты.
- Тенант удалён (`25` §8) → `tenant_payments` и `usage_events` живут до конца срока хранения бухгалтерских
  данных и не подпадают под `tenant.purge` `[решение]`.

## 13. Критерии приёмки

1. **Дано** лимит 50 активных и 50 активных, **коли** активируют 51-го, **тоді** отказ `409 limit_exceeded` с
   `details.axis='users_active'`; **коли** один заблокирован, **тоді** активация проходит немедленно, без
   ожидания ночного среза.
2. **Дано** лимит кандидатов 100 и 100 активных, **коли** приходит отклик по публичной ссылке вакансии, **тоді**
   отклик отклонён, кандидату «Набір тимчасово призупинено», админу — `limit_exceeded`.
3. **Дано** исчерпан `ai_review_ops`, **коли** сотрудник сдаёт задание, **тоді** задание принято и стоит в
   очереди ручной проверки, а не отклонено.
4. **Дано** `ai_status='expired'` при `status='active'`, **тоді** «Згенерувати трек» недоступна, прохождение
   треков и ручная проверка работают, ранее выданные ИИ-оценки видны в карточках.
5. **Дано** `paid_until` вчера и `grace_days=7`, **тоді** статус `grace`, всё работает, `plan_grace_started`
   отправлено один раз; **коли** истёк `grace_until`, **тоді** `readonly`, создание трека — `409`, прохождение
   назначенного трека — успешно.
6. **Дано** оплата в `readonly` на 10-й день просрочки, **тоді** `paid_until` сдвинут от прежней даты окончания,
   а не от даты оплаты.
7. **Дано** 42 активных сотрудника и тир с лимитом 25, **тоді** «Підключити» неактивна и показан текст
   «заблокуйте 17 співробітників»; **коли** заблокировано 17 и нажато «Перерахувати», **тоді** переход доступен
   с первого дня следующего периода.
8. **Дано** хранилище на 80 %, **тоді** баннер `warn` виден админу и владельцу, не виден сотруднику; **коли**
   нажат крестик — скрыт на 24 часа; **коли** дошло до 100 % — появился снова, без крестика.
9. **Дано** аддон «+100 Гб» с `term='period'`, **коли** тариф продлён, **тоді** аддон продлён вместе с ним,
   лимит хранилища остался 200 Гб; **дано** ИИ-генерация упала с ошибкой провайдера, **тоді**
   `usage_counters.used` не изменился и строки в `usage_events` нет.
10. **Дано** оператор переопределил `users_active` в 175 с причиной, **тоді** значение действует немедленно и
    есть запись в `platform_audit`; **дано** запрос `/billing/summary` от роли `employee`, **тоді** `403`,
    а не частичные данные.

## 14. Сверено с эталоном

**Sintegrum, 19.09.2026** — `/payment`, `/company-settings`, `/storage`. Взято: счётчики «використано із ліміту»
по Співробітниках, Кандидатах, Треках и Сховищі → оси §7.1, «Треків 260» без знаменателя → §7.2; «Доступ
оплачено до» с «Залишилось N днів» → `paid_until` (§5.1); 9 тиров, кандидаты ×2 сотрудников, одинаковое
хранилище и годовая скидка 35–38 % → §3.4 без переноса сумм; кнопки «Продовжити тариф», «Підключити»,
«Підключено» → §5.1–5.2; блок «Підключити Штучний інтелект» с «Доступно до: DD.MM.YYYY (N днів)» при суффиксе
«.AI» у всех тиров → §7.7; две функции ИИ (сверка ответа с ключом, генерация контента треков) → `ai_review_ops`
и `ai_generate_ops`; ИИ-собеседование кандидата → `ai_interview_ops`; «Збільшити сховище» → аддоны §3.4–3.5,
§7.8; разбивка хранилища по категориям → `tenant_usage.storage_by_category` и §9; баннер «Незабаром буде
досягнуто ліміту» → §5.5, §7.9.

**LMS Collaborator, 19.09.2026** — `/statistics` (через `24` §4.4.1): суточный сбор в 00:00, счёт по активным
(117 активных при 375 заблокированных), потолок хранилища рядом с фактом. Принято дословно (§7.5).

## 15. Гипотезы и принятые по ним решения

**Г-35.1. Хранилище одинаково на всех девяти тирах эталона** — возможно, неполнота снятых данных. **Решение:**
хранилище не привязано к тиру и продаётся аддоном (подтверждает кнопка «Збільшити сховище»). *Чем проверяется:*
карточка старшего тира на `/payment`.

**Г-35.2. Поведение при превышении лимита людей не раскрыто** — виден только баннер. **Решение:** лимиты людей и
хранилища жёсткие на создание, активацию и загрузку, обучение не останавливается никогда (§7.4). *Чем
проверяется:* попытка создать 51-го сотрудника на заполненном тарифе эталона.

**Г-35.3. Состав «Історії платежів» не раскрыт.** **Решение:** состав §3.5 и §9 выведен из требований
бухгалтерии. *Чем проверяется:* открыть историю платежей на эталоне.

**Г-35.4. Счётчика ИИ-операций на экранах эталона не видно** — виден только срок. **Решение:** три ИИ-оси со
счётчиком периода: без них себестоимость неуправляема, а «безлимитный ИИ» на фиксированной цене невозможен. *Чем
проверяется:* счётчик операций в блоке ИИ на `/company-settings`.

**Г-35.5. Длительность grace и порог баннера не сняты.** **Решение:** grace 7 дней и порог 80 % — значения по
умолчанию в `platform_settings`, меняются без релиза. *Чем проверяется:* поведение эталона на следующий день
после «Доступ оплачено до».

**Г-35.6. Пропорциональный пересчёт при переходе вверх не наблюдался.** **Решение:** доплата пропорционально
оставшимся дням; переход вниз — только с начала следующего периода, без возврата денег (§7.6). *Чем
проверяется:* смена тарифа вверх на эталоне и сумма в истории платежей.

**Г-35.7. Кто у тенанта видит суммы — на эталоне разделения не видно.** **Решение:** суммы — `owner`, счётчики
потребления — `admin` и `owner` (§2). *Чем проверяется:* открыть `/payment` эталона под неадминистративной
ролью.
