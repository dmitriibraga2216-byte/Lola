# Lola LMS — ТЗ. 30. ИИ в отборе: авто-собеседование, сводка кандидата и помощь проверяющему

## 1. Назначение и границы

Три применения ИИ, снятых со второго эталона (Sintegrum), и — главное — границы ответственности при их применении к людям.
**(1) Авто-собеседование** (`interview_sessions`): кандидат открывает назначенный модуль, виртуальный интервьюер представляется и задаёт вопросы сценария, кандидат отвечает голосом или текстом, ответы расшифровываются и оцениваются по критериям.
**(2) Підсумок кандидата** (`candidate_summaries`): компилируемый по итогам отбора документ — ответы, оценки, расхождения, рекомендация; показывается нанимающему менеджеру и может быть отправлен кандидату, в том числе при неполном прохождении.
**(3) Помощь проверяющему** (`ai_review_hints`): сверка развёрнутого ответа сотрудника с содержанием модуля и контрольным ключом, чтобы ментор проверял быстрее — но не вместо него.

**Не входит:** генерация контента и треков (ось `ai_generate_ops`, `31`); психометрические методики — они валидированы вне ИИ; биллинг и лимиты ИИ — `35`; retention файлов — `34`; воронка и решения по кандидату — `28`.

**Граница ответственности.** Lola не строит модель и отвечает за то, что вокруг неё: согласие человека, прозрачность вывода, возможность оспорить, сохранность прохождения при отказе инфраструктуры, журнал для разбора задним числом. Это документ про ответственность, а не про промпты: тексты промптов — артефакт реализации, версионируются парой `prompt_key` + `prompt_version` (§3.2) и в ТЗ не фиксируются. Вендор моделей не назван нигде: за него отвечает абстракция `ai_providers`.

**Зачем это Lola.** Первый тенант нанимает линейный персонал массово, управляющий точкой не может провести 40 первичных разговоров в месяц. Авто-собеседование снимает первичный отсев — и именно поэтому цена ошибки высока: человек, которого отсеяла машина, не получает работу. Отсюда §7.1.

[решение] **Название вместо «3Д-резюме».** Термин эталона — чужой маркетинговый ярлык: обещает три измерения, которых нет, и в их же API называется иначе (`CvProgressItem`). В Lola артефакт — **«Підсумок кандидата»**, сущность `candidate_summaries`, эндпоинты `/candidate-summaries`: слово в UI и имя сущности совпадают (инвариант 5), название описывает содержимое и не требует объяснения ни рекрутеру, ни кандидату.

---

## 2. Роли и скоупы

Новые скоупы: `interview.configure`, `interview.view`, `interview.listen`, `interview.override`, `summary.view`, `summary.edit`, `summary.send`, `ai.review.use`, `ai.audit`.

| Действие | Кандидат | Рекрутер | Ментор | Керівник точки | HR / Админ | Оператор платформы |
|---|---|---|---|---|---|---|
| Проходить собеседование, давать и отзывать согласие | ✓ | — | — | — | — | — |
| Видеть свою расшифровку и свой Підсумок | ✓ после отправки | — | — | — | — | — |
| Настраивать сценарий, критерии, провайдеров | — | — | — | — | ✓ | — |
| Видеть оценку ИИ, обоснование и цитаты | — | ✓ | — | ✓ своей точки | ✓ | — |
| Слушать аудиозапись ответов | — | ✓ | — | — | ✓ | — |
| Читать расшифровку | — | ✓ полностью | ✓ только свой вопрос | ✓ своей точки | ✓ | — |
| Переопределить оценку ИИ с причиной | — | ✓ | — | — | ✓ | — |
| Видеть Підсумок кандидата | — | ✓ | — | ✓ своей точки | ✓ | — |
| Редактировать и отправлять Підсумок | — | ✓ | — | — | ✓ | — |
| Пользоваться подсказкой ИИ при проверке | — | ✓ | ✓ | — | ✓ | — |
| Журнал ИИ-вызовов: содержимое \| только метрики | — | — | — | — | ✓ \| ✓ | — \| ✓ |
| Выборочная перепроверка качества ИИ | — | — | — | — | ✓ | — |

[решение] Ментор видит расшифровку **только той реплики, которую проверяет**, и не получает `interview.listen` вовсе: голос — биометрически значимые данные, а для проверки содержания ответа достаточно текста. [решение] Оператор платформы не видит записей, расшифровок и Підсумків (согласовано с `28` §2: кандидат недоступен оператору в любом объёме, включая impersonation); в журнале ИИ ему доступны `latency_ms`, `tokens_*`, `cost_minor`, `status`, `model_name` — хватает на разбор аварии и счёт, не хватает на чтение чужих ответов.

---

## 3. Сущности и поля

### 3.1 Как это ложится на существующую модель попытки

[решение] **Собеседование — режим теста, а не вторая система прохождения.** Сценарий привязан к `quizzes` (`mode='interview'`), сессия — строка `attempts`, каждая реплика кандидата — строка `attempt_answers`. Всё, что работает для теста, работает и здесь: `snapshot` фиксирует вопросы на момент старта, `params` — правила из назначения (инвариант 1: попытки, дедлайн и проходной балл живут в назначении, а не в сценарии), статусы попытки из `12` §4 не переопределяются, `attempt_no` считается так же. [решение] **Голос — не новый тип вопроса, а способ ввода ответа**: вопросы собеседования имеют тип `text_long` (`12` §3.3), новое поле `attempt_answers.input_mode` говорит, чем ответили. Ручная проверка, статистика и очередь `13` §5.2 работают без изменений. Новые таблицы держат **только то, чего нет в модели попытки**: согласие, характеристики записи, качество расшифровки, обрывы связи, флаги антифрода; баллы и статусы в них не дублируются.

### 3.2 Абстракция провайдера и журнал вызовов

```sql
create table ai_providers (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null, name text not null, purpose text not null, driver text not null,
  endpoint_url text, secret_ref text,                      -- ключ лежит в tenant_secrets, не здесь
  model_name text not null, model_version text, params jsonb not null default '{}'::jsonb,  -- температура, лимит токенов, таймаут
  data_region text not null default 'eu', provider_retention text not null default 'unknown', max_latency_ms int not null default 30000,
  is_active boolean not null default true, priority int not null default 100,
  fallback_provider_id uuid references ai_providers(id) on delete set null,
  created_at timestamptz not null default now(), updated_by uuid references users(id),
  constraint ai_providers_purpose_chk check (purpose in ('transcribe','interview_score','review_hint','summary')),
  constraint ai_providers_driver_chk check (driver in ('openai_compatible','http_custom','self_hosted')),
  constraint ai_providers_retention_chk check (provider_retention in ('none','ephemeral','unknown')), unique (tenant_id, code));
create index idx_ai_providers_tenant on ai_providers (tenant_id, purpose, priority) where is_active;

create table ai_calls (
  id bigserial primary key, tenant_id uuid not null references tenants(id) on delete cascade,
  provider_id uuid references ai_providers(id) on delete set null,
  purpose text not null, prompt_key text not null, prompt_version text not null, model_name text not null, model_version text,
  ref_kind text not null, ref_id uuid, subject_user_id uuid references users(id) on delete set null,
  actor_user_id uuid references users(id) on delete set null,
  input_ref text, input_digest text not null, output jsonb, output_digest text,   -- вход в S3, в БД только sha256
  status text not null default 'queued', error_code text, http_status int,
  latency_ms int, tokens_in int, tokens_out int, cost_minor int not null default 0, currency char(3) not null default 'EUR',
  usage_axis text, billed boolean not null default false, try_no int not null default 1,
  created_at timestamptz not null default now(), finished_at timestamptz,
  constraint ai_calls_status_chk check (status in ('queued','running','ok','failed','timeout','refused','degraded')),
  constraint ai_calls_ref_chk check (ref_kind in ('interview_session','interview_turn','review_hint','summary')),
  constraint ai_calls_axis_chk check (usage_axis is null or usage_axis in ('ai_interview_ops','ai_review_ops','ai_generate_ops')));
create index idx_ai_calls_tenant on ai_calls (tenant_id, created_at desc);
create index idx_ai_calls_tenant_ref on ai_calls (tenant_id, ref_kind, ref_id);
create index idx_ai_calls_tenant_status on ai_calls (tenant_id, status, created_at desc) where status <> 'ok';
```

