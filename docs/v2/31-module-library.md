# Lola LMS — ТЗ. 31. Библиотека переиспользуемых модулей

## 1. Назначение и границы

На эталоне Sintegrum обнаружен отдельный экран **«Бібліотека модулів»** (`/tracks/universal`):
плоская таблица «Тип (иконка) · Назва» со строкой поиска, где живут единицы контента, созданные
один раз и вставляемые **ссылкой** в несколько треков (05-tracks.md §5.1). Вставка — из
контекстного меню узла графа, пункт **«Бібліотека модулів ▸»** (§5.4); узел-ссылка помечен в
графе маркером «сетка ромбиков» внутри круга (§5.5).

В базовом ТЗ Lola `modules` — это **раздел конкретного курса**, привязанный к `course_version_id`
(02-data-model.md §2.4); переиспользуемой единицы контента нет вовсе: `lessons` принадлежит
одному разделу одного курса, `trajectory_nodes` — одной траектории. Документ добавляет этот слой
и отвечает на шесть вопросов: ссылка или копия, что при удалении используемого модуля, где видно
использование, как это соотносится с `lessons`/`modules`, кто вправе класть в общий ресурс
тенанта, как модуль типизируется и ищется.

**Входит:** карточка модуля, версионность и закрепление версии в месте использования,
обновление до последней версии, экран «Де використовується», архивирование вместо удаления,
предложение чужого урока в библиотеку, поиск, типизация, права.
**Не входит:** блочный редактор и перечень блоков (`11` §3.3, §5.2 — берём как есть),
медиа-пайплайн (`11` §3.4), правила прохождения (живут в назначении, `15`), граф-редактор
траектории (`17`), банки вопросов (`12`).

## 2. Роли и скоупы

| Действие | employee | mentor | manager | author | admin |
| --- | :-: | :-: | :-: | :-: | :-: |
| Видеть экран библиотеки, искать, открывать карточку | — | ✓ | ✓ | ✓ | ✓ |
| Вставлять модуль в узел графа / урок курса | — | — | — | ✓ | ✓ |
| Класть новый модуль в библиотеку | — | — | — | ✓ | ✓ |
| Править свой модуль или тот, где он в `author_ids` | — | — | — | ✓ | ✓ |
| Править чужой модуль | — | — | — | — | ✓ |
| Публиковать версию, в т.ч. `hotfix` | — | — | — | ✓ | ✓ |
| Обновлять своё место использования до новой версии | — | — | — | ✓ | ✓ |
| Массово обновить все места использования | — | — | — | — | ✓ |
| Предлагать свой урок в библиотеку | — | ✓ | ✓ | ✓ | ✓ |
| Принимать и отклонять предложения | — | — | — | ✓ | ✓ |
| Архивировать модуль | — | — | — | ✓ (свой) | ✓ |
| Удалять модуль физически | — | — | — | — | ✓ |

Новые скоупы: `library.view`, `library.use`, `library.publish`, `library.manage`.
mentor и manager получают `library.view` + `library.use` (вставлять контент они всё равно не
могут — нет `course.edit`); author — плюс `library.publish`; admin — все четыре.

`[решение] Р-31.6` Библиотека — **общий ресурс тенанта, а не папка автора**: видимость модуля
не сужается ни точкой, ни должностью. Смысл библиотеки ровно в том, чтобы «Використання хімії»
не писали заново в онбординг-треке каждой точки. Разграничение идёт по праву **положить**
и **изменить**, а не по праву **увидеть**.

## 3. Сущности и поля

### 3.1 Стыковка с `lessons` и `modules` базового ТЗ

`[решение] Р-31.1` **Третью сущность контента не заводим.** Тело библиотечного модуля — обычная
запись `lessons` с тем же перечнем блоков (`11` §3.3), просто без родительского раздела курса:
её владелец — модуль. В базовые таблицы вносятся `alter`:

> [исправлено, PR-25: у урока в репозитории своего `body` нет — «урок ссылается на материал,
> тест или практикум; собственного тела у урока нет» (`docs/11` §3.2), блоки живут в
> `resources.body` и в неизменяемых снимках `resource_versions`. Принцип Р-31.1 соблюдён
> буквально — третьей сущности нет, один редактор, один санитайзер, один плеер, — а «тело
> урока» в этом репозитории и есть материал, на который урок ссылается. Отсюда три отличия
> DDL: `lessons_library_ref_ck` сверяет, что место использования читает закреплённый снимок, а
> не `body is null`; добавлен `lessons_library_body_ck` (в R1 телом модуля бывает только
> материал, Р-31.7); `library_version_id` — `on delete set null`, а не `restrict`: иначе удаление
> тенанта (`tenant.purge`, удаление таблицами с повтором) упирается в цикл «урок курса → версия
> → урок-снимок → версия» и не сходится, а версию, на которую ссылается урок, приложение не
> удаляет никогда (§7.5). `trajectory_nodes.library_version_id` и его индекс — PR-26 (`45` §5:
> две ветки одну таблицу не трогают); до него место узла живёт только в
> `library_module_usages`.] Ранее: «с тем же `body jsonb`»; `check (library_version_id is null
> or (module_id is not null and body is null))`; `lessons.library_version_id … on delete
> restrict`; `alter table trajectory_nodes` в этом же блоке.

```sql
alter table lessons alter column module_id drop not null;
alter table lessons add column library_module_id  uuid references library_modules(id) on delete cascade;
alter table lessons add column library_version_id uuid references library_module_versions(id) on delete set null;
alter table lessons add constraint lessons_owner_ck
  check ((module_id is not null)::int + (library_module_id is not null)::int = 1);
alter table lessons add constraint lessons_library_ref_ck
  check (library_version_id is null
         or (module_id is not null and item_type = 'resource' and resource_version_id is not null));
alter table lessons add constraint lessons_library_body_ck
  check (library_module_id is null or item_type = 'resource');
create index idx_lessons_tenant_library on lessons (tenant_id, library_module_id)
  where library_module_id is not null;
create index idx_lessons_tenant_library_version on lessons (tenant_id, library_version_id)
  where library_version_id is not null;
-- PR-26:
alter table trajectory_nodes
  add column library_version_id uuid references library_module_versions(id) on delete restrict;
create index idx_trajectory_nodes_tenant_library on trajectory_nodes (tenant_id, library_version_id)
  where library_version_id is not null;
```