| Поле | Тип | Обяз. | По умолчанию | Валидация | Комментарий |
|---|---|:-:|---|---|---|
| `ai_providers.purpose` | text | ✓ | — | 4 значения | одна роль на профиль: расшифровка, оценка, подсказка, сводка |
| `ai_providers.driver` | text | ✓ | — | 3 значения | вендор скрыт за драйвером: смена вендора — строка в таблице, не миграция кода |
| `ai_providers.provider_retention` | text | ✓ | `unknown` | 3 значения | сколько данные живут **у поставщика**; `unknown` запрещает профиль для `transcribe` (§7.7) |
| `ai_providers.data_region` | text | ✓ | `eu` | `eu` \| `other` | `other` требует подтверждения админа с комментарием в `audit_log` |
| `ai_providers.fallback_provider_id` | uuid | — | — | не сам на себя, глубина ≤2 | куда уйти при отказе |
| `ai_calls.input_digest` | text | ✓ | — | sha256 | доказывает «модель видела ровно это» |
| `ai_calls.prompt_version` | text | ✓ | — | ≤40 | ось метрики качества §7.16; смена версии обнуляет накопленную статистику |

[решение] Профили платформы при создании тенанта **копируются ему строками**, а не подключаются через `tenant_id is null`: nullable-тенант ломает RLS (`enable` + `force`), а копия даёт тенанту право поменять регион данных или подставить свой ключ. [решение] Полный вход **не хранится в БД**: в `input_ref` — ключ объекта в S3 (`origin='ai_artifact'`, 90 дней). Иначе журнал станет второй копией ПД кандидата, которую забудут стереть при обезличивании.

> [исправлено, PR-27 — миграция `0091_v2_ai_providers`: каждый вызов модели в продукте идёт через
> один шлюз и один журнал] Ранее в DDL выше: «`purpose in ('transcribe','interview_score','review_hint','summary')`»,
> «`driver in ('openai_compatible','http_custom','self_hosted')`», «`secret_ref text`»,
> «`ref_kind in ('interview_session','interview_turn','review_hint','summary')`». Реализовано:
> - **`purpose` + `generate`, `embed`.** Генерация текста вакансии (`29` §7.10, PR-17) и эмбеддинги
>   библиотеки и базы знаний (`31` §7.8, PR-25) — тоже вызовы модели; без своей роли они шли бы мимо
>   профиля, журнала и оси. `generate` тратит `ai_generate_ops` по операции на вызов; `embed` —
>   **вне тарифа** (`[решение]`): эмбеддинг — индекс поиска, а не функция ИИ, которую тенант
>   покупает, и отнести его к `ai_generate_ops` значило бы гасить поиск исчерпанием генерации, хотя
>   `35` §7.4 поиск не блокирует нигде. Вызов `embed` всё равно — строка `ai_calls` с токенами.
> - **`driver` + `stub`** — детерминированная заглушка (`44` §8) как строка профиля, а не переменная
>   окружения; профили платформы заводятся заглушками по одному на роль (`server/db/tenantDefaults.ts`,
>   `DEFAULT_AI_PROVIDERS`), подключение вендора — правка строки.
> - **`secret_ref uuid references tenant_secrets(id) on delete set null`** — как у
>   `job_board_accounts` (`29` §3.7); значение шифруется `server/services/secrets.ts`. Без своего
>   ключа — ключ платформы из окружения, и он уходит **только на адрес платформы**: профиль,
>   перенаправленный тенантом на свой адрес, без своего ключа идёт без авторизации.
> - **`ai_providers_transcribe_retention_chk check (purpose <> 'transcribe' or provider_retention <> 'unknown')`** —
>   §7.7 держится и мимо сервиса (сквозная проверка 18, `42` §5); значение по умолчанию `unknown`
>   делает профиль расшифровки без явного срока невозможным. Запасной профиль — **только той же
>   роли** (`[решение]`): иначе §7.7 обходился бы одним переключением на запасной.
> - **`ref_kind` + `vacancy_generation`, `library_module`, `knowledge_article`, `search_query`** —
>   для вызовов, которые были до журнала (`ref_id` поискового запроса пуст: запрос не сущность).
> - Сверх DDL: `ai_calls.request_context jsonb` (журнал, CLAUDE.md п. 14), `ai_providers.updated_at`;
>   CHECK региона `eu | other`, адреса у сетевого драйвера, `max_latency_ms` от 1 до 300 с,
>   `billed` только у `ok` с осью, формата `input_digest`, длины `prompt_version`; индекс
>   `idx_ai_calls_tenant_provider` для «5 неудач подряд» (§8).
> - Снимка названия у пары `ref_kind`/`ref_id` (`44` В-11) нет **намеренно**: название сессии или
>   вакансии — вторая копия ПД, которая пережила бы обезличивание (§7.9).

### 3.3 Сценарий, критерии, согласие

```sql
create table interview_scenarios (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  quiz_id uuid not null references quizzes(id) on delete cascade,
  name text not null, interviewer_name text not null default 'Лола', intro_text text not null, outro_text text not null,
  answer_modes text[] not null default '{voice,text}', min_answer_sec int not null default 5, max_answer_sec int not null default 180,
  think_time_sec int not null default 15, silence_timeout_sec int not null default 45, retake_limit int not null default 2,
  record_video boolean not null default false, transcribe_lang text not null default 'uk',
  min_confidence numeric(4,3) not null default 0.600, alternative_path text not null default 'human_interview',
  status text not null default 'draft', version int not null default 1,
  created_by uuid references users(id), created_at timestamptz not null default now(),
  constraint interview_scenarios_alt_chk check (alternative_path in ('human_interview','text_form')),
  constraint interview_scenarios_modes_chk check (array_length(answer_modes,1) between 1 and 2),
  constraint interview_scenarios_status_chk check (status in ('draft','published','archived')),
  constraint interview_scenarios_time_chk check (max_answer_sec between 30 and 600 and min_answer_sec < max_answer_sec),
  unique (tenant_id, quiz_id, version));
create index idx_interview_scenarios_tenant on interview_scenarios (tenant_id, status);

create table interview_criteria (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  scenario_id uuid not null references interview_scenarios(id) on delete cascade,
  code text not null, name_uk text not null, description text not null,
  weight numeric(5,2) not null default 1, scale_max numeric(5,2) not null default 5,
  is_critical boolean not null default false, sort int not null default 0, source text not null default 'manual',
  created_at timestamptz not null default now(),
  constraint interview_criteria_source_chk check (source in ('manual','ai_suggested')),
  constraint interview_criteria_desc_chk check (length(description) between 20 and 500),
  constraint interview_criteria_weight_chk check (weight > 0 and scale_max between 2 and 100), unique (tenant_id, scenario_id, code));
create index idx_interview_criteria_tenant on interview_criteria (tenant_id, scenario_id, sort);

create table interview_consents (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  scenario_id uuid not null references interview_scenarios(id) on delete cascade,
  decision text not null, scopes jsonb not null default '{}'::jsonb,   -- {audio,video,transcript,share_with_hiring_manager}
  text_version text not null, text_hash text not null, lang text not null default 'uk',
  alternative_chosen text, ip inet, user_agent text,
  decided_at timestamptz not null default now(), withdrawn_at timestamptz,
  constraint interview_consents_decision_chk check (decision in ('accepted','declined','withdrawn')),
  constraint interview_consents_alt_chk check (alternative_chosen is null or alternative_chosen in ('human_interview','text_form')));
create index idx_interview_consents_tenant on interview_consents (tenant_id, user_id, decided_at desc);
```

`description` критерия обязателен 20–500 знаков: это определение, которое получает модель и читает человек рядом с оценкой; «Комунікабельність» без расшифровки даёт необъяснимый балл. `text_hash` фиксирует редакцию текста согласия: через год нужно доказать, **что именно** человек прочитал, а не что «согласие было». [решение] `alternative_path` не имеет значения «нет»: сценарий, который нечем заменить, опубликовать нельзя (§7.5). `interviewer_name` по умолчанию «Лола» — имя продукта; имя с эталона не переносится (правило о чужих ПД).

### 3.4 Сессия и реплики

> [исправлено фазой 1, `45-plan.md` PR-02] Ранее: колонка `media_purge_after`. Переименована в
> `purge_after` — то же имя, что и у одноимённого поля `media_assets` (`34` §3.2, `44` В-17),
> единое соглашение по всему пакету.

```sql
create table interview_sessions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  attempt_id uuid not null references attempts(id) on delete cascade,
  scenario_id uuid not null references interview_scenarios(id), candidate_id uuid not null references users(id) on delete cascade,
  consent_id uuid references interview_consents(id) on delete set null, state text not null default 'created', answer_mode text,
  turns_total int not null default 0, turns_answered int not null default 0, disconnects int not null default 0,
  resumes int not null default 0, silence_events int not null default 0, tab_switches int not null default 0,
  device text, ip inet, user_agent text, ip_changes int not null default 0,
  ai_score numeric(6,2), ai_confidence numeric(4,3), ai_verdict_text text,
  candidate_score_id uuid references candidate_scores(id) on delete set null,
  degraded_reason text, needs_human_reason text, flags jsonb not null default '[]'::jsonb,   -- антифрод, §7.17
  purge_after timestamptz, started_at timestamptz, last_activity_at timestamptz, finished_at timestamptz,
  created_at timestamptz not null default now(),
  constraint interview_sessions_state_chk check (state in ('created','consent_pending','in_progress','paused','submitted',
    'transcribing','scoring','scored','needs_human','abandoned','expired','failed')),
  constraint interview_sessions_degr_chk check (degraded_reason is null or degraded_reason in ('provider_down','limit_exhausted',
    'transcribe_failed','low_confidence','consent_withdrawn','timeout')), unique (tenant_id, attempt_id));
create index idx_interview_sessions_tenant on interview_sessions (tenant_id, state, created_at desc);
create index idx_interview_sessions_tenant_cand on interview_sessions (tenant_id, candidate_id, created_at desc);
create index idx_interview_sessions_tenant_purge on interview_sessions (tenant_id, purge_after) where purge_after is not null;

create table interview_turns (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  session_id uuid not null references interview_sessions(id) on delete cascade,
  attempt_answer_id uuid references attempt_answers(id) on delete set null,
  ordinal int not null, role text not null, question_id uuid, question_version int, prompt_text text,
  answer_mode text, media_id uuid references media_assets(id) on delete set null,
  duration_ms int, silence_ms int, retakes int not null default 0, first_sound_delay_ms int,
  transcript text, transcript_lang text, transcript_confidence numeric(4,3), transcript_engine text,
  transcript_version int not null default 1, transcript_status text not null default 'pending',
  started_at timestamptz, submitted_at timestamptz,
  constraint interview_turns_role_chk check (role in ('interviewer','candidate')),
  constraint interview_turns_mode_chk check (answer_mode is null or answer_mode in ('voice','text','none')),
  constraint interview_turns_tr_chk check (transcript_status in ('pending','ok','low_confidence','failed','skipped','manual','not_needed')),
  unique (tenant_id, session_id, ordinal));
create index idx_interview_turns_tenant on interview_turns (tenant_id, session_id, ordinal);
create index idx_interview_turns_tenant_media on interview_turns (tenant_id, media_id) where media_id is not null;
```

[решение] Расшифровка живёт **в реплике**, а не отдельной таблицей: она всегда одна на реплику и всегда нужна вместе с ней. Повторная расшифровка увеличивает `transcript_version` и перезаписывает текст; предыдущая остаётся в `ai_calls.output` — там, где и должна быть история машинных выводов.

### 3.5 Оценка по критерию и Підсумок кандидата

```sql
create table interview_criterion_scores (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  session_id uuid not null references interview_sessions(id) on delete cascade,
  criterion_id uuid not null references interview_criteria(id) on delete cascade,
  value numeric(5,2), confidence numeric(4,3) not null, rationale text not null,
  evidence jsonb not null default '[]'::jsonb,        -- [{turn_id, ordinal, quote, char_from, char_to, ms_from}]
  ai_call_id bigint references ai_calls(id) on delete set null,
  human_value numeric(5,2), human_by uuid references users(id) on delete set null, human_at timestamptz, human_comment text,
  agreement text not null default 'pending', created_at timestamptz not null default now(),
  constraint ics_agreement_chk check (agreement in ('pending','match','minor','major')),
  constraint ics_rationale_chk check (length(rationale) between 20 and 2000),
  constraint ics_evidence_chk check (jsonb_array_length(evidence) >= 1), unique (tenant_id, session_id, criterion_id));
create index idx_interview_criterion_scores_tenant on interview_criterion_scores (tenant_id, session_id);
create index idx_interview_criterion_scores_tenant_agr on interview_criterion_scores (tenant_id, agreement) where agreement <> 'pending';

create table candidate_summaries (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  candidate_id uuid not null references users(id) on delete cascade, vacancy_id uuid, version int not null default 1,
  state text not null default 'draft', completeness text not null default 'partial',
  body jsonb not null, sections jsonb not null default '[]'::jsonb, lang text not null default 'uk',
  generated_by text not null default 'ai', ai_call_id bigint references ai_calls(id) on delete set null,
  edited_by uuid references users(id) on delete set null, edited_at timestamptz,
  media_id uuid references media_assets(id) on delete set null,          -- PDF, origin='ai_artifact'
  share_token text unique, share_expires_at timestamptz, auto_send_rule jsonb, auto_send_due_at timestamptz,
  sent_at timestamptz, sent_channel text, sent_by uuid references users(id) on delete set null,
  revoked_at timestamptz, revoke_reason text, created_at timestamptz not null default now(),
  constraint candidate_summaries_state_chk check (state in ('draft','ready','sent','revoked','expired')),
  constraint candidate_summaries_compl_chk check (completeness in ('full','partial')),
  constraint candidate_summaries_gen_chk check (generated_by in ('ai','ai_edited','manual')), unique (tenant_id, candidate_id, version));
create index idx_candidate_summaries_tenant on candidate_summaries (tenant_id, candidate_id, version desc);
create index idx_candidate_summaries_tenant_due on candidate_summaries (tenant_id, auto_send_due_at) where state = 'ready';
```

[решение] `rationale` и минимум одна цитата в `evidence` — **ограничения БД, а не пожелание интерфейса**. Оценка, которую нечем объяснить, физически не сохраняется, а сессия уходит в `needs_human` (§7.2). Это самый дешёвый способ сделать правило §7.1 неотключаемым.

### 3.6 Подсказка проверяющему и контроль качества

```sql
create table ai_review_hints (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  target_kind text not null, target_id uuid not null, user_id uuid not null references users(id) on delete cascade,
  reviewer_id uuid references users(id) on delete set null,
  key_source jsonb not null,                          -- {question_id, question_version, module_ids[], criteria_ids[]}
  matched jsonb not null default '[]'::jsonb,         -- [{key_point, quote, char_from, char_to}]
  missing jsonb not null default '[]'::jsonb,         -- [{key_point}]
  contradictions jsonb not null default '[]'::jsonb,  -- [{key_point, quote, why}]
  coverage numeric(4,3), confidence numeric(4,3), ai_call_id bigint references ai_calls(id) on delete set null,
  state text not null default 'ready', shown_at timestamptz, reviewer_decision jsonb, reviewer_decided_at timestamptz,
  agreement text not null default 'pending', created_at timestamptz not null default now(),
  constraint ai_review_hints_target_chk check (target_kind in ('attempt_answer','workshop_submission')),
  constraint ai_review_hints_state_chk check (state in ('queued','ready','failed','skipped','degraded')),
  constraint ai_review_hints_agree_chk check (agreement in ('pending','match','minor','major','not_shown')),
  unique (tenant_id, target_kind, target_id));
create index idx_ai_review_hints_tenant on ai_review_hints (tenant_id, state, created_at desc);
create index idx_ai_review_hints_tenant_agr on ai_review_hints (tenant_id, agreement, created_at desc);

create table ai_quality_reviews (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id) on delete cascade,
  ref_kind text not null, ref_id uuid not null, sampled_by text not null default 'auto', sample_reason text,
  auditor_id uuid references users(id) on delete set null, verdict text, notes text,
  created_at timestamptz not null default now(), reviewed_at timestamptz,
  constraint aqr_ref_chk check (ref_kind in ('interview_criterion_score','review_hint','summary')),
  constraint aqr_verdict_chk check (verdict is null or verdict in ('correct','minor_error','major_error','harmful')),
  unique (tenant_id, ref_kind, ref_id));
create index idx_ai_quality_reviews_tenant on ai_quality_reviews (tenant_id, verdict, created_at desc);
```

[решение] **В `ai_review_hints` намеренно нет полей `is_correct`, `score`, `verdict`, `passed`.** Подсказка структурно неспособна вынести вердикт: она умеет сказать только «этот пункт ключа прозвучал вот здесь», «этот пункт не прозвучал», «здесь сказано противоположное». Убрать поля дешевле, чем потом запрещать их показ.

### 3.7 Изменения существующих таблиц

```sql
alter table quizzes add column mode text not null default 'quiz', add constraint quizzes_mode_chk check (mode in ('quiz','interview'));
alter table attempt_answers add column input_mode text not null default 'text',
  add constraint attempt_answers_input_mode_chk check (input_mode in ('text','voice','video','file'));
```

Патч `П-30.1` к `34`: в `media_assets_origin_chk` добавляется `'interview_answer'`; политика по умолчанию — 3 мес. от `created_at`, действие `purge`, `keep_evidence=false` (§7.7). Оси `ai_interview_ops` и `ai_review_ops` определены в `35` §7.1 и здесь не переопределяются.

---

## 4. Состояния и переходы