Читается так: `lessons` с непустым `library_module_id` — тело модуля: **черновик**
(`library_modules.draft_lesson_id`; `resource_version_id` пуст, урок читает рабочую редакцию
материала, статус материала всегда `draft`) или **неизменяемый снимок версии**
(`library_module_versions.lesson_id`; `resource_version_id` → снимок в `resource_versions`).
`lessons` с непустым `library_version_id` — **место использования** в курсе: своего материала у
него нет, `item_id` — материал-тело модуля, `resource_version_id` — снимок закреплённой версии,
и публикация курса его не перезакрепляет. Узел траектории станет местом использования тем же
способом в PR-26.

Материал-тело — внутренность модуля, а не самостоятельный ресурс: библиотека ресурсов, каталог,
поиск базы знаний и `/resources/:id` его не видят (признак — ссылающийся урок с
`library_module_id`), правится он только через библиотеку с её правами и версиями.

Обоснование. Альтернатива — своя таблица тела (`library_module_body`) — означала бы второй
редактор, второй санитайзер HTML, второй расчёт `estimated_minutes` и вторую ветку в плеере
урока. Один и тот же блочный контент обязан жить в одной таблице, иначе любая правка редактора
делается дважды и один раз забывается.

### 3.2 `library_modules` — карточка переиспользуемого модуля

Полные типы и значения по умолчанию — в DDL §3.6; ниже валидация и смысл полей.

| Поле | Тип | Обяз. | По умолчанию | Валидация | Комментарий |
| --- | --- | :-: | --- | --- | --- |
| `title` | text | ✓ | | 3–200 | колонка «Назва» |
| `slug` | text | ✓ | из `title` | `^[a-z0-9-]{3,80}$`, уникален в тенанте | |
| `content_kind` | text | ✓ | `article` | `article` \| `file` \| `video` \| `link` | перечень `resources.kind` (`11` §3.1), свой не заводим |
| `category_id` | uuid | — | null | FK `course_categories` | общий справочник, не отдельный |
| `tags` | text[] | ✓ | `{}` | ≤20 меток | |
| `summary` | text | — | null | ≤300 | подсказка в палитре вставки |
| `estimated_minutes` | int | — | null | 1–600 | показывается на узле графа («5 хв») |
| `owner_id` | uuid | ✓ | текущий | есть `library.publish` | кто отвечает за модуль |
| `author_ids` | uuid[] | ✓ | `{owner_id}` | 1–10 | кто правит без `library.manage` |
| `draft_lesson_id` | uuid | — | null | FK `lessons` | редактируемое тело (черновик) |
| `current_version_id` | uuid | — | null | FK `library_module_versions` | последняя опубликованная |
| `status` | text | ✓ | `draft` | `draft` \| `published` \| `archived` | см. §4 |
| `usage_count` | int | ✓ | 0 | ≥0 | активных мест использования |
| `archived_at` / `archived_by` / `archive_reason` | timestamptz / uuid / text | — | null | причина 5–500 | заполняются вместе |
| `embedding` / `embedding_model` | vector(768) / text | — | null | | тело последней версии (§7.8); чем посчитан — `provider:model:dims` |

> [исправлено, PR-25: `scorm` из перечня снят — тело модуля и есть материал, а у материала SCORM
> отложен до R3 (`11` Г-11.6); вернётся в оба перечня одновременно. `embedding_model` — сверх
> пакета: провайдер модели без ключа работает заглушкой (`HANDOFF` §6, `server/services/embeddings.ts`),
> векторы разных моделей несравнимы, и смена провайдера должна находить строки чужой модели,
> а не молча смешивать их в поиске PR-26] Ранее: «`article` \| `file` \| `video` \| `link` \|
> `scorm`», строки `embedding_model` не было.

### 3.3 `library_module_versions` — закреплённые версии

| Поле | Тип | Обяз. | По умолчанию | Валидация | Комментарий |
| --- | --- | :-: | --- | --- | --- |
| `library_module_id` | uuid | ✓ | | FK | |
| `version` | int | ✓ | `max+1` | ≥1, уникален в модуле | человекочитаемая «v3» |
| `lesson_id` | uuid | ✓ | | FK `lessons` | **неизменяемый снимок** тела |
| `title` / `content_kind` / `estimated_minutes` | text / text / int | ✓ / ✓ / — | | | копия на момент публикации |
| `changelog` | text | ✓ | | 5–500 | «Що змінилось», как в `11` §5.4 |
| `diff` | jsonb | ✓ | `{}` | `{added[],removed[],changed[]}` по `block.id` | показывается в диалоге обновления |
| `is_hotfix` | boolean | ✓ | false | | «Критичне виправлення», §7.4 |
| `media_ids` | uuid[] | ✓ | `{}` | FK `media_assets` | защита медиа версии от удаления |
| `status` | text | ✓ | `published` | `published` \| `retired` | |

`[решение] Р-31.8` Нумерация версий **своя**, а не техническая: автор публикует `v2` осознанно,
а не получает 47-ю автосохранённую ревизию. Автосохранение черновика (`11` §5.2, раз в 10 секунд)
версию не создаёт — оно пишет в `draft_lesson_id`.

### 3.4 `library_module_usages` — «де використовується»

`library_module_id`, `version_id` (закреплённая версия **этого** места), `holder_type`
(`trajectory_node` \| `course_lesson`), `holder_id`, `holder_title`, `container_type`
(`trajectory` \| `course`), `container_id`, `container_title` (денормализация ради экрана §5.3),
`pin_mode` (`fixed` \| `hotfix_auto`, по умолчанию `hotfix_auto`), `is_stale` (есть версия
новее), `latest_version_seen` (какую версию автору уже показывали), `attached_by`,
`attached_at`, `detached_at`.

> [исправлено, PR-25: `holder_title` — снимок названия узла/урока по решению `44` В-11 (у каждой
> мягкой ссылки — снимок названия): «Вузол/Урок» на экране §5.3 и в «Відключені раніше»
> переживает удаление узла. `pin_mode` по умолчанию `hotfix_auto` — так требуют Р-31.4
> («значение по умолчанию») и критерий приёмки 6; `'fixed'` в §7.2 описывал закрепление
> версии, которое действует при любом режиме] Ранее: `holder_title` не было; DDL §3.6 —
> `pin_mode … default 'fixed'`.

### 3.5 `library_module_proposals` — предложение в библиотеку