```
created → consent_pending → in_progress ⇄ paused → submitted → transcribing → scoring → scored
                 ↓ (відмова)      ↓                                  ↓            ↓
          альт. шлях §7.5    abandoned / expired / failed        needs_human ←────┘
```

| Из | В | Кто/что | Условие | Последствие |
|---|---|---|---|---|
| `created` | `consent_pending` | кандидат открыл модуль | сценарий `published` | показан экран согласия |
| `consent_pending` | `in_progress` | кандидат | `decision='accepted'` | создаётся `attempts`, резервируется 1 `ai_interview_ops` |
| `consent_pending` | — | кандидат | `decision='declined'` | сессия не создаётся, назначение идёт по `alternative_path` (§7.5) |
| `in_progress` | `paused` | обрыв связи, уход со страницы | — | `disconnects+1`, таймер попытки идёт по `12` §3.5 |
| `paused` | `in_progress` | возврат кандидата | попытка не истекла | `resumes+1`, продолжение с незавершённой реплики |
| `in_progress` | `submitted` | последняя реплика или «Завершити» | ≥1 отвеченная реплика | `attempts.status='submitted'` |
| `submitted` | `transcribing` → `scoring` | фоновые задачи | есть голосовые реплики | — |
| `transcribing` | `needs_human` | — | ≥1 реплика `failed` либо средняя уверенность < `min_confidence` | `degraded_reason` |
| `scoring` | `scored` | оценка получена | у каждого критерия есть `rationale` и цитата | пишется `candidate_scores.kind='ai'` |
| `scoring` | `needs_human` | — | провайдер недоступен, лимит исчерпан, оценка без обоснования | `candidate_scores` не пишется |
| `in_progress` | `abandoned` | `interview.reap` | нет активности 24 ч | попытка не аннулируется, рекрутер уведомлён |
| любое | `expired` | дедлайн назначения | — | по правилам `12` §4 |

[решение] `needs_human` — **не провал и не ошибка кандидата**, а состояние системы: попытка остаётся зачтённой как «проходження відбулося», кандидат видит «Відповіді надіслано», рекрутер — плашку «Оцінку ШІ не сформовано — потрібне рішення людини» с причиной.

**Підсумок:** `draft → ready → sent`; `ready|sent → revoked` (отзыв ссылки); `sent → expired` (истёк `share_expires_at`). Новая генерация создаёт `version+1`; старые версии видны рекрутеру и недоступны по ссылке.
**Подсказка:** `queued → ready →` (показана) `→ agreement`, либо `queued → failed | degraded | skipped`. `agreement` вычисляется при фиксации решения ментора (§7.13); `not_shown` ставится, если ментор решил, не раскрыв панель, — такие случаи ценны как контроль.

---

## 5. Экраны

**5.1 Согласие кандидата — `/interview/:sessionId/consent`.** Заголовок «Електронна співбесіда», далее шесть строк с иконками: «Співбесіду проводить програма, а не людина.» · «Ваші відповіді буде записано (аудіо) та розшифровано в текст.» · «Запис і розшифровку побачать рекрутер і керівник, який ухвалює рішення. Більше ніхто.» · «Аудіо зберігається {N} днів, текст — до {дата}.» · «Оцінку програми перевіряє людина. Сама програма нікого не відхиляє.» · «Ви можете відмовитись — це не закриває для вас відбір.» Кнопки «Погоджуюсь і починаю» (солнечная) и «Не погоджуюсь» (вторичная, нормальным кеглем — равнозначный выбор, не «серая мелкая»). Ссылка «Повний текст згоди». Загрузка — скелет из 6 строк; ошибка — «Не вдалося відкрити співбесіду» + «Спробувати ще».

**5.2 Собеседование — `/interview/:sessionId`.** Шаг 0 — проверка микрофона: «Скажіть кілька слів, щоб перевірити мікрофон», индикатор уровня, кнопка «Мікрофон працює»; при отсутствии доступа — «Немає доступу до мікрофона. Можна відповідати текстом» с переключением в `answer_mode='text'` без потери сессии. Основной экран: «Питання 3 з 8»; реплика интервьюера текстом и аудио; таймер обдумывания; «Записати відповідь» → «Зупинити»; счётчик длительности с подсветкой сверх `max_answer_sec`; «Перезаписати (залишилось N)»; «Відповісти текстом»; «Далі». В шапке постоянно — «Запис ведеться» и «Припинити співбесіду». Финал: «Дякуємо! Ваші відповіді надіслано. Результат надійде на пошту протягом кількох днів.» (формулировка по смыслу снята с эталона, без обещания конкретного часа). Деградация видна одной строкой без техники: «Зараз не вдалося обробити відповіді — з вами зв'яжеться рекрутер. Ваше проходження збережено.»

**5.3 Карточка кандидата, вкладка «Співбесіда».** Верх: общая оценка ИИ, уверенность словом («висока / середня / низька»), дата, модель и версия промпта мелким шрифтом, плашка «Це оцінка програми. Рішення ухвалює людина.» Критерии карточками: название, балл, обоснование, 1–3 цитаты-кнопки — клик проматывает плеер к секунде и подсвечивает фрагмент расшифровки; кнопка «Не погоджуюсь» (форма §6.4). Ниже — плеер (только `interview.listen`), полная расшифровка с таймкодами, блок «Що варто перевірити людині» (флаги §7.17), метрики сессии (обрывы, перезаписи, паузы). Пусто: «Співбесіду не призначено». Ошибка расшифровки: «Розшифровку не отримано» + доступное аудио.

**5.4 Підсумок кандидата — `/candidates/:id/summary`.** Шапка: «Підсумок кандидата», бейдж «Неповне проходження» при `completeness='partial'`, версия, дата. Тело — секции §7.14, каждую можно выключить перед отправкой. Действия: «Сформувати заново», «Редагувати», «Надіслати кандидату», «Скопіювати посилання», «Відкликати доступ». Внизу несъёмная строка: «Документ сформовано автоматично на основі відповідей кандидата. Оцінки програми перевірено людиною: {так/ні}.»

**5.5 Карточка проверки с подсказкой — дополнение к `13` §5.3.** Справа от критериев свёрнутая панель «Підказка ШІ» с меткой «Це не оцінка», раскрывается кликом (`shown_at`). Внутри три списка: «Збіглося з ключем» (бирюзовые пункты с цитатами), «Не згадано» (серые), «Суперечить ключу» (коралловые с цитатой и пояснением), внизу «Покриття ключа: 4 з 6». Кнопки решения ментора не меняются. Нет подсказки — «Підказку не сформовано, перевірте відповідь самостійно» (причина видна админу).

**5.6 Настройки — `/settings/interviews`, `/settings/ai`.** Список сценариев: название, трек, критериев, собеседований проведено, доля `needs_human`, среднее расхождение с человеком. `/settings/ai`: профили провайдеров, срок ИИ-подписки (`ai_until` из `35`), переключатели трёх функций, журнал ИИ-вызовов с фильтрами (назначение, статус, период, стоимость), «Вивантажити журнал».

---

## 6. Формы

### 6.1 Сценарий собеседования

| Поле | Контрол | Обяз. | Подсказка | Валидация | Ошибка (uk) |
|---|---|:-:|---|---|---|
| Назва | текст | ✓ | — | 3–200 | «Назва від 3 символів» |
| Трек і модуль | селект | ✓ | — | тест с `mode='interview'` | «Оберіть модуль співбесіди» |
| Ім'я інтерв'юера | текст | ✓ | «Так програма представиться кандидату» | 2–40 | «Вкажіть ім'я» |
| Вітальний текст | textarea | ✓ | «Перше, що почує кандидат» | 50–1500 | «Від 50 символів» |
| Прощальний текст | textarea | ✓ | — | 20–800 | «Від 20 символів» |
| Формат відповіді | чекбоксы «Голос» / «Текст» | ✓ | «Текст потрібен тим, у кого немає мікрофона» | ≥1 | «Оберіть хоча б один формат» |
| Макс. тривалість відповіді | число, сек | ✓ | — | 30–600 | «Від 30 до 600 секунд» |
| Час на обдумування | число, сек | ✓ | — | 0–120 | «Від 0 до 120 секунд» |
| Дозволено перезаписів | число | ✓ | — | 0–5 | «Від 0 до 5» |
| Записувати відео | переключатель | — | «Вимкнено за замовчуванням, потребує окремої згоди кандидата» | — | — |
| Мова розшифровки | селект | ✓ | — | из языков тенанта | — |
| Мінімальна впевненість | число | ✓ | «Нижче порога оцінку не формуємо, а передаємо людині» | 0.3–0.95 | «Від 0.3 до 0.95» |
| Альтернативний шлях | радио «Співбесіда з людиною» / «Письмова форма» | ✓ | «Що запропонуємо кандидату, який відмовився» | — | «Оберіть альтернативу» |

**6.2 Критерий.** Назва (3–100) · Опис (20–500, «Опишіть, що саме вважається сильною відповіддю») · Вага (0.1–10) · Максимальний бал (2–100) · «Критичний» (переключатель). Над списком — «Згенерувати критерії (ШІ)»: созданные помечаются `source='ai_suggested'` и требуют подтверждения каждого — «Перевірте та збережіть: критерії створено програмою». Ошибки: «Додайте хоча б один критерій», «Опис критерію від 20 символів».

**6.3 Отказ от ИИ-собеседования (кандидат).** «Ви не погодились на електронну співбесіду. Це нормально і не впливає на ваші шанси.» Радио с заданной сценарием альтернативой: «Співбесіда з рекрутером — з вами зв'яжуться протягом 3 робочих днів» / «Письмова форма — ті самі питання текстом, без запису». Поле «Зручний час для дзвінка» (необяз., 0–200). Кнопка «Надіслати», далее «Дякуємо, рекрутер отримав ваш вибір».

**6.4 Несогласие с оценкой ИИ (рекрутер).** Критерий (предзаполнен) · «Ваш бал» (в шкале критерия, обяз.) · «Чому» (10–1000, обяз., подсказка «Цей текст побачить лише команда, він потрібен для перевірки якості моделі») · чекбокс «Позначити як грубу помилку моделі». Пишет `human_value`, `agreement`, при чекбоксе — `ai_quality_reviews` с `verdict='major_error'`.

**6.5 Авто-отправка Підсумку (настройки компании).** Чекбокс «Надсилати неповний Підсумок кандидата після завершення відбору» · селект «Надсилати після отримання оцінки:» с четырьмя видами из `28` §3.4 («Оцінка», «Оцінка ТЗ», «Оцінка ШІ», «Оцінка рекрутера») · «Мінімальний бал» · «Затримка перед відправкою, годин» (1–168, по умолчанию 24) · чекбокс «Не надсилати відхиленим кандидатам» (включён).

---

## 7. Правила и алгоритмы

1. **ИИ не принимает решений о людях.** Ни один вывод модели не меняет `candidate_state`, `candidate_status_id`, `attempts.status`, `attempt_answers.is_correct`, `workshop_submissions.status` и не создаёт отказ. Единственный канал записи вывода в карточку — `candidate_scores` с `kind='ai'` (`28` §3.4): **одно число рядом с тремя человеческими, а не вместо них.** Автоматический отказ запрещён `28` §7.4, и настоящий документ его не смягчает ни при каком балле.
2. **Что обязано быть показано рядом с оценкой ИИ.** Балл бесполезен без четырёх вещей, и все четыре обязательны: (а) `rationale` — текстовое обоснование; (б) `evidence` — минимум одна цитата из расшифровки с таймкодом и переходом к аудио; (в) `confidence` словом («висока» ≥0.8, «середня» 0.6–0.8, «низька» <0.6); (г) техпаспорт — модель, версия промпта, дата. Балл без обоснования или без цитаты **не сохраняется** (ограничения §3.5), сессия уходит в `needs_human`.
3. **Оспаривание.** У каждого критерия кнопка «Не погоджуюсь» (§6.4). Человеческое значение пишется в `human_value`, `agreement` считается сразу: `|human − ai| ≤ 10 %` шкалы → `match`, ≤30 % → `minor`, иначе `major`. Строка `candidate_scores.kind='ai'` при переопределении **не переписывается**: создаётся новая `kind='manual'` авторства человека. Затирать машинную оценку человеческой нельзя — теряется материал для §7.16.
4. **Согласие до начала.** Экран §5.1 показывается до создания `attempts`, всегда, на языке `users.comm_language`. Фиксируется строкой `interview_consents` с `text_version`, `text_hash`, `scopes`, IP и user-agent; без строки `decision='accepted'` сессия не переходит в `in_progress` — проверка на сервере, не в интерфейсе. Согласие на обработку ПД (`28` §3.2, `consent_given_at`) **не заменяет** это согласие: там обработка анкеты, здесь запись голоса.
5. **Отказ не закрывает отбор.** При `declined` сессия не создаётся, назначение остаётся активным и переключается на `alternative_path`: `human_interview` — рекрутеру уходит `interview.declined` с пометкой «потрібна жива співбесіда», кандидат в статусе `on_review`; `text_form` — те же вопросы сценария открываются обычным тестом с ручной проверкой (`12` §3.3 `text_long`, очередь `13` §5.2). Сценарий без альтернативы не публикуется: `422 scenario.alternative_required`. Отказ **не пишется в оценки** и не виден в Підсумку как минус; в истории кандидата — нейтральная строка «Обрав альтернативний формат співбесіди».
6. **Отзыв согласия.** «Припинити співбесіду» доступна на каждом шаге. При отзыве: `decision='withdrawn'`, сессия → `abandoned`, аудио всех реплик немедленно в `lifecycle='pending_delete'`, расшифровки удаляются, оценка не формируется, попытка не считается проваленной, рекрутер уведомлён. Отзыв после завершения (по ссылке из письма) делает то же и дополнительно отзывает Підсумок.
7. **Что хранится и сколько.** Аудио реплики — `media_assets`, `origin='interview_answer'`, `is_evidence=false`, `purge_after = finished_at + 90 днів`, но не позже `users.consent_expires_at`; действие `purge`, не `soft_delete`. Видео — только при `record_video=true` и отдельном `scopes.video`, по умолчанию выключено. Расшифровка и оценки живут до обезличивания кандидата (`28` §7.9). Вход ИИ-вызова в S3 — 90 дней. PDF Підсумку — `origin='ai_artifact'`, 12 мес. (`34` §7.3), но стирается раньше при обезличивании. [решение] Аудио живёт заметно меньше расшифровки: для решения о найме и его разбора достаточно текста, а голос — самые чувствительные данные в продукте. Провайдер с `provider_retention='unknown'` не допускается для `transcribe`: нельзя отдавать голос туда, где неизвестен срок хранения.
8. **Доступ к записи.** Аудио отдаётся предподписанной ссылкой на 15 минут, только `interview.listen`, каждое прослушивание пишется в `audit_log` (`interview.media.listen`: кто, когда, чья запись). Скачивание файла запрещено всем ролям: доступ есть, выноса нет.
9. **Обезличивание.** При `28` §7.9 или отзыве согласия: аудио и видео — `purge` немедленно; `interview_turns.transcript`, `prompt_text`, `interview_criterion_scores.rationale` и `evidence`, `candidate_summaries.body` и PDF — удаляются; остаются баллы, `confidence`, `agreement`, метрики сессии и строки `ai_calls` без `input_ref` — то, что нужно статистике и не идентифицирует человека. Необратимо, пишется в `audit_log`.
10. **Расшифровка.** Язык из сценария; при расхождении языка ответа ставится флаг, но расшифровка выполняется. `transcript_confidence < min_confidence` → `low_confidence`: реплика помечается «Розшифровка ненадійна» и исключается из `evidence`. Два повтора (через 5 и 30 минут), затем `failed`.
11. **Оценка.** Один вызов на сессию; вход — расшифровки всех реплик и определения критериев; выход по критерию: `value`, `confidence`, `rationale`, `evidence`. Итог сессии — взвешенное среднее по `weight`, нормированное к 100. `ai_confidence` — **минимум** по критериям, не среднее: сессия настолько надёжна, насколько ненадёжен худший критерий.
12. **Деградация. Кандидат не теряет прохождение из-за нашей инфраструктуры.**

| Сбой | Что делает система | Что видит кандидат |
|---|---|---|
| Провайдер недоступен | `fallback_provider_id`, затем 3 ретрая (1/5/30 мин), затем `needs_human`, `degraded_reason='provider_down'` | ничего до финала; на финале «Відповіді збережено» |
| `ai_interview_ops` исчерпан | новая сессия не стартует, назначение идёт по `alternative_path`, админу `ai_ops_exhausted` (`35`); начатая доводится и дооценивается после пополнения | «Зараз співбесіду проводить рекрутер» |
| `ai_review_ops` исчерпан | подсказка `state='degraded'`, задание идёт в обычную очередь `13` | ничего: это не его экран |
| Расшифровка не удалась | 2 повтора, затем `needs_human`; аудио сохранено, рекрутер слушает сам | «З вами зв'яжеться рекрутер» |
| Кандидат молчит | 3 подсказки «Не чути вас. Спробуйте ще раз» через 15/30/45 с, затем реплика `answer_mode='none'`, переход дальше | подсказки на экране |
| Обрыв связи | автосохранение каждые 5 с, `paused`, возврат с той же реплики, `disconnects+1` | «Зв'язок відновлено, продовжуємо» |
| Закрыл вкладку и не вернулся | 24 ч → `abandoned`, попытка не сгорает, рекрутеру уведомление | письмо «Співбесіду не завершено, посилання діє до {дата}» |

  [решение] Лимит `ai_interview_ops` резервируется при переходе в `in_progress` и списывается один раз за сессию; повторная расшифровка, переоценка после сбоя и перегенерация Підсумку **не тарифицируются**: тенант не платит дважды за наш сбой.