`source_lesson_id` (FK `lessons`), `source_container_type`, `source_container_id`,
`proposed_title` (3–200), `proposed_category_id`, `comment` (≤500, обязателен),
`status` (`pending` \| `accepted` \| `rejected` \| `withdrawn`), `proposed_by`, `decided_by`,
`decided_at`, `decision_comment` (обязателен при `rejected`, 5–500),
`library_module_id` (заполняется при `accepted`).

### 3.6 Полный DDL

Общие поля (`id uuid primary key default gen_random_uuid()`, `created_at`, `updated_at`,
`deleted_at`) — по конвенции `02` §2, ниже не повторяются, кроме `id` в первой таблице.

```sql
create table library_modules (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  title              text not null,
  slug               text not null,
  content_kind       text not null default 'article',  -- article | file | video | link (resources.kind)
  category_id        uuid references course_categories(id) on delete set null,
  tags               text[] not null default '{}',
  language           text not null default 'uk',
  summary            text,
  estimated_minutes  int,
  owner_id           uuid not null references users(id) on delete restrict,
  author_ids         uuid[] not null default '{}',
  draft_lesson_id    uuid references lessons(id) on delete set null,
  current_version_id uuid,                             -- FK ниже: циклическая ссылка
  status             text not null default 'draft',    -- draft | published | archived
  usage_count        int  not null default 0,
  archived_at        timestamptz,
  archived_by        uuid references users(id),
  archive_reason     text,
  search_tsv         tsvector,                         -- ведёт триггер library_modules_tsv_trg: title (A), summary и tags (B)
  embedding          vector(768),
  embedding_model    text,                             -- provider:model:dims — чем посчитан embedding
  created_by         uuid not null references users(id) on delete restrict,
  unique (tenant_id, slug),
  check (status in ('draft','published','archived')),
  check (content_kind in ('article','file','video','link')),
  check (status <> 'archived' or (archived_at is not null and archive_reason is not null)),
  check (cardinality(author_ids) between 1 and 10)
);

create table library_module_versions (
  tenant_id         uuid not null references tenants(id) on delete cascade,
  library_module_id uuid not null references library_modules(id) on delete cascade,
  version           int  not null check (version >= 1),
  lesson_id         uuid not null references lessons(id) on delete restrict,
  title             text not null,
  content_kind      text not null,
  estimated_minutes int,
  changelog         text not null check (char_length(changelog) between 5 and 500),
  diff              jsonb not null default '{}',
  is_hotfix         boolean not null default false,
  media_ids         uuid[] not null default '{}',
  status            text not null default 'published',  -- published | retired
  published_at      timestamptz not null default now(),
  published_by      uuid not null references users(id) on delete restrict,
  unique (tenant_id, library_module_id, version)
);

alter table library_modules add constraint library_modules_current_version_fk
  foreign key (current_version_id) references library_module_versions(id) on delete set null;

create table library_module_usages (
  tenant_id           uuid not null references tenants(id) on delete cascade,
  library_module_id   uuid not null references library_modules(id) on delete restrict,
  version_id          uuid not null references library_module_versions(id) on delete restrict,
  holder_type         text not null check (holder_type in ('trajectory_node','course_lesson')),
  holder_id           uuid not null,
  holder_title        text,                              -- снимок названия узла/урока (В-11)
  container_type      text not null check (container_type in ('trajectory','course')),
  container_id        uuid not null,
  container_title     text not null,
  pin_mode            text not null default 'hotfix_auto' check (pin_mode in ('fixed','hotfix_auto')),
  is_stale            boolean not null default false,
  latest_version_seen int,
  attached_by         uuid not null references users(id) on delete restrict,
  attached_at         timestamptz not null default now(),
  detached_at         timestamptz
);

create table library_module_proposals (
  tenant_id             uuid not null references tenants(id) on delete cascade,
  source_lesson_id      uuid not null references lessons(id) on delete cascade,
  source_container_type text not null check (source_container_type in ('trajectory','course')),
  source_container_id   uuid not null,
  proposed_title        text not null,
  proposed_category_id  uuid references course_categories(id) on delete set null,
  comment               text not null,
  status                text not null default 'pending'
                          check (status in ('pending','accepted','rejected','withdrawn')),
  proposed_by           uuid not null references users(id) on delete restrict,
  decided_by            uuid references users(id),
  decided_at            timestamptz,
  decision_comment      text,
  library_module_id     uuid references library_modules(id) on delete set null,
  check (status <> 'rejected' or decision_comment is not null)
);

create index idx_library_modules_tenant          on library_modules (tenant_id, status, updated_at desc);
create index idx_library_modules_tenant_kind     on library_modules (tenant_id, content_kind);
create index idx_library_modules_tenant_category on library_modules (tenant_id, category_id);
create index idx_library_modules_search          on library_modules using gin (search_tsv);
create index idx_library_modules_embedding       on library_modules using hnsw (embedding vector_cosine_ops);

create index idx_library_module_versions_tenant  on library_module_versions (tenant_id, library_module_id, version desc);
create index idx_library_module_versions_lesson  on library_module_versions (tenant_id, lesson_id);

create index idx_library_module_usages_tenant    on library_module_usages (tenant_id, library_module_id) where detached_at is null;
create index idx_library_module_usages_container on library_module_usages (tenant_id, container_type, container_id);
create index idx_library_module_usages_stale     on library_module_usages (tenant_id, is_stale) where detached_at is null and is_stale;
create unique index idx_library_module_usages_holder on library_module_usages (tenant_id, holder_type, holder_id)
  where detached_at is null;

create index idx_library_module_proposals_tenant on library_module_proposals (tenant_id, status, created_at desc);
create unique index idx_library_module_proposals_pending on library_module_proposals (tenant_id, source_lesson_id)
  where status = 'pending';
```

RLS на всех четырёх таблицах — как в `02` §2.12: `enable` + `force`, политика `tenant_isolation`
с `using` и `with check` по `current_setting('app.tenant_id', true)::uuid`.