13. **Помощь проверяющему.** Триггер — новый `attempt_answers` типа `text_long` или `workshop_submissions.status='submitted'` при включённой функции и живой ИИ-подписке. Вход: ответ человека, контрольный ключ (эталонный ответ и критерии из `12` §3.3 и `13` §3.1), текст модуля. Выход — только три списка (§3.6). Формулировки: «Збіглося з ключем», «Не згадано», «Суперечить ключу» — никаких «правильно», «невірно», «зарахувати». Оценку ставит ментор, значения подсказки в его форму не подставляются. При решении ментора пишутся `reviewer_decision` и `reviewer_decided_at`, `agreement` считается сопоставлением: зачёт при `coverage ≥ 0.8` или незачёт при `coverage ≤ 0.4` → `match`; зачёт при `coverage ≤ 0.4` или незачёт при `coverage ≥ 0.8` → `major`; остальное → `minor`; панель не раскрыта → `not_shown`.
14. **Підсумок кандидата.** Семь секций: (1) кто и на какую вакансию; (2) пройденный контент и результаты из `28` §5.3; (3) три-четыре оценки с авторами и датами; (4) собеседование: по каждому критерию балл, обоснование, ключевая цитата; (5) сильные стороны и зоны риска — единственная генеративная секция, всегда с оговоркой; (6) что осталось непройденным при `completeness='partial'`; (7) техпаспорт: дата, модель, версия промпта, «перевірено людиною: так/ні». Видят рекрутер, HR, админ и керівник своей точки; кандидат — только после явной или авто-отправки. Подпись «Документ сформовано автоматично» входит в `body` и в PDF и не отключается настройкой тенанта.
15. **Авто-отправка** (условие с эталона, §6.5) срабатывает, когда указанная оценка достигла порога **и** прошла задержка `auto_send_due_at`. Не отправляется, если кандидат `rejected` при включённом чекбоксе, если согласие отозвано, если `state <> 'ready'`, если ни один критерий не перепроверен человеком **и** `ai_confidence < 0.6`. Ссылка живёт 30 дней. [решение] Задержка обязательна и не может быть нулевой: отправка «сразу после оценки» не оставляет рекрутеру возможности остановить документ, которого он ещё не видел.
16. **Качество и аудит.** Каждый вызов — строка `ai_calls` (модель, версия промпта, дайджест входа, выход, стоимость, задержка, статус). Задача `ai.quality_sample` ежедневно отбирает **5 % оценок критериев и 5 % подсказок**, плюс **все** `agreement='major'` и все `confidence < 0.5`, и ставит их в очередь админу. Метрика расхождения — доля `major` и `minor` за 30 дней в разрезе `prompt_version`, критерия и ментора; рост доли `major` выше 15 % даёт `ai.quality_degraded`. Смена `prompt_version` обнуляет накопленную метрику: сравнивать версии промпта между собой нельзя.
17. **Антифрод: что система фиксирует честно.** В `interview_sessions.flags` пишутся только измеримые факты: `read_aloud` — расшифровка совпадает с текстом модуля или вопроса более чем на 70 % (шингловое сходство); `too_fast` — ответ начат раньше 1,5 с после вопроса при длине ответа > 200 знаков; `duplicate_answer` — сходство с ответом другого кандидата на тот же вопрос > 85 %; `ip_changed`; `device_changed`; `tab_switches > 5` (механизм `proctoring='tab_switch'`, `12` §3.5); `long_silence_pattern`; `lang_mismatch`. **Чего система не делает и не обещает.** Не определяет по голосу, тот ли это человек: голосовой биометрии в продукте нет и не планируется. Не определяет по видео или движению глаз, читает ли кандидат с экрана. Не утверждает, что ответ написан другой моделью: надёжных детекторов не существует, а ложное обвинение дороже пропущенного обмана. Ни один флаг не влияет на балл, не блокирует прохождение и не показывается кандидату — это материал для человека, и подписан он именно так: «Що варто перевірити людині».
18. **Идемпотентность.** Каждый вызов идёт с `Idempotency-Key` = `sha256(tenant_id, ref_kind, ref_id, prompt_key, prompt_version, try_no)`; повтор с тем же ключом возвращает сохранённый `ai_calls.output` и не тратит лимит.
    > [исправлено, PR-27: без `prompt_key` два разных промпта одной версии над одной сущностью делили бы один сохранённый ответ] Ранее: «`sha256(tenant_id, ref_kind, ref_id, prompt_version, try_no)`». Сохранённый ответ отдаётся только при совпадении `input_digest`: другой вход под тем же ключом — другой вызов, а не повтор. Вызов без `ref_id` (поисковый запрос) и эмбеддинг (вектор в журнале не хранится) не кешируются.
19. **Язык.** Интервьюер говорит на `users.comm_language`; расшифровка — на языке сценария; оценка и Підсумок формируются на языке тенанта, Підсумок для кандидата — на его языке; при отсутствии перевода критерия берётся `name_uk` с пометкой.
20. **ИИ-подписка истекла** (`ai_status='expired'`, `35` §7): новые сессии не стартуют, назначения идут альтернативным путём, подсказки не формируются, собранные Підсумки читаются и отправляются, «Оцінка ШІ» у новых кандидатов пуста и подписана «Підписку на ШІ завершено».

---

## 8. Уведомления

| Код | Событие | Канал | Кому | Шаблон (uk), кратко |
|---|---|---|---|---|
| `interview.invited` | назначен модуль собеседования | email, Telegram | кандидату | «Наступний крок відбору — електронна співбесіда, близько {N} хв. Посилання діє до {дата}.» |
| `interview.declined` | отказ от ИИ | in-app, email | рекрутеру | «{Кандидат} обрав альтернативний формат: {альтернатива}.» |
| `interview.abandoned` | 24 ч без активности | email | кандидату | «Співбесіду не завершено. Посилання діє до {дата}.» |
| `interview.completed` | сессия `scored` | in-app, email | рекрутеру | «{Кандидат} завершив співбесіду. Оцінка ШІ: {бал}. Потрібне рішення людини.» |
| `interview.needs_human` | `needs_human` | in-app, email | рекрутеру | «Оцінку не сформовано: {причина}. Відповіді збережено.» |
| `interview.consent_withdrawn` | отзыв согласия | in-app, email | рекрутеру, HR | «{Кандидат} відкликав згоду. Записи видалено.» |
| `interview.result_ready` | Підсумок отправлен | email | кандидату | «Дякуємо за участь. За посиланням — підсумок вашої співбесіди. Документ сформовано автоматично.» |
| `summary.auto_send_scheduled` | сработало условие §7.15 | in-app | рекрутеру | «Підсумок кандидата {ім'я} буде надіслано {час}. Можна скасувати.» |
| `ai.review_hint_failed` | 3 неудачи подряд | in-app | админу | «ШІ-підказка не формується. Перевірте налаштування провайдера.» |
| `ai.quality_degraded` | доля `major` > 15 % за 30 дней | email, in-app | админу | «Розбіжність оцінок ШІ та людини зросла до {X} %.» |
| `ai.provider_down` | 5 неудач подряд | in-app | админу | «Провайдер {назва} недоступний. Співбесіди йдуть альтернативним шляхом.» |

Кандидат не получает уведомлений о флагах антифрода, расхождении оценок и внутренней деградации — только о ходе собеседования и о результате (согласовано с `28` §8).

> [дополнено, PR-27] `ai.provider_down` заведён кодом `ai_provider_down` — реестр шаблонов
> (`DEFAULT_TEMPLATES`) весь в `snake_case`; шлёт шлюз после пятого отказа профиля подряд, раз в
> сутки на профиль и адресата. Текст обобщён («Функції ШІ йдуть запасним шляхом»): профиль
> обслуживает не только собеседование, а «Співбесіди йдуть альтернативним шляхом» верно лишь для него.

---

## 9. Отчёты и выгрузки

1. **Воронка собеседований.** Назначено · согласились · отказались · завершили · `needs_human` · средний балл · медиана длительности. Фильтры: период, вакансия, точка, сценарий.
2. **Согласия.** Доля отказов от ИИ по вакансиям и языку кандидата, распределение выбранных альтернатив. Рост отказов — сигнал, что текст согласия пугает.
3. **Качество модели.** `prompt_version` · оценок · доля `match`/`minor`/`major` · средняя `confidence` · доля `needs_human`; разрез по критериям — какой критерий модель понимает хуже.
4. **Помощь проверяющему.** Ментор · проверок · подсказок показано · `agreement` · среднее время проверки с подсказкой и без. Главный вопрос отчёта — ускоряет ли подсказка на самом деле.
5. **Стоимость ИИ.** По `purpose` и по дням: вызовов, токенов, `cost_minor`, средняя задержка, доля ошибок. CSV/XLSX.
6. **Выгрузка собеседований.** Кандидат, сценарий, дата, длительность, баллы по критериям, уверенность, флаги, `agreement`. **Расшифровки и ссылки на аудио в выгрузку не попадают никогда** — выноса голосовых ответов из системы не предусмотрено. Факт выгрузки пишется в `audit_log` с числом строк.

---

## 10. API

| Метод | Путь | Вход | Выход | Ошибки |
|---|---|---|---|---|
| GET | `/interviews/:sessionId` | — | состояние, текущая реплика | `404`, `409 interview_consent.required` |
| POST | `/interviews/:sessionId/consent` | `{decision, scopes, text_version, alternative?}` | сессия либо альтернатива | `422 consent.invalid`, `409 interview_consent.already_decided` |
| POST | `/interviews/:sessionId/start` | `{answer_mode}` | первая реплика | `409 limit.ai_interview_exhausted`, `409 interview_consent.required` |
| POST | `/interviews/:sessionId/turns/:ordinal/upload` | multipart audio ≤25 МБ | `{media_id, duration_ms}` | `413 media.too_big`, `422 turn.closed` |
| POST | `/interviews/:sessionId/turns/:ordinal/answer` | `{mode, media_id?, text?}` | следующая реплика | `422 answer.empty`, `409 retake.limit` |
| POST | `/interviews/:sessionId/finish` \| `/withdraw` | — \| `{reason?}` | `{state}` \| `204` | `409 no_answers`, `404` |
| GET | `/candidates/:id/interview` | — | сессия, критерии, расшифровка, флаги | `403 forbidden`, `404` |
| GET | `/candidates/:id/interview/media/:turnId` | — | `{url, expires_at}` | `403 forbidden`, `410 media.purged` |
| POST | `/candidates/:id/interview/criteria/:criterionId/override` | `{human_value, human_comment, major?}` | оценка | `422`, `409 session.not_scored` |
| POST | `/candidates/:id/interview/rescore` | `{reason}` | `{ai_call_id}` | `409 limit`, `403` |
| GET \| POST | `/candidate-summaries` | фильтры \| `{candidate_id, sections?}` | список \| Підсумок | `409 summary.no_data` |
| PATCH | `/candidate-summaries/:id` | `{body, sections}` | Підсумок, `generated_by='ai_edited'` | `409 summary.sent` |
| POST | `/candidate-summaries/:id/send` \| `/revoke` | `{channel, expires_days}` \| `{reason}` | `{sent_at, share_token}` \| `204` | `422 contact.missing`, `409 consent.withdrawn` |
| GET | `/api/v1/public/candidate-summaries/[token]` | — | документ без ПД третьих лиц | `410 expired`, `404` |
| GET | `/review-hints/:targetKind/:targetId` | — | подсказка, ставит `shown_at` | `404 hint.absent`, `409 hint.degraded` |
| GET \| PUT | `/interview-scenarios[/:id]` | форма §6.1 | сценарий | `422 scenario.alternative_required` |
| GET \| POST | `/interview-scenarios/:id/criteria` | форма §6.2 | критерии | `422 criteria.required` |
| POST | `/interview-scenarios/:id/criteria/generate` | `{count}` | предложенные, `source='ai_suggested'` | `409 limit.ai_generate_exhausted` |
| GET | `/ai/calls` | фильтры, `cursor` | журнал | `403 forbidden` |
| GET \| PUT | `/ai/providers[/:id]` | форма §3.2 | профили | `422 provider.retention_unknown` |
| GET \| POST | `/ai/quality-reviews[/:id]` | `{verdict, notes}` | перепроверки | `403` |

Чужой тенант по любому пути — `404`. Загрузка аудио идёт предподписанной ссылкой прямо в S3, через API проходят только метаданные.

> [дополнено, PR-27] Строка `GET | PUT /ai/providers[/:id]` развёрнута так: `GET /ai/providers`,
> `POST /ai/providers` (новый профиль — например, запасной: профилей платформы по одному на роль, и
> запасному без второй строки той же роли неоткуда взяться), `GET /ai/providers/:id`,
> `PUT /ai/providers/:id` (переданные поля; `apiKey` — только на запись, `null` снимает свой ключ).
> Коды профиля: `422 provider.retention_unknown`, `422 provider.endpoint_required`,
> `422 provider.endpoint_invalid` (только `https` и не внутренняя сеть — иначе форма профиля
> становится сканером нашей инфраструктуры), `422 provider.region_comment_required`,
> `422 provider.fallback_self | fallback_not_found | fallback_purpose | fallback_cycle | fallback_depth`,
> `409 provider.code_taken`. Ручки, которые вызывают модель, отвечают `409 ai.unavailable`
> (`details.reason`: `expired | off | readonly | suspended` — `35` §7.7 п. 4, §7.8 п. 4) и
> `503 ai.provider_failed` (не ответил ни основной профиль, ни запасные); исчерпание оси — единый
> `409 limit_exceeded` с `details.axis` (`44` В-16). `GET /ai/calls` — ключевой курсор
> (`docs/04` §4.1), фильтры `purpose`, `status`, `from`, `to`.

---

## 11. Фоновые задачи

| Имя | Расписание | Что делает |
|---|---|---|
| `interview.transcribe` | по событию | расшифровка реплики, 2 повтора (5 и 30 мин) |
| `interview.score` | по событию | оценка сессии по критериям, запись `candidate_scores.kind='ai'` |
| `interview.reap` | каждые 15 мин | `in_progress`/`paused` без активности 24 ч → `abandoned` + уведомление |
| `interview.media_purge` | ежедневно 03:40 | `purge_after < now()` → `purge` (после `storage.retention_scan`) |
| `summary.build` \| `summary.auto_send` \| `summary.expire` | по событию \| каждые 10 мин \| 03:50 | сборка Підсумку и PDF \| отправка по `auto_send_due_at` с проверками §7.15 \| `share_expires_at < now()` → `expired` |
| `ai.review_hint` | по событию | подсказка на новую сдачу и развёрнутый ответ |
| `ai.quality_sample` | ежедневно 06:00 | выборка 5 % + все `major` + все `confidence < 0.5` |
| `ai.metrics_rollup` | ежедневно 06:30 | метрики расхождения по `prompt_version`, проверка порога 15 % |
| `ai.calls_cleanup` | ежедневно 04:10 | удаление `input_ref` старше 90 дней, строк `ai_calls` — старше 400 дней |

> [дополнено, PR-27] `ai.calls_cleanup` работает с PR-27 (по тенантам, `runPerTenant`). Вход в S3
> пока не пишет ни один вызов — задача обнуляет ссылку `input_ref`, а удаление самого объекта
> приезжает вместе с первым писателем входа (расшифровка, PR-28).

---

## 12. Крайние случаи

1. **Микрофон не работает, текста сценарий не допускает.** Собеседование не запускается, кандидат получает альтернативный путь как при отказе (§7.5), лимит не списывается.
2. **Ответ на другом языке.** Расшифровка выполняется, флаг `lang_mismatch`, оценка формируется, в интерфейсе — «Відповідь іншою мовою».
3. **Ответы по одной секунде на все вопросы.** Оценка с низкой уверенностью, сессия → `needs_human`: отсеивать человека за молчание должен человек.
4. **Согласие отозвано после отправки Підсумку.** Ссылка `revoked`, аудио и расшифровки стёрты, у рекрутера остаются баллы и `agreement`.
5. **Провайдер вернул оценку без цитат.** Один повтор с усиленной инструкцией, затем `needs_human`; сохранить оценку без `evidence` невозможно на уровне БД.
6. **Двое переопределяют один критерий.** Оптимистическая блокировка по `human_at`; проигравший получает `409 conflict` и актуальное значение.
7. **Лимит исчерпан посреди дня.** Начатые сессии доводятся и ставятся в очередь на оценку; после пополнения `interview.score` обрабатывает очередь в порядке `finished_at`.
8. **Кандидат нанят до формирования оценки.** `kind='employee'` (`28` §7.6), сессия дооценивается, оценка остаётся в истории человека, Підсумок больше не отправляется.
9. **Сценарий изменили во время прохождения.** Сессия работает по `snapshot` попытки: изменения к идущим сессиям не применяются вовсе.
10. **Аудио удалено, рекрутер открывает цитату.** `410 media.purged`, в интерфейсе «Аудіо видалено {дата}. Розшифровка збережена», текст цитаты остаётся на месте.
11. **Расшифровка успешна, оценка падает, лимит цел.** 3 ретрая, затем `needs_human`; рекрутер читает расшифровку и оценивает сам.
12. **Ментор проверил, не раскрыв подсказку.** `agreement='not_shown'`, подсказка остаётся в журнале и участвует в выборке качества как контрольная группа.

---

## 13. Критерии приёмки

1. **Дано** сценарий и кандидат, **коли** кандидат открывает модуль, **тоді** до создания `attempts` показан экран согласия, а прямой POST `/start` без согласия даёт `409 interview_consent.required`.
2. **Дано** кандидат нажал «Не погоджуюсь», **тоді** сессия не создана, назначение активно, рекрутеру пришло `interview.declined`, в истории нейтральная строка, оценок нет.
3. **Дано** сценарий без `alternative_path`, **коли** его публикуют, **тоді** `422 scenario.alternative_required`, статус `draft`.
4. **Дано** модель вернула балл без `evidence`, **тоді** строка `interview_criterion_scores` не создана, сессия `needs_human`, `candidate_scores` пуста.
5. **Дано** сессия `scored` с баллом 12 из 100, **тоді** `candidate_state` остался `active`, статус не `rejected`, отказ не создан ни при какой настройке тенанта.
6. **Дано** оценка ИИ 4 из 5, **коли** рекрутер ставит 2 с причиной, **тоді** `agreement='major'`, создана `candidate_scores.kind='manual'`, строка `kind='ai'` не изменена, создана `ai_quality_reviews`.
7. **Дано** `ai_interview_ops` исчерпан, **коли** кандидат открывает модуль, **тоді** сессия не стартует, предложен альтернативный путь, счётчик не изменился, админу ушло `ai_ops_exhausted`.
8. **Дано** обрыв связи на 4-й реплике из 8, **коли** кандидат вернулся через 20 минут, **тоді** сессия продолжается с 4-й реплики, `disconnects=1`, попытка не потеряна.
9. **Дано** кандидат отозвал согласие, **тоді** аудио в `pending_delete` в той же транзакции, расшифровки пусты, попытка не `failed`, рекрутер уведомлён.
10. **Дано** сессия завершена 91 день назад, **коли** отработала `interview.media_purge`, **тоді** аудио физически удалено, расшифровка и баллы на месте, цитаты открываются без аудио.
11. **Дано** ментор с подсказкой, **тоді** в его форме нет предзаполненных значений критериев, подсказка не содержит слов «правильно» и «невірно», после решения записан `agreement`.
12. **Дано** роль без `interview.listen`, **коли** запрашивается `/interview/media/:turnId`, **тоді** `403`, в `audit_log` нет записи о прослушивании.
13. **Дано** авто-отправка с порогом по «Оцінка рекрутера» = 60 и задержкой 24 ч, **коли** балл 58 — Підсумок не отправлен; **коли** 61 — отправлен через 24 ч и может быть отменён до `auto_send_due_at`.
14. **Дано** Підсумок отправлен кандидату, **тоді** документ содержит строку «Документ сформовано автоматично», и её нельзя выключить настройкой тенанта.

---

## 14. Сверено с эталоном

Снято с Sintegrum: **сценарий ИИ-интервьюера как контент модуля** (`05-tracks.md` §5.3 — приветствие виртуального интервьюера, объяснение, что вопросы прослушиваются и на них отвечают, обещание прислать результат на почту) → §3.3 `intro_text`, `outro_text`, `answer_modes` и §5.2; **собеседование живёт внутри трека**, а не отдельным разделом, бейдж «AI» на узле графа → §3.1; **«3Д-резюме» как компилируемый артефакт по кандидату**, в их API `CvProgressItem` и `progress-item/cv-list` (`10-settings.md` §10.8) → `candidate_summaries` §3.5; **авто-отправка неполного артефакта по условию достижения оценки** с выбором вида оценки из четырёх (`10-settings.md`) → §6.5 и §7.15; **две названные функции ИИ** — сверка ответа сотрудника с контентом модуля и контрольными ключами в помощь ментору (→ §3.6, §7.13) и генерация контента (вне документа); **отдельный срок действия ИИ-подписки**, независимый от срока тарифа → §7.20 и `35`; **«Згенерувати критерії (AI)» на уровне вакансии** (`05-tracks.md` §5.5) → §6.2, `interview_criteria.source='ai_suggested'`.

Не снималось с эталона и является решением Lola: экран и модель согласия; обязательный альтернативный путь при отказе; запрет сохранять оценку без обоснования и цитаты; раздельные сроки хранения аудио и расшифровки; отсутствие вердикта в подсказке ментору; `agreement` как метрика качества; журнал `ai_calls`; выборочная перепроверка; честный перечень антифрод-флагов и явный отказ от голосовой биометрии.

---

## 15. Гипотезы и принятые по ним решения

**Г-30.1. Как кандидат отвечает на эталоне — голосом, текстом или на выбор.** В тексте модуля видно «ви зможете відповісти», продолжение обрезано. [гипотеза] Поддерживаются оба способа, голос основной. [решение] Оба, выбор задаётся `answer_modes`; текст нельзя отключить полностью, пока это единственный способ ответить без микрофона (§6.1). *Чем проверяется:* открыть модуль «Ласкаво просимо» рекрутингового трека на эталоне до конца.

**Г-30.2. Оценивает ли эталон по критериям или одним числом.** Видно поле «Оцінка ШІ» (одно число) и блок «Оцінка кандидата по критеріях» на вакансии. [гипотеза] Критерии — вход, одно число — выход. [решение] Именно так: `interview_criterion_scores` по критериям, свёртка по весам в `candidate_scores.kind='ai'` (§7.11); свёртка обратима визуально — критерии всегда видны. *Чем проверяется:* завести критерий на вакансии и провести тестовое собеседование.

**Г-30.3. Хранит ли эталон аудио после расшифровки.** В хранилище преобладают `.mp4` со случайными именами (`10-settings.md` §10.6), но это видеоответы по трекам. [гипотеза] Аудио собеседования хранится вместе с прочими медиа без отдельной политики. [решение] Для Lola — отдельная политика: `origin='interview_answer'`, 90 дней, `purge`, не `soft_delete` (§7.7). Хранить голос кандидата по остаточному принципу нельзя. *Чем проверяется:* провести собеседование на эталоне и найти файл в «Сховище».

**Г-30.4. Есть ли на эталоне экран согласия перед ИИ-собеседованием.** Не обнаружен. [гипотеза] Согласия нет, предупреждение растворено в приветствии. [решение] В Lola согласие обязательно и отдельно от согласия на обработку ПД (§7.4); отсутствие экрана на эталоне не аргумент — это область, где эталон копировать нельзя. *Чем проверяется:* пройти путь кандидата по публичной ссылке вакансии.

**Г-30.5. Что происходит на эталоне при отказе от ИИ-собеседования.** Механизма отказа не видно. [гипотеза] Отказ равнозначен непрохождению. [решение] В Lola отказ — равноправный выбор с обязательной альтернативой, сценарий без альтернативы не публикуется (§7.5, `422 scenario.alternative_required`). *Чем проверяется:* не проверяется на эталоне — решение продуктовое.

**Г-30.6. Состав «3Д-резюме».** Ни одного экземпляра на эталоне (ноль кандидатов). [гипотеза] Компиляция результатов прохождения и собеседования со сводкой. [решение] Семь секций §7.14, из них генеративная одна, остальные собираются из данных. *Чем проверяется:* довести тестового кандидата до конца и открыть `progress-item/cv-list`.

**Г-30.7. Формат подсказки ментору.** Из настроек известна только цель: «порівняйте відповіді співробітника з контентом модуля та контрольними ключами». [гипотеза] Подсказка — текстовый комментарий рядом с ответом. [решение] Три структурированных списка без вердикта (§3.6, §7.13): свободный текст слишком легко прочитать как готовую оценку. *Чем проверяется:* включить ИИ на эталоне и открыть карточку проверки с развёрнутым ответом.

**Г-30.8. Считает ли эталон незавершённое собеседование в лимит ИИ-операций.** [гипотеза] Считает по факту запуска. [решение] В Lola резерв при старте, списание один раз за сессию, повторы после наших сбоев не тарифицируются (§7.12); если эталон считает иначе, наше решение предпочтительнее — тенант не платит за отказ нашей инфраструктуры. *Чем проверяется:* сверить счётчик ИИ-операций на эталоне до и после прерванного собеседования.