> [исправлено, PR-25: фактический DDL — `server/db/migrations/0081_v2_library.sql`. Отличия
> от редакции пакета: (1) `search_tsv` ведёт триггер, как у
> `resources` и `knowledge_articles` (0008) — `array_to_string` в Postgres STABLE, и
> `generated always as` с ним не принимается; (2) `array_length(author_ids,1) >= 1` заменён на
> `cardinality(author_ids) between 1 and 10`: `array_length('{}', 1)` — NULL, и CHECK пропустил
> бы пустой массив, а верхняя граница 10 названа в §3.2; (3) `scorm` снят из `content_kind`
> (§3.2); (4) `embedding_model`, `holder_title` и `pin_mode default 'hotfix_auto'` — §3.2, §3.4;
> (5) сверх пакета CHECK-и длины полей из §3.2 и §3.5 (`title` 3–200, `slug`, `summary` ≤300,
> `estimated_minutes` 1–600, `archive_reason` 5–500, `usage_count >= 0`, `comment` 1–500,
> `decision_comment` 5–500, `proposed_title` 3–200) и `holder_type`↔`container_type`: узел
> живёт в траектории, урок — в курсе; (6) полный индекс `idx_library_module_usages_module_all
> (tenant_id, library_module_id, attached_at desc)` — «Відключені раніше» частичный индекс по
> `detached_at is null` не обслуживает] Ранее: DDL блока выше без этих правок.

## 4. Состояния и переходы

**Модуль:** `draft → published` (первая опубликованная версия) → `archived` (`library.manage`,
только с причиной) → `published` (восстановление). `draft → archived` разрешено.
Из `archived` в `draft` — нет: у модуля уже есть версии и места использования.
**Версия:** `published → retired`; `retired` ставится, только когда её не закрепляет ни одно
активное место (проверка в транзакции), тело `lessons`-снимка при этом остаётся.
**Место использования:** `attached → stale` (вышла версия новее) → `attached` (автор обновил) →
`detached` (узел удалён из графа или урок из курса). `detached` конечное, строка не удаляется —
она нужна отчёту и проверке §7.5.
**Предложение:** `pending → accepted | rejected | withdrawn`, все три конечные.

## 5. Экраны

### 5.1 «Бібліотека модулів» — список, `/library/modules`

Шапка: заголовок «Бібліотека модулів», поле **«Пошук»** (плейсхолдер «Пошук за назвою або
вмістом»), кнопка **«Створити модуль»** (при `library.publish`), переключатель **«Показати
архівні»**. Колонки: **Тип** (иконка, §7.7) · **Назва** · **Категорія** · **Використання**
(«у 3 треках», ведёт в §5.3) · **Версія** («v4 · 12 вересня») · **Власник**. Первые две — как
в эталоне, остальные `[решение]`: без колонки «Використання» библиотека за полгода превращается
в свалку, где никто не знает, что можно трогать. Фильтры: тип, категория, метка, владелец,
«тільки невикористовувані», «є застарілі посилання». Сортировка — дата изменения, новые сверху;
25/50/100 записей на странице.

mentor и manager видят таблицу только на чтение, без «Створити модуль» и меню строки; author —
свои модули с полным меню, чужие на чтение плюс «Використати»; admin — всё. Пусто: «Бібліотека
порожня. Модуль, створений один раз, можна вставити в кілька треків» + «Створити модуль».
Ничего не найдено: «Нічого не знайшли за запитом «…»» + «Очистити пошук». Загрузка — скелетон
10 строк. Ошибка — «Не вдалося завантажити бібліотеку» + «Спробувати ще раз».

### 5.2 Карточка модуля, `/library/modules/:id`

Шапка: иконка типа, название, бейдж статуса, «v4», кнопки «Редагувати», «Опублікувати версію»,
«…» (Дублювати, Архівувати, Видалити). Вкладка **«Вміст»** — блочный редактор `11` §5.2 без
изменений, над ним плашка «Цей модуль використовується у 3 треках. Зміни побачать тільки ті,
хто оновить посилання». Вкладка **«Версії»** — версия, дата, автор, changelog, бейдж «Критичне
виправлення», сколько мест на этой версии, кнопка «Порівняти з v3» (поблочный diff).
Вкладка **«Де використовується»** — §5.3.

### 5.3 «Де використовується»

Таблица активных мест: **Трек/Курс** (ссылка) · **Вузол/Урок** · **Версія** («v2 · застаріло»
кораллом при `is_stale`) · **Хто вставив** · **Коли**. Групповое действие «Оновити все до v4»
(`library.manage`) с подтверждением «Оновити 7 місць використання до v4? Ті, хто вже проходить,
залишаться на своїй версії». Внизу свёрнутый блок «Відключені раніше». Пусто: «Модуль ще ніде
не використовується. Його можна видалити без наслідків».

### 5.4 Вставка из графа: «Бібліотека модулів ▸»

Контекстное меню узла (05-tracks.md §5.4) открывает палитру: поле поиска, до 8 последних
использованных модулей, ссылка «Показати всі» → модалка с таблицей §5.1 в режиме выбора; в
строке иконка типа, название, «v4», «5 хв». После выбора узел получает маркер ссылки (в эталоне
сетка ромбиков) и подпись «Бібліотека · v4». Тело такого узла в графе не редактируется: вместо
редактора карточка «Це посилання на модуль бібліотеки» с кнопками «Відкрити в бібліотеці» и
«Відʼєднати і зробити копією».

### 5.5 Диалоги обновления, удаления, архивирования

**«Оновити до останньої версії»** — из узла (баннер «Доступна нова версія v4») или из §5.3:
заголовок «Оновити «Використання хімії» з v2 до v4», changelog каждой пропущенной версии
списком, поблочный diff (добавленные блоки бирюзой, удалённые кораллом, изменённые с раскрытием
«було / стало»), строка последствий «Оновлення не змінить проходження 12 людей, які вже почали.
Вони залишаться на v2», кнопки «Оновити» / «Скасувати».
**Удаление используемого модуля** — «Модуль використовується» / «Цей модуль вставлено у 3 місцях.
Видалити не можна — його можна заархівувати», список мест ссылками, кнопки «Заархівувати»
(первичная) и «Відкрити список використання»; при архивировании обязательно поле «Причина».
Если мест 0 — «Видалити модуль назавжди? Дію не можна скасувати».

## 6. Формы

### 6.1 Создание и редактирование модуля

| Поле | Контрол | Обяз. | Валидация | Текст ошибки (uk) |
| --- | --- | :-: | --- | --- |
| Назва | текст | ✓ | 3–200 | «Назва від 3 символів» |
| Тип | радио-карточки | ✓ | один из 5 `content_kind` | «Оберіть тип модуля» |
| Категорія | дерево-селект | — | существующая | «Категорію видалено, оберіть іншу» |
| Мітки | мультиселект с созданием | — | ≤20 | «Не більше 20 міток» |
| Короткий опис | текст | — | ≤300 | «Опис до 300 символів» |
| Власник | селект людей | ✓ | есть `library.publish` | «У цієї людини немає прав на бібліотеку» |
| Співавтори | мультиселект | — | ≤10, без дубля владельца | «Власник уже у списку» |
| Мова | селект | ✓ | uk / en | |
| Тривалість, хв | число | — | 1–600 | «Від 1 до 600 хвилин» |
| Вміст | блочный редактор (`11` §5.2) | ✓ | ≥1 блок | «Додайте хоча б один блок» |

### 6.2 Публикация версии

| Поле | Контрол | Обяз. | Валидация | Текст ошибки / подсказка (uk) |
| --- | --- | :-: | --- | --- |
| Що змінилось | многострочный текст | ✓ | 5–500 | «Опишіть зміни — це побачать автори треків» |
| Критичне виправлення | переключатель | — | | «Помилка, через яку контент вводить в оману. Оновиться автоматично там, де ще ніхто не почав» |
| Сповістити авторів треків | переключатель | — | включён | зеркало «Сповістити про оновлення» из `11` §14.2 |

### 6.3 Предложение урока в библиотеку и архивирование

Предложение (из редактора курса или графа, действие «Запропонувати в бібліотеку»):
«Назва в бібліотеці» (по умолчанию = название урока, 3–200), «Категорія», «Чому це варто
переиспользовувати» (≤500, обязательно — иначе принимающий автор не понимает, зачем ему это).
Ошибка повторной подачи: «Цей урок уже запропоновано, рішення ще не ухвалено».
Архивирование: «Причина» (5–500, обязательно), ошибка «Вкажіть причину — вона буде видна
авторам треків».

## 7. Правила и алгоритмы

1. **Ссылка, а не копия `[решение] Р-31.2`.** Узел графа и урок курса хранят `library_version_id`,
   а не копию тела. Библиотека придумана ради того, чтобы правка «Використання хімії» дошла до
   всех треков; снимок-копия убивает это в момент вставки.
2. **Версия закрепляется `[решение] Р-31.2`.** При вставке в `library_module_usages.version_id`
   пишется `current_version_id` на момент вставки; публикация новой версии не
   меняет ни одного существующего места.
   > [исправлено, PR-25: `pin_mode` при вставке берётся из запроса, по умолчанию `hotfix_auto`
   > (§3.4, Р-31.4); закреплена версия при любом режиме — режим решает только, доезжает ли
   > «Критичне виправлення» само] Ранее: «`pin_mode='fixed'`». Правка модуля не имеет права менять содержание трека,
   который человек проходит сейчас, — иначе аттестация идёт по одному тексту, а оспаривается
   по другому.
3. **Обновление — только явное.** Кнопка «Оновити до останньої версії» (§5.5) доступна носителю
   `course.edit` на этот курс или траекторию; обновление меняет `version_id` места и снимает
   `is_stale`. Уже начатые прохождения остаются на прежней версии, потому что `enrollments`
   ссылается на версию курса (`10` §3.1), а не на место использования.
4. **Исключение — `is_hotfix` `[решение] Р-31.4`.** Версия с флагом «Критичне виправлення»
   применяется автоматически ко всем местам с `pin_mode='hotfix_auto'` (значение по умолчанию),
   но только там, где по контейнеру нет ни одного `enrollment` в статусе `in_progress`. Где есть —
   место остаётся `stale`, автору уходит `library_hotfix_blocked`.
5. **Удаление запрещено при использовании `[решение] Р-31.3`.** `DELETE` возвращает `409`
   `library_module.in_use` с `details.usages[]` (до 50 записей плюс общее число). Физическое
   удаление возможно, только если активных мест 0, отключённых мест 0 и версий не больше одной;
   во всех прочих случаях — архивирование.
6. **Что делает архивирование.** Модуль исчезает из палитры §5.4 и из списка по умолчанию;
   вставленные места продолжают работать на закреплённых версиях с серым бейджем «Архівний
   модуль»; новые версии архивного модуля публиковать нельзя. Обучение не должно ломаться
   от уборки в библиотеке.
7. **Тип и иконка `[решение] Р-31.5`.** `content_kind` берётся из перечня `resources.kind`
   (`11` §3.1), своего перечня не заводим. Иконка колонки «Тип»: `file` — документ, `video` —
   плёнка, `link` — цепочка, `scorm` — пакет; `article` уточняется доминирующим блоком тела:
   доля блоков `checklist` ≥ 50 % → чек-лист, иначе есть блок `table` → таблица, иначе «T».
   Перечень блоков — ровно `11` §3.3, без добавлений.
8. **Поиск.** GIN по `search_tsv` (название, описание, метки) с ранжированием `ts_rank`; плюс
   векторный поиск по `embedding` (pgvector, 768) по телу последней версии. Запрос длиннее трёх
   слов уходит в гибрид, результаты сливаются по RRF, лимит 50. Поиск по телу нужен потому, что
   модуль «Використання хімії» ищут словом «розведення», которого нет в названии.
   PR-25 заводит полнотекстовую часть списка (`q` — `search_tsv` плюс `ilike` по названию) и
   сам вектор: `library.embedding_refresh` считает его по телу последней версии через
   `server/services/embeddings.ts` — OpenAI-совместимый провайдер при `EMBEDDINGS_URL`, без ключа
   детерминированная заглушка (`HANDOFF` §6). Векторная часть запроса и RRF — PR-26.
9. **Пересчёт.** При публикации версии транзакция ставит `is_stale=true` всем активным местам,
   где `version_id <> current_version_id`; `usage_count` = `count(*) where detached_at is null`,
   считается в той же транзакции при attach/detach и сверяется ночью (§11).
10. **Отвязка в копию.** «Відʼєднати і зробити копією» создаёт обычный `lessons` с телом
    закреплённой версии, обнуляет `library_version_id`, ставит `detached_at`. Обратно — только
    повторной вставкой из библиотеки.
    > [исправлено, PR-25: у урока курса отвязка **всегда** делает копию — урок не может остаться
    > без материала, а «убрать урок из курса» — это `DELETE /lessons/:id`, который закрывает место
    > сам (§12). У узла траектории до PR-26 ссылки в самом узле нет, и отвязка закрывает только
    > строку реестра; `makeCopy` для узла появится вместе с `trajectory_nodes.library_version_id`]
    > Ранее: флаг `makeCopy` для обоих видов держателя.
11. **Кто может класть `[решение] Р-31.6`.** `library.publish` — author и admin; носитель
    `library.use` без него подаёт предложение (§6.3), куратор принимает, и только тогда
    появляется `library_modules`. Общий ресурс тенанта без модерации за полгода наполняется
    десятком почти одинаковых «Інструкція з прибирання».
12. **Правка чужого.** Автор без `library.manage` правит модуль, только если он в `author_ids`;
    иначе `403` и подсказка «Зверніться до власника модуля».
13. **Медиа.** `media_assets.used_in` дополняется записью `{"library_module_version_id": "…"}`;
    правило `11` §7.8 (нельзя удалить используемое медиа) действует на все опубликованные версии,
    а не только на последнюю.
    > [исправлено, PR-25: колонки `media_assets.used_in` в репозитории нет (`docs/11` §3.4
    > описывает её, схема — нет). Правило держится проверкой в единственной ручке удаления
    > `DELETE /media/:id` (`softDeleteMedia`, В-17): файл, чей id есть в `media_ids` хоть одной
    > версии, не удаляется — `409 media.in_library_version` со списком версий (§12)] Ранее:
    > «`media_assets.used_in` дополняется записью `{"library_module_version_id": "…"}`».
14. **Что в библиотеку не кладётся `[решение] Р-31.7`.** В R1 библиотечным может быть только
    контентный модуль (`lessons` с `body`): у теста переиспользование уже решено банками вопросов
    (`12`), а у практикума, опроса, очного занятия и вебинара есть собственные правила проверки,
    которые нельзя закрепить версией. В R2 — расширение на `quiz` тем же механизмом.
15. **Лимит.** Один модуль нельзя вставить в один и тот же узел дважды (частичный уникальный
    индекс `idx_library_module_usages_holder`); в разные узлы одного трека — можно.

## 8. Уведомления

| Код | Событие | Канал | Шаблон (uk) | Кому |
| --- | --- | --- | --- | --- |
| `library_module_updated` | опубликована версия, «Сповістити» включён | in-app + Telegram | «Модуль «{title}» оновлено до v{version}. {changelog}» | авторам контейнеров, где модуль используется |
| `library_hotfix_applied` | `is_hotfix` применён автоматически | in-app | «У треку «{container}» модуль «{title}» оновлено автоматично: критичне виправлення» | авторам затронутых контейнеров |
| `library_hotfix_blocked` | `is_hotfix` не применён из-за идущих прохождений | in-app | «Критичне виправлення «{title}» не застосовано у «{container}»: люди вже проходять. Оновіть вручну» | автору контейнера |
| `library_module_archived` | модуль заархивирован | in-app | «Модуль «{title}» заархівовано. Причина: {reason}» | авторам мест использования |
| `library_proposal_created` | подано предложение | in-app | «{user} пропонує додати «{title}» до бібліотеки» | носителям `library.publish` |
| `library_proposal_decided` | решение принято | in-app + Telegram | «Вашу пропозицію «{title}» {прийнято / відхилено}. {decision_comment}» | автору предложения |
| `library_stale_digest` | еженедельный дайджест | in-app | «У ваших треках {n} посилань на застарілі версії модулів» | авторам контейнеров |

Шаблоны регистрируются в `notification_templates`, отправка — по `23-notifications.md`.

PR-25 заводит четыре кода — `library_module_updated`, `library_module_archived`,
`library_proposal_created`, `library_proposal_decided` (шаблоны по умолчанию —
`server/services/notifications.ts`, подписи — `notif.code.*` в трёх словарях). Коды хотфикса и
дайджест устаревших ссылок приходят с PR-26 вместе с обновлением мест использования.

## 9. Отчёты и выгрузки

**«Використання бібліотеки»** — модуль, тип, категория, владелец, версия, мест использования,
из них устаревших, открытий за период, доля завершения, дата последней правки. Фильтры:
категория, тип, владелец, период, «тільки невикористовувані».
**«Застарілі посилання»** — трек/курс, узел/урок, модуль, закреплённая версия, последняя версия,
отставание в версиях, дней с выхода новой версии, автор контейнера. Фильтры: автор,
отставание ≥ N версий.
**«Пропозиції до бібліотеки»** — урок-источник, контейнер, кто предложил, дата, статус, кто
решил, комментарий решения. Фильтры: статус, период.
Выгрузка — CSV (UTF-8, разделитель `;`) и XLSX, до 50 000 строк, асинхронно через `import_jobs`
в режиме экспорта, ссылка живёт 24 часа.

## 10. API

Все пути под `/api/v1`, ответы `{data}` / `{error:{code,message,details}}`, курсорная пагинация,
мутации идемпотентны по `Idempotency-Key`, чужой тенант — `404`.

> [исправлено фазой 1, `43` §5, `44` В-16 §8.2.7] Ранее: коды `library.forbidden`,
> `library.not_author`, `library.manage_required` для отказа по скоупу. В `server/api` для
> «нет скоупа» действует одно написание — `forbidden` (25 файлов); три уточняющих кода
> заменены им, различие в причине отказа передаётся телом ответа.

| Метод | Путь | Вход | Выход | Ошибки |
| --- | --- | --- | --- | --- |
| GET | `/library/modules` | `q`, `kind`, `categoryId`, `tag`, `ownerId`, `status`, `onlyUnused`, `onlyStale`, `cursor`, `limit` | карточки + `usageCount` | `403 forbidden` |
| POST | `/library/modules` | поля §6.1 | карточка `draft` | `403`, `422 validation_failed`, `409 slug_taken` |
| GET | `/library/modules/:id` | — | карточка + `currentVersion` + `usageCount` | `404` |
| PATCH | `/library/modules/:id` | поля §6.1 | карточка | `403 forbidden`, `409 module_archived` |
| DELETE | `/library/modules/:id` | — | `204` | `409 library_module.in_use` c `details.usages[]`, `403` |
| POST | `/library/modules/:id/archive` | `{reason}` | карточка `archived` | `422 reason_required` |
| POST | `/library/modules/:id/restore` | — | карточка `published` | `409 module_deleted` |
| POST | `/library/modules/:id/duplicate` | `{title}` | новая карточка `draft` | `403`, `409 slug_taken` |
| GET | `/library/modules/:id/versions` | `cursor` | список версий | `404` |
| POST | `/library/modules/:id/versions` | `{changelog, isHotfix, notify}` | новая версия | `422 changelog_required`, `422 empty_body`, `409 module_archived`, `409 version_conflict` |
| GET | `/library/modules/:id/versions/:from/diff/:to` | — | `{added[], removed[], changed[]}` по `block.id` | `404`, `422 same_version` |
| GET | `/library/modules/:id/usages` | `includeDetached`, `cursor` | места использования | `404` |
| POST | `/library/usages` | `{libraryModuleId, holderType, holderId, containerType, containerId, pinMode}` | место использования | `409 already_attached`, `409 module_archived`, `403 container.forbidden` |
| POST | `/library/usages/:id/update-version` | `{toVersion}` | место + `{updatedFrom, updatedTo}` | `409 already_latest`, `422 version_retired` |
| POST | `/library/usages/:id/detach` | `{makeCopy}` | `{lessonId}` при `makeCopy` | `404`, `403` |
| POST | `/library/modules/:id/update-all-usages` | `{toVersion}` | `{updated, skipped[]}` | `403 forbidden` |
| GET / POST | `/library/proposals` | фильтры / `{sourceLessonId, proposedTitle, proposedCategoryId, comment}` | список / предложение | `409 proposal_pending` |
| POST | `/library/proposals/:id/accept` | `{categoryId, ownerId}` | `{libraryModuleId}` | `403`, `409 proposal.already_decided` |
| POST | `/library/proposals/:id/reject` | `{decisionComment}` | предложение | `422 comment_required` |
| GET | `/library/modules/:id/versions/:version` | — | версия + тело снимка | `404` |
| POST | `/library/proposals/:id/withdraw` | — | предложение `withdrawn` | `404`, `409 proposal.already_decided` |

> [исправлено, PR-25: (1) добавлены две ручки — тело закреплённой версии (им читает своё тело
> место на v2, когда вышла v3, критерий 1, и «Порівняти з v3») и отзыв предложения (статус
> `withdrawn` в §4 есть, а войти в него было нечем); (2) удаление физическое (§7.5), поэтому
> `restore` удалённого модуля его не находит — `404`, а `409 module_deleted` не возникает; (3)
> добавлены коды, без которых отказ молчал бы о причине: `409 module_not_published` (вставлять
> нечего — у черновика нет версии), `409 container.published` (опубликованный трек и
> опубликованную версию курса не меняют — правится черновик), `422 holder_not_content` (модуль
> вставляется в узел-задание, а не в И/АБО или таймер), `409 already_detached`,
> `422 owner_forbidden` («У цієї людини немає прав на бібліотеку», §6.1), `422 empty_body`,
> `422 media_not_ready`, `422 category_not_found`; (4) `POST /library/modules/:id/versions`
> принимает необязательный `expectedVersion` — `409 version_conflict` приходит и тогда, когда
> автор публиковал со страницы, устаревшей на версию (§12), а не только при гонке двух
> транзакций; (5) «нет скоупа» — одно `forbidden`, отказ «чужой модуль» несёт
> `details.reason = 'not_author'` (В-16 §8.2.7); (6) `update-version`, `update-all-usages` и
> `diff` между версиями — PR-26 (критерии 2 и 6); `diff` с предыдущей версией уже лежит в
> каждой строке `GET …/versions`] Ранее: таблица без двух ручек, с `409 module_deleted`.

## 11. Фоновые задачи

| Задача | Расписание | Что делает |
| --- | --- | --- |
| `library.usage_recalc` | ежедневно 03:20 | сверяет `usage_count` и `is_stale` с фактом, чинит расхождения, пишет в `audit_log` только при расхождении |
| `library.hotfix_propagate` | по событию публикации `is_hotfix` | обновляет места с `pin_mode='hotfix_auto'` без активных прохождений, шлёт `library_hotfix_applied` / `library_hotfix_blocked` |
| `library.stale_digest` | понедельник 09:00 по таймзоне точки | дайджест `library_stale_digest` авторам контейнеров |
| `library.embedding_refresh` | по событию публикации версии, очередь pg-boss | пересчёт `embedding` по телу последней версии, батч 20 |
| `library.orphan_scan` | еженедельно | ищет `lessons` с `library_module_id` без карточки или без версии (следы оборванных транзакций), отчёт админу |
| `library.version_retire` | ежедневно 03:40 | переводит в `retired` версии, которые никто не закрепляет дольше 90 дней |

PR-25 заводит `library.embedding_refresh` (по событию публикации; без `moduleId` — все модули с
пустым вектором или вектором другой модели) и `library.usage_recalc` (плюс закрывает места,
чей держатель исчез мимо редактора — раздел курса удалён целиком, узел удалён не через полотно).
`hotfix_propagate` и `stale_digest` — PR-26, `orphan_scan` и `version_retire` — вместе с отчётами §9.

## 12. Крайние случаи

- Автор правит модуль, пока другой вставляет его в трек: вставка закрепляет `current_version_id`,
  то есть ещё не тронутую версию; черновик на неё не влияет.
- Модуль в 40 узлах, публикуется v5: 40 мест становятся `stale`, уведомление уходит авторам
  контейнеров с дедупликацией по адресату, а не 40 писем одному человеку.
- Отката версии нет: «откат» — это публикация v5 с телом v3 и честным changelog, иначе `diff`
  перестаёт быть восстановимым, а история прохождений — объяснимой.
- Контейнер удалён вместе с узлом: место получает `detached_at`, `usage_count` уменьшается,
  но физическое удаление модуля запрещено, пока есть отключённые места (§7.5).
- Медиа внутри модуля удаляют из библиотеки медиа: запрет по §7.13, `409` со списком версий.
- Модуль заархивирован после выдачи сертификата: прохождение и сертификат валидны — они
  ссылаются на версию курса, та на закреплённую версию, тело версии неизменяемо.
- Предложение принято, исходный урок потом удалён: `source_lesson_id` уходит каскадом,
  `library_modules` уже создан и живёт отдельно.
- Два автора одновременно публикуют версию: уникальность `(tenant_id, library_module_id, version)`
  даёт `409 version_conflict`, второму — «Версію v4 вже опубліковано. Оновіть сторінку».
- Библиотечный модуль внутри библиотечного невозможен: блока такого типа в `11` §3.3 нет;
  `knowledge_link` — ссылка в базу знаний, а не вложение.

## 13. Критерии приёмки

1. **Дано** модуль v2 в треке, **коли** автор публикует v3, **тоді** узел показывает тело v2,
   а рядом появляется баннер «Доступна нова версія v3».
2. **Дано** место на v2 и опубликованная v4, **коли** автор трека жмёт «Оновити до останньої
   версії», **тоді** диалог показывает changelog v3 и v4 и поблочный diff v2→v4, а после
   подтверждения узел отдаёт тело v4.
3. **Дано** модуль в 3 треках, **коли** админ вызывает `DELETE`, **тоді** `409
   library_module.in_use` со списком трёх мест, модуль не удалён, предложено «Заархівувати».
4. **Дано** заархивированный модуль, **коли** автор открывает палитру «Бібліотека модулів ▸»,
   **тоді** модуля там нет, а три существующих узла работают на своих версиях.
5. **Дано** человек с `library.use` без `library.publish`, **коли** он жмёт «Запропонувати
   в бібліотеку», **тоді** создаётся предложение `pending`, а `library_modules` не создаётся.
6. **Дано** версия `is_hotfix` и два места (в одном 5 активных прохождений, в другом ноль),
   **тоді** второе обновляется автоматически, первое остаётся `stale`, его автор получает
   `library_hotfix_blocked`.
7. **Дано** модуль `article` с 6 блоками `checklist` из 10, **тоді** в колонке «Тип» иконка
   чек-листа, а `content_kind` в API остаётся `article`.
8. **Дано** поиск «розведення», слова нет в названии, но есть в теле последней версии, **тоді**
   модуль «Використання хімії» есть в результатах.
9. **Дано** два тенанта с одинаковым `slug`, **коли** пользователь первого запрашивает модуль
   второго по id, **тоді** `404`, не `403`.

## 14. Сверено с эталоном

Источник — `(зовнішній пакет аудиту Sintegrum)/docs/05-tracks.md`, проход по установке Sintegrum.

| Что снято | Где в эталоне | Что взято в Lola |
| --- | --- | --- |
| Отдельный экран-таблица «Бібліотека модулів» на `/tracks/universal`, не граф | §5.1 | §5.1; путь изменён на `/library/modules` — «universal» в Lola занято категорией треков |
| Колонки «Тип» (иконка) и «Назва», строка «Пошук» | §5.1 | §5.1, эти колонки первыми; остальные добавлены как `[решение]` |
| Иконки типов: «T» (текст), чек-лист, файл/документ | §5.1 | §7.7 — маппинг на `resources.kind` плюс доминирующий блок, свой перечень не заводится |
| Формулировка «створено один раз — використовується у кількох треках» | §1, §5.1 | §1, §7.1 — прямое основание модели «ссылка, а не копия» |
| Пункт контекстного меню узла «Бібліотека модулів ▸» (подменю) | §5.4 | §5.4 — палитра вставки |
| Маркер узла-ссылки (сетка ромбиков внутри круга) | §5.5 | §5.4 — маркер плюс подпись «Бібліотека · v4» |
| Блочный редактор модуля, 13 типов блоков | §5.3 | не переносим: действует перечень `11` §3.3 (15 блоков), он шире и уже утверждён |
| Ни экрана версий, ни «где используется», ни архивирования | наблюдение по §5.1 | наши `[решение]`, см. §15 Г-31.2 |

Персональные данные и названия объектов чужого клиента не перенесены; «Використання хімії»
употреблено как родовое название инструкции.

## 15. Гипотезы и принятые по ним решения

**Г-31.1. Состав подменю «Бібліотека модулів ▸».** Подменю не раскрыто до конца (05-tracks.md
§5.4): неизвестно, плоский ли это список, разбит ли по категориям, есть ли внутри поиск.
При объёме в сотни записей плоское подменю нерабочее. `[решение]` Палитра с поиском, 8 последних
использованных и «Показати всі» → модалка с полной таблицей (§5.4). **Чем проверяется:** открыть
контекстное меню узла на эталоне и навести на пункт, дождавшись раскрытия подсписка.

**Г-31.2. Версионности в эталоне, скорее всего, нет.** Ни экрана версий, ни changelog у модуля
не обнаружено; поведение при правке используемого модуля не проверялось. По аналогии с `11`
§14.2 (LMS Collaborator перезаписывает материал на месте и лишь помечает флагом) вероятно, что
Sintegrum правит модуль на месте и изменение мгновенно видно во всех треках.
`[решение] Р-31.2` Не повторяем: ссылка + закреплённая версия, как в Г-11.3 для `resources`.
Причина та же — человек должен доучиться на том, что начал, а переаттестация должна отвечать
на вопрос «что именно изменилось в стандарте с прошлого раза». **Чем проверяется:** изменить
текст библиотечного модуля на эталоне и посмотреть, изменился ли узел в треке сразу.

**Г-31.3. Кто в эталоне может класть в библиотеку.** Права не снимались, экран виден под
административной учётной записью. `[решение] Р-31.6` `library.publish` — только author и admin,
остальные подают предложение (§6.3). **Чем проверяется:** зайти под учётной записью без
административных прав и проверить наличие пункта библиотеки в меню и кнопки создания модуля.

**Г-31.4. Что ищет строка «Пошук».** Поле видно, но не проверено, ищет ли оно по телу модуля
или только по названию. `[решение]` Гибрид: полнотекстовый по названию, описанию и меткам плюс
векторный по телу последней версии (§7.8). **Чем проверяется:** ввести слово, которого заведомо
нет ни в одном названии, но есть внутри текста модуля.

**Г-31.5. Может ли библиотечный модуль быть тестом.** Все увиденные модули контентные (текст,
чек-лист, файл), но полный список не просматривался. `[решение] Р-31.7` В R1 только контентный
модуль, тесты переиспользуются банками вопросов (`12`); в R2 расширение на `quiz`.
**Чем проверяется:** отфильтровать список эталона по колонке «Тип» и поискать иконку теста.

**Г-31.6. Счётчик «0.5K» над узлом графа.** Счётчик с иконкой «≡» (Г-05.2 исходного материала)
может быть числом прохождений именно **библиотечного** модуля суммарно по всем трекам — это была
бы естественная обратная связь «насколько модуль востребован». `[решение]` В Lola такое число
показываем, но в карточке модуля и отчёте «Використання бібліотеки» (§9), а на узле графа —
только «Бібліотека · v{n}»: цифры на канвасе мешают читать топологию. **Чем проверяется:**
сверить значение счётчика у одного модуля в двух разных треках — совпадение подтверждает
гипотезу, расхождение опровергает.
