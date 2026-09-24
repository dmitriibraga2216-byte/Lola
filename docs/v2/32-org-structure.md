# Lola LMS — ТЗ. 32. Оргструктура: конструктор и витрина

## 1. Назначение и границы

Оргструктура — **дерево подчинения**: кто кому подчиняется в сети. Экран `/org-structure` с двумя табами:
«Адмін — конструктор» (редактируемое дерево) и «Співробітник — перегляд» (read-only витрина). В базовом ТЗ
витрина уже заявлена (`21-hub.md` §1: «публічна оргструктура — R2»; `16-people.md` §5.3: «дерево: підрозділи
→ точки → люди»); этот документ поднимает её из производной картинки в самостоятельную редактируемую
сущность и делает источником истины для ответа «хто керівник людини X». Входит: дерево узлов, два вида
узлов, привязка людей, перетаскивание веток, валидация, журнал изменений, снимки, конфликты, импорт и
экспорт CSV, витрина, вывод руководителя для уведомлений. Не входит: справочники `positions` и `org_units`
(`16` §3.3), размещение `user_placements` (`16` §3.2), функциональные руководители `functional_chiefs` (`16`
§3.5) — модуль их потребляет, но не заменяет. Этап: R2, конструктор раньше витрины.

## 2. Роли и скоупы

Новые скоупы: `org.structure.view` (витрина), `org.structure.edit` (конструктор),
`org.structure.import` (импорт, экспорт, откат). Журнал смотрят через `audit.view`.

| Действие | employee | mentor | manager | author | admin |
| --- | :-: | :-: | :-: | :-: | :-: |
| Видеть витрину, себя и свою ветку в ней | ✓ | ✓ | ✓ | ✓ | ✓ |
| Видеть контакты в карточке узла | по настройке тенанта | ✓ | ✓ | по настройке | ✓ |
| Открывать таб «Адмін — конструктор» | — | — | ✓ (своя ветка) | — | ✓ |
| Создавать корневой узел, архивировать и восстанавливать узел | — | — | — | — | ✓ |
| Создавать и править дочерний узел, привязывать людей, перетаскивать | — | — | ✓ (своя ветка) | — | ✓ |
| Импорт, экспорт, откат к снимку | — | — | — | — | ✓ |
| Видеть журнал изменений структуры | — | — | ✓ (своя ветка) | — | ✓ |
| Разбирать конфликты структуры | — | — | — | — | ✓ |

«Своя ветка» для `manager` = поддерево узла, где он держатель. `[решение]` Права на таб
конструктора эталон не раскрывает; разрешаем частичное редактирование руководителю — иначе сеть
из 13 филиалов обслуживает один администратор.

## 3. Сущности и поля

### 3.1 Три разные вещи, которые нельзя смешивать

| Сущность | Таблица | На какой вопрос отвечает | Кардинальность |
| --- | --- | --- | --- |
| Подразделение (відділ) | `org_units` (базовое ТЗ) | «до якого шматка компанії належить» | дерево, ~12 записей |
| Должность (посада) | `positions` (базовое ТЗ) | «як називається робота» — справочник | плоский список, ~40 |
| Узел оргструктуры | `org_nodes` (этот документ) | «хто кому підпорядкований» — точка в дереве | дерево, сотни узлов |

**Пример, где разница видна.** Две точки, одно подразделение «Кухня», одна должность «кухар» — и четыре
узла: «Шеф-кухар точки А» (именной), «Кухарі точки А» (узел-посада, `headcount_planned=3`), «Шеф-кухар точки
Б», «Кухарі точки Б». Все четыре ссылаются на одно подразделение и те же должности, но подчинение разное:
кухари точки А подчиняются шефу точки А, а не подразделению «Кухня» и не шефу точки Б; подразделение на
вопрос «хто керівник» не отвечает вовсе. Обратный пример: узел «Директор філії» ссылается на должность
«керуючий», подразделение и филиал, но родитель у него — узел «СЕО». `[решение]` Узел не дублирует
справочники: `title` подставляется из `positions.name`, но может быть переопределён («Адміністратор
денний»).

### 3.2 `org_nodes` — узел дерева

| Поле | Тип | Обяз. | По умолчанию | Валидация | Комментарий |
| --- | --- | :-: | --- | --- | --- |
| `parent_id` | uuid | — | null | не свой потомок | null = корень |
| `path`, `depth`, `sort` | ltree, int, int | ✓ | —, 1, 0 | глубина ≤ 12 | путь как в `org_units`, уровень, порядок среди сиблингов |
| `type` | text | ✓ | `position` | `position` \| `employee` | вид узла, ниже |
| `title` | text | ✓ | из `positions.name` | 2…120, без `<` `>` | подпись на карточке |
| `position_id`, `org_unit_id`, `location_id` | uuid | — | null | значение существует и активно | должность, подразделение и точка узла |
| `holder_user_id` | uuid | — | null | только при `type='employee'` | кэш единственного держателя |
| `headcount_planned` | int | ✓ | 1 | 1…999, для `employee` = 1 | сколько людей предполагает узел |
| `is_manager_point`, `state` | boolean, text | ✓ | `false`, `vacant` | `vacant` \| `occupied` \| `archived` | даёт ли узел руководителя ветке ниже; состояние §4 |
| `external_key`, `note` | text | — | null | ≤64 и уникален, ≤2000 | ключ импорта; заметка, в витрине не видна |
| `created_by`, `archived_at` | uuid, timestamptz | ✓ / — | — / null | — | автор и дата архивации |

**Вид узла.** `type='position'` — штатная точка: карточка показывает `title` и счётчик «N з M», держателей
может быть несколько («Покоївки» — четверо), `holder_user_id` всегда null. `type='employee'` — именная
точка: аватар-инициалы, ФИО и e-mail, `headcount_planned=1`, `holder_user_id` заполнен, пока узел занят.
`[решение]` Тип хранится, а не вычисляется: при привязке человека к узлу-посаде с планом 1 конструктор
спрашивает «Зробити вузол іменним?» — «Так» переводит в `employee`, «Ні» оставляет посаду со счётчиком «1 з
1»; обратная конвертация разрешена всегда и держателей не снимает.

### 3.3 Остальные таблицы модуля

**`org_node_assignments` — кто занимает узел.** Источник истины по держателям (у узла-посады их несколько):
`node_id`, `user_id`, `placement_id` (связь с `user_placements`), `is_primary` (основная точка подчинения),
`role_in_node` (`holder` \| `acting` — в.о. \| `deputy` — заместитель), `started_at`, `ended_at`,
`ended_reason` (`moved` \| `dismissed` \| `node_archived` \| `manual`), `created_by`. История не удаляется:
отчёт за прошлый квартал показывает подчинение того времени.

**`org_manager_map` — проекция «человек → руководитель»**, её читают уведомления, дайджесты и отчёты вместо
обхода дерева: `user_id` (PK вместе с `tenant_id`), `manager_user_id`, `source` (`org_tree` \| `location` \|
`functional` \| `role_scope` \| `none`), `node_id`, `chain` (цепочка uuid снизу вверх, ≤12), `computed_at`.
Расчёт — §7.8, пересчёт — §11.

**`org_structure_snapshots` — снимки дерева**: `label`, `kind` (`manual` \| `auto_daily` \| `pre_import` \|
`pre_bulk_move`), `tree jsonb` (узлы и активные держатели), `node_count`, `created_by`; нужны для отката
реорганизации и сравнения «что изменилось за месяц».

> [исправлено, реализация PR-30 по решению `44` В-7: таблица уже существует под именем
> `org_conflicts` (миграция 0033, перечень расширен в 0038) и уже наполняется импортом людей.
> Новая таблица дала бы один конфликт двумя строками в отчёте, поэтому заводится **`alter table
> org_conflicts`** на две колонки: `severity` (`info | warning | critical` — как у существующего
> `security_severity`, а не своя пара `error | warning`) и `node_id`. `detected_at` не
> добавляется — это `created_at` из общих колонок; `status` не добавляется — состояние уже
> выражено парой `resolved_at` / `resolved_by`, и третье место для того же факта с ней
> разойдётся. Колонка называется `kind`, а не `code`. Перечень — **один список из десяти**:
> пять существующих (`double_unit`, `placement_replaced`, `manager_self`, `manager_cycle`,
> `unit_missing`) плюс пять новых (`no_manager`, `manager_mismatch`, `depth_exceeded`,
> `dismissed_holder`, `position_mismatch`). Три имени этого документа отброшены как
> переименования существующих: `self_manager` → `manager_self`, `multi_primary` →
> `double_unit`, `orphan_user` → `unit_missing`. Перечень зарегистрирован в
> `docs/02-data-model.md` §«Перечисления» и в `shared/enums.ts`]
> Ранее: «**`org_structure_conflicts` — журнал конфликтов**, … Поля: `code`, `severity`
> (`error` | `warning`), `user_id`, `node_id`, `details jsonb`, `source`, `status`
> (`open` | `resolved` | `ignored`), `resolved_by`, `resolved_at`, `detected_at`. Перечень
> `code`: `no_manager`, `manager_mismatch`, `self_manager`, `orphan_user`, `multi_primary`,
> `depth_exceeded`, `dismissed_holder`, `position_mismatch`»

**Журнал конфликтов** стыкуется с «Протокол конфліктів в оргструктурі» базового ТЗ (`16` §14):
система не падает на конфликте, а пишет строку и продолжает. Смысл значений: `manager_mismatch` —
дерево и `locations.manager_id` дают разных людей; `unit_missing` — активный человек вне дерева;
`dismissed_holder` — держатель архивирован, узел числится занятым.

### 3.4 DDL

```sql
create table org_nodes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  parent_id uuid references org_nodes(id) on delete restrict,
  path ltree not null, depth int not null default 1, sort int not null default 0,
  type text not null default 'position', title text not null, external_key text, note text,
  position_id uuid references positions(id) on delete restrict,
  org_unit_id uuid references org_units(id) on delete restrict,
  location_id uuid references locations(id) on delete restrict,
  holder_user_id uuid references users(id) on delete set null,
  headcount_planned int not null default 1, is_manager_point boolean not null default false,
  state text not null default 'vacant',
  created_by uuid references users(id), archived_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint org_nodes_type_chk  check (type in ('position','employee')),
  constraint org_nodes_state_chk check (state in ('vacant','occupied','archived')),
  constraint org_nodes_size_chk  check (depth between 1 and 12 and headcount_planned between 1 and 999),
  constraint org_nodes_named_chk check (type = 'employee' or holder_user_id is null),
  constraint org_nodes_one_chk   check (type = 'position' or headcount_planned = 1),
  unique (tenant_id, path), unique (tenant_id, external_key)
);
create index idx_org_nodes_tenant on org_nodes (tenant_id);
create index idx_org_nodes_parent on org_nodes (tenant_id, parent_id, sort);
create index idx_org_nodes_path on org_nodes using gist (path);
create index idx_org_nodes_holder on org_nodes (tenant_id, holder_user_id) where holder_user_id is not null;
create table org_node_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  node_id uuid not null references org_nodes(id) on delete cascade,
  user_id uuid not null references users(id) on delete restrict,
  placement_id uuid references user_placements(id) on delete set null,
  is_primary boolean not null default true, role_in_node text not null default 'holder',
  started_at date not null default current_date, ended_at date, ended_reason text,
  created_by uuid references users(id), created_at timestamptz not null default now(),
  constraint org_node_assignments_role_chk check (role_in_node in ('holder','acting','deputy')),
  constraint org_node_assignments_reason_chk check (ended_reason is null
    or ended_reason in ('moved','dismissed','node_archived','manual')),
  constraint org_node_assignments_period_chk check (ended_at is null or ended_at >= started_at)
);
create index idx_org_node_assignments_tenant on org_node_assignments (tenant_id);
create index idx_org_node_assignments_node on org_node_assignments (tenant_id, node_id) where ended_at is null;
create unique index uq_org_node_assignments_active on org_node_assignments (tenant_id, node_id, user_id) where ended_at is null;
create unique index uq_org_node_assignments_primary on org_node_assignments (tenant_id, user_id) where ended_at is null and is_primary;
create table org_manager_map (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  manager_user_id uuid references users(id) on delete set null,
  source text not null default 'none', node_id uuid references org_nodes(id) on delete set null,
  chain uuid[] not null default '{}', computed_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  constraint org_manager_map_source_chk check (source in ('org_tree','location','functional','role_scope','none')),
  constraint org_manager_map_self_chk check (manager_user_id is null or manager_user_id <> user_id)
);
create index idx_org_manager_map_tenant on org_manager_map (tenant_id);
create index idx_org_manager_map_manager on org_manager_map (tenant_id, manager_user_id);
create table org_structure_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  label text not null, kind text not null default 'manual', tree jsonb not null,
  node_count int not null default 0, created_by uuid references users(id),
  created_at timestamptz not null default now(),
  constraint org_structure_snapshots_kind_chk check (kind in ('manual','auto_daily','pre_import','pre_bulk_move'))
);
create index idx_org_structure_snapshots_tenant on org_structure_snapshots (tenant_id, created_at desc);
-- Вместо новой таблицы — расширение существующей (решение `44` В-7, миграция 0075).
alter table org_conflicts add column severity text not null default 'warning';
alter table org_conflicts add column node_id uuid references org_nodes(id) on delete cascade;
alter table org_conflicts add constraint org_conflicts_severity_check
  check (severity in ('info','warning','critical'));
alter table org_conflicts drop constraint org_conflicts_kind_check;
alter table org_conflicts add constraint org_conflicts_kind_check check (kind in (
  'double_unit','placement_replaced','manager_self','manager_cycle','unit_missing',
  'no_manager','manager_mismatch','depth_exceeded','dismissed_holder','position_mismatch'));
create index idx_org_conflicts_open on org_conflicts (tenant_id, severity, created_at desc)
  where resolved_at is null;
```

RLS на всех **четырёх** новых таблицах — `enable` + `force`, политика с `using` и `with check`
по `tenant_id`, доступ только через `withTenant()`. Пятой таблицы нет: `org_conflicts`
существует с миграции 0033 и свою политику уже имеет.

> [исправлено, реализация PR-30: целостность дерева стоит триггером `org_nodes_guard`
> (`deferrable initially deferred`), а не только в сервисе. Он проверяет, что путь ребёнка —
> это путь родителя плюс метка, ровно на уровень глубже, и что дети лежат под новым путём
> родителя. Этого достаточно, чтобы петля была невозможна: в строгом порядке по длине пути
> кольца не бывает. Отложенный, потому что перемещение ветки переписывает пути узла и всех
> потомков одним `update`, и немедленная проверка краснела бы на корректном перемещении]

## 4. Состояния и переходы

**Узел**: `vacant` (создан, держателей нет — «вакансія в структурі») → `occupied` (появился активный
держатель) → `vacant` (последний держатель снят) → `archived` (узел закрыт). Переходы: `vacant → occupied`
при создании назначения с `ended_at is null`; `occupied → vacant` когда закрылось последнее активное
назначение, при этом узел остаётся в дереве и подчинённые ветки не двигаются; `* → archived` только у узла
без детей и без активных держателей, иначе отказ «Спочатку перенесіть або архівуйте підлеглі вузли»;
`archived → vacant` — восстановление в течение 90 дней, если родитель жив. Физического удаления узла нет:
красная корзина эталона в Lola — архивация. **Назначение**: `active` (`ended_at is null`) → `ended`
(проставлены `ended_at` и `ended_reason`), обратного перехода нет — возврат человека создаёт новую запись.
**Конфликт**: `open` → `resolved` (устранён руками или пересчётом) \| `ignored` (принят как норма, в счётчик
ошибок не входит).

## 5. Экраны

### 5.1 `/org-structure`, таб «Адмін — конструктор»
Сверху: два таба, поиск по ФИО и названию узла, фильтры «Філія», «Підрозділ», «Посада», переключатель
«Показати вакансії», кнопки «Додати кореневий вузол», «Імпорт», «Експорт CSV», «Знімок», «Журнал змін».
Дерево вертикальное, родитель сверху, соединительные линии, ветка сворачивается кликом по счётчику. Карточка
узла: подпись (`title` либо ФИО с аватаром-инициалами и e-mail), бейдж филиала, счётчик «N з M» для
узлов-посад, серый пунктир для `vacant`; при наведении — четыре иконки эталона: человек («Прив'язати
співробітника»), **+** («Додати дочірній вузол»), карандаш («Редагувати»), красная корзина («Архівувати»).
Редактирование — боковая панель справа. Пустое состояние: «Структура ще не створена» + «Додати кореневий
вузол»; загрузка — скелетон из трёх уровней; ошибка — «Не вдалося завантажити структуру» + «Спробувати ще
раз», дерево на экране остаётся. Для `manager` узлы вне его ветки видны без иконок, drop запрещён.

### 5.2 Таб «Співробітник — перегляд», журнал и конфликты
Витрина — то же дерево без иконок управления, без `note`, без узлов с нулевым планом; свой узел подсвечен
бирюзовым, цепочка до корня раскрыта; клик по карточке — мини-профиль: ФИО, должность, филиал, контакты
(состав — по настройке тенанта); людей с `is_hidden=true` в витрине нет (`16` §7.5); пустое состояние —
«Структура компанії ще не опублікована». Экраны `/org-structure/changes` и `/org-structure/conflicts`
показывают выгрузки §9 с фильтрами; в строке конфликта — «Перейти до вузла», «Позначити вирішеним»,
«Ігнорувати».

> [дополнено, PR-39, патч `39` П-21 «Также»] Витрина — **единственная** публичная оргструктура:
> прежний экран хаба `/learn/org` (подразделения → точки → люди) ведёт сюда, плитка кабинета —
> тоже; справочное `GET /org/tree` оставлено экранам администрирования (`people.view`).
> Критерий §13 к.8 проверен и на этом входе (`tests/e2e/settings-39.spec.ts`).

## 6. Формы

### 6.1 Форма узла («Додати вузол» / «Редагувати вузол»)

| Поле | Контрол | Подсказка | Валидация | Текст ошибки |
| --- | --- | --- | --- | --- |
| Вид вузла | радио «Посада» / «Співробітник» | «Іменний вузол показує конкретну людину» | обязательно | «Оберіть вид вузла» |
| Посада | select из `positions` | «Довідник посад» | для `position` обязательна | «Оберіть посаду» |
| Назва вузла | text | «За замовчуванням — назва посади» | 2…120, без `<` `>` | «Назва від 2 до 120 знаків» |
| Співробітник | автокомплит | «Пошук за ПІБ або телефоном» | для `employee` обязателен, статус ≠ `archived` | «Оберіть співробітника» |
| Планова кількість | степпер | «Скільки людей передбачає вузол» | 1…999, для `employee` = 1 | «Для іменного вузла — рівно 1» |
| Керівна точка | чекбокс | «Від цього залежить, кому підуть сповіщення» | — | — |
| Філія / Підрозділ | два select | — | значение существует | «Оберіть значення зі списку» |
| Батьківський вузол | дерево-пикер | — | не свой потомок | «Не можна підпорядкувати вузол його ж нащадку» |
| Нотатка | textarea | «Не видно у вітрині» | ≤2000 | «Нотатка до 2000 знаків» |

Кнопки «Зберегти» / «Скасувати».
### 6.2 Диалоги привязки и перетаскивания, импорт CSV
Привязка: автокомплит человека, радио «Основне підпорядкування» / «Сумісництво», select роли («Тримач
посади» / «Виконувач обов'язків» / «Заступник»), дата начала (сегодня); если активное основное назначение
уже есть — «Людина вже має основне підпорядкування: {{node}}. Перенести сюди?» с выбором «Перенести» /
«Додати як сумісництво». Drop: «Перенести вузол «X» разом з N підлеглими вузлами до «Y»?» с чекбоксом
«Залишити підлеглі вузли на місці (підняти на рівень вище)». Импорт (шаги `16` §5.4): загрузка →
сопоставление колонок → предпросмотр с подсветкой («створити» зелёным, «оновити» жёлтым, «помилка» красным)
→ опции → запуск; опции «Створювати відсутні посади», «Архівувати вузли, яких немає у файлі», «Зробити
знімок перед імпортом» (включён, при >50 строках снять нельзя).

## 7. Правила и алгоритмы

1. **Корней несколько, максимум 10 на тенант** `[решение]`: реальная сеть держит отдельно
   «керуючу компанію» и операционную ветку. **Глубина ≤ 12**: 13-й уровень — ошибка
   «Максимальна глибина структури — 12 рівнів». **Запрет циклов**: узел нельзя подчинить себе
   или своему потомку, проверка `new_parent.path <@ node.path` → отказ, сработавший триггер
   пересчёта `path` пишет конфликт `manager_self` (`self_manager` этого документа — то же
   значение под существующим именем, решение `44` В-7).
2. **Путь уникален** (`unique (tenant_id, path)`), перемещение пересчитывает путь поддерева
   одним `update … set path = new_prefix || subpath(path, nlevel(old_prefix))`.
   **Перетаскивание переносит поддерево целиком**, альтернатива диалога §6.2 — дети поднимаются
   к деду; смена `sort` внутри одного родителя не перемещение, пишется как `org_node.reorder`.
3. **Каждое изменение структуры идёт в `audit_log`** с `request_context`: `org_node.create`,
   `org_node.update`, `org_node.move`, `org_node.reorder`, `org_node.archive`,
   `org_node.restore`, `org_node.assign_user`, `org_node.unassign_user`, `org_structure.import`,
   `org_structure.snapshot`, `org_structure.rollback`; в `details` — `before`/`after`
   по изменённым полям и число затронутых потомков.
4. **Человек может занимать несколько узлов**, но ровно одно назначение помечено `is_primary`
   (частичный уникальный индекс): основное определяет руководителя, совместительство даёт
   видимость в ветке и попадание в дайджест второго руководителя, линейного не меняет.
5. **Увольнение** (`users.status='archived'`) закрывает активные назначения с
   `ended_reason='dismissed'`, узел переходит в `vacant` и остаётся в дереве, подчинённые
   не переподчиняются; руководителю уровнем выше уходит `org_node_vacant`, подчинённым
   пересчитывается `org_manager_map`.
6. **Пустой узел — вакансия**: `state='vacant'` при `headcount_planned ≥ 1`, в витрине пунктир
   с подписью «Вакансія», в отчёте «Укомплектованість» — недобор; узел можно указать целевой
   точкой в вакансии, тогда при найме кандидат привязывается к нему автоматически. Если
   `position_id` узла ≠ должность в активном `user_placements` держателя — конфликт
   `position_mismatch` (`warning`), привязка не блокируется.
7. **Снимок** делается перед импортом, перед массовым перемещением (>20 узлов) и ежедневно
   в 03:00 по таймзоне тенанта, если за сутки были изменения; хранение — 30 ежедневных плюс все
   ручные и предымпортные, 365 дней. **Откат** пересоздаёт дерево и активные назначения
   по снимку, уволенные после снимка не восстанавливаются, сам откат пишется в `audit_log`
   и делает снимок «до отката». **Импорт** идёт через `import_jobs` (`source='csv'`,
   `options.entity='org_structure'`), ключ идемпотентности — `external_key`: сначала создаются
   все узлы, затем связываются родители, колонки — §9. **Витрина кэшируется** на 5 минут.

### 7.8 Кто руководитель сотрудника X `[решение]`

Единая функция `resolveManager(user_id)` — единственный вход для всего продукта (уведомления, дайджесты,
эскалации, «оценивать подчинённых» в `20`, отчёты по команде). Приоритет строгий:
1. **Дерево `org_nodes`**: берём активное `is_primary` назначение, поднимаемся вверх до ближайшего узла
   с `is_manager_point=true` и `state='occupied'`; его держатель (`role_in_node='holder'`, при отсутствии —
   `acting`) и есть линейный руководитель, `source='org_tree'`.
2. **Точка**: человека нет в дереве или вся ветка вверх вакантна → `locations.manager_id` его основного
   `user_placements`, `source='location'`.
3. **Роль в области**: и там пусто → носитель роли со скоупом `report.team`, назначенной на его `location`;
   при нескольких — с самым ранним `user_roles.created_at`, `source='role_scope'`.
4. Иначе `manager_user_id = null`, `source='none'`, пишется конфликт `no_manager`.

`functional_chiefs` (`16` §3.5) в этой цепочке **не участвуют**: функциональный руководитель —
отдельная ось и получает только те коды уведомлений, где адресат назван явно; так обе сущности
остаются осмысленными.

**Конфликт с существующим механизмом.** Сейчас руководитель выводится из
`user_placements`/`org_units`/`locations.manager_id`. После внедрения источником истины становится дерево, а
`locations.manager_id` понижается до резерва (шаг 2) и до материала первичного наполнения дерева. Переход:
флаг тенанта `org_structure_is_source_of_truth` в `tenants.settings`; пока дерево пусто — `false`, шаг 2
работает как шаг 1; первая публикация дерева с ≥5 узлами переводит флаг в `true` с подтверждением
администратора. При расхождении шага 1 и `locations.manager_id` **выигрывает дерево**, но пишется конфликт
`manager_mismatch` (`warning`): администратор либо правит поле точки, либо помечает `ignored`. Обоснование:
дерево — единственное место, где подчинение задано явно и с историей, а `locations.manager_id` — одно поле
на точку: оно не описывает подчинение внутри точки (шеф-кухар → кухарі) и ломается на совместителях.
Результат материализуется в `org_manager_map` в той же транзакции, что изменение дерева, для затронутого
поддерева; полная перестройка — фоновой задачей (§11).

## 8. Уведомления

| Код | Событие | Канал | Шаблон (uk) | Кому |
| --- | --- | --- | --- | --- |
| `org_node_assigned` | человека привязали к узлу | Telegram | «Вас додано до оргструктури: {{node_title}}. Керівник — {{manager_name}}.» | сотруднику |
| `org_manager_changed` | сменился руководитель | Telegram | «Ваш керівник змінився: тепер це {{manager_name}}.» | сотруднику и новому руководителю |
| `org_subordinate_added` | в ветке появился подчинённый | Telegram | «У вашій команді новий співробітник: {{user_name}} ({{node_title}}).» | руководителю |
| `org_node_vacant` | держатель снят или уволен | Telegram + e-mail | «Вузол «{{node_title}}» став вакантним.» | руководителю уровнем выше |
| `org_structure_conflict` | найден конфликт `severity='error'` | e-mail | «В оргструктурі виявлено {{count}} конфліктів.» | администраторам тенанта |
| `org_structure_import_finished` | импорт завершён | e-mail | «Імпорт оргструктури: створено {{created}}, оновлено {{updated}}, помилок {{errors}}.» | инициатору |
| `org_structure_rollback` | выполнен откат к снимку | e-mail | «Оргструктуру відкочено до знімка «{{label}}» від {{date}}.» | администраторам тенанта |

`org_manager_changed` и `org_subordinate_added` не `is_mandatory`; дайджест руководителю
(`digest.daily`, `digest.weekly` из `23`) собирает подчинённых по `org_manager_map`.

## 9. Отчёты и выгрузки

**«Укомплектованість структури»**: Вузол · Філія · Підрозділ · Посада · План · Факт · Вакансій · Керівник;
фильтры — филиал, подразделение, ветка, только вакантные, глубина. **«Оргструктура»** (экспорт CSV, он же
формат импорта, UTF-8 с BOM, разделитель `;`): `external_key` · `parent_external_key` · `type` · `title` ·
`position_name` · `org_unit_name` · `location_name` · `headcount_planned` · `is_manager_point` ·
`employee_external_id` · `assignment_role` · `assignment_started_at` · `sort`. **«Підпорядкування людей»**:
ПІБ · Посада · Філія · Вузол · Керівник · Джерело керівника (`source`) · Сумісництва · Дата початку
підпорядкування; фильтр «только `source ≠ org_tree`» показывает, у кого подчинение держится на резервных
правилах. **«Журнал змін структури»** (из `audit_log`): Дата · Автор · Дія · Вузол · Було · Стало ·
Зачеплено нащадків; фильтры — период, автор, действие, ветка. **«Конфлікти структури»**: Код · Важливість ·
Людина · Вузол · Виявлено · Статус; фильтры — код, важность, статус, период.

## 10. API

| Метод | Путь | Вход | Выход | Ошибки |
| --- | --- | --- | --- | --- |
| GET | `/org-structure/tree` | `?branch_id&depth&include_vacant&mode=admin\|view` | дерево узлов | `403 forbidden` |
| POST/GET/PUT | `/org-structure/nodes` \| `/nodes/:id` | тело §6.1 \| — | узел, держатели, путь | `422 validation_failed`, `409 depth_exceeded`, `409 node_archived`, `404` |
| POST | `/org-structure/nodes/:id/move` | `{parent_id, sort, keep_children}` | узел и число затронутых | `409 cycle_detected`, `409 depth_exceeded`, `409 stale_tree` |
| POST | `/org-structure/nodes/:id/archive` \| `/restore` | — | `{ok:true}` \| узел | `409 has_children`, `409 has_holders`, `409 parent_archived` |
| POST/DELETE | `/org-structure/nodes/:id/assignments` \| `/assignments/:id` | `{user_id, is_primary, role_in_node, started_at}` \| `{ended_reason}` | назначение \| `{ok:true}` | `409 primary_exists`, `422 user_archived`, `404` |
| GET | `/org-structure/manager/:userId` \| `/subordinates/:userId` | — \| `?deep=true` | `{manager_user_id, source, node_id, chain}` \| список людей | `404` |
| POST/GET | `/org-structure/snapshots` \| `/snapshots/:id/rollback` \| `/import` \| `/export` | `{label}` \| — \| `multipart`+`mapping` \| `?format=csv` | снимок \| `{job_id}` \| файл | `429 too_many_snapshots`, `409 rollback_in_progress`, `422 mapping_invalid` |
| GET/POST | `/org-structure/conflicts` \| `/conflicts/:id/resolve` | `?status&code` \| `{status}` | список \| конфликт | `404` |

Мутации идемпотентны по `Idempotency-Key`; чужой тенант — всегда `404`.

## 11. Фоновые задачи

| Задача | Расписание | Что делает |
| --- | --- | --- |
| `org.rebuild_manager_map` | по событию + еженочно 02:30 | пересчёт `org_manager_map` целиком или по поддереву |
| `org.validate_structure` | ежедневно 03:30 | прогон валидаторов §3.3, запись и закрытие конфликтов |
| `org.daily_snapshot` \| `org.snapshot_cleanup` | ежедневно 03:00 \| еженедельно | снимок при изменениях; чистка снимков старше 365 дней и ежедневных сверх 30 |
| `org.import_apply` \| `org.rollback_apply` | по запуску | применение CSV-импорта и отката к снимку |
| `org.sync_dismissals` | ежечасно | закрытие назначений архивированных людей, перевод узлов в `vacant` |

## 12. Крайние случаи

1. План 3, держателей пять: привязка не блокируется, счётчик «5 з 3» коралловым, в отчёте
   «Укомплектованість» — «Перебір».
2. Держатель привязан совместителем внутри собственной ветки: разрешено, руководитель считается
   по основному назначению, пишется `manager_self` (`warning`). Перемещение в вакантную ветку:
   подчинённые остаются, руководитель берётся уровнем выше, `source` остаётся `org_tree`.
3. Импорт принёс неизвестного родителя: строка в ошибки («Батьківський вузол {{key}}
   не знайдено»), остальные применяются; цикл A → B → A: обе строки в ошибки, конфликт
   `manager_self` с `source='import'`.
4. Два администратора тащат один узел: побеждает первая транзакция, вторая получает
   `409 stale_tree` — «Структуру змінив інший користувач, оновіть сторінку».
5. Удаление должности из `positions` запрещено (`on delete restrict`) — только деактивация.
   Дерево на 2000 узлов: витрина грузит корни и два уровня, глубже — по раскрытию, экспорт CSV
   уходит в фоновую задачу с письмом-ссылкой.
6. Человек с `is_hidden=true` в витрине не виден, но в расчёте руководителя участвует, в дереве
   на его месте «Вакансія». При `org_structure_is_source_of_truth=false` расхождения дерева
   и `locations.manager_id` копятся в `manager_mismatch` — видна цена переключения.

## 13. Критерии приёмки

1. **Дано** пустая структура, **коли** создан корневой узел-посада, **тоді** он виден со
   `state='vacant'`, в `audit_log` есть `org_node.create`; **коли** к нему с планом 3 привязали
   человека с ответом «Ні» на «Зробити вузол іменним?», **тоді** узел остаётся `type='position'`
   со счётчиком «1 з 3».
2. **Дано** именной узел с держателем, **коли** держателя архивировали, **тоді** узел переходит
   в `vacant` и остаётся в дереве, подчинённые получают руководителя уровнем выше, обеим
   сторонам уходит `org_manager_changed`.
3. **Дано** ветка глубиной 12, **коли** её тащат под узел 2-го уровня, **тоді**
   `409 depth_exceeded`; **дано** узел A и его потомок B, **коли** A подчиняют B, **тоді**
   `409 cycle_detected` и дерево не изменилось.
4. **Дано** человек с основным назначением, **коли** вызван `GET /org-structure/manager/:userId`,
   **тоді** возвращён держатель ближайшего узла с `is_manager_point=true`, `source='org_tree'`;
   **дано** человек вне дерева — руководитель взят из `locations.manager_id` с
   `source='location'` и создан конфликт `unit_missing` (`orphan_user` этого документа —
   то же значение под существующим именем, решение `44` В-7).
5. **Дано** дерево и `locations.manager_id` дают разных людей, **тоді** уведомления уходят
   человеку из дерева, а в конфликтах есть строка `manager_mismatch`.
6. **Дано** CSV на 120 строк, **коли** запущен импорт, **тоді** создан снимок `pre_import`,
   по завершении пришло `org_structure_import_finished` со счётчиками.
7. **Дано** неудачная реорганизация, **коли** выполнен откат, **тоді** дерево и активные
   назначения совпадают со снимком, уволенные после снимка не восстановлены, в `audit_log`
   есть `org_structure.rollback`.
8. **Дано** рядовой сотрудник на `/org-structure`, **тоді** таб конструктора недоступен
    и иконки не отрисованы; **дано** `manager`, **коли** он тащит узел за пределы своей ветки,
    **тоді** drop запрещён с подсказкой «Ви можете змінювати лише свою гілку».

## 14. Сверено с эталоном

Проверено по материалам аудита Sintegrum (`10-settings.md` §10.3, §10.4, §10.5), экран `/org-structure`.
Снято дословно: заголовок «Оргструктура»; два таба «Адмін — конструктор» и «Співробітник — перегляд»; кнопка
«Додати кореневий вузол»; иерархическое дерево родитель→дети с вертикальными соединительными линиями (не
свободный граф); четыре иконки на карточке при наведении (человек, плюс, карандаш, корзина); **два вида
узлов** — узел-посада (только название) и узел-конкретный сотрудник (аватар-инициалы, ФИО, e-mail), причём
именные узлы стоят на руководящих точках. Отдельными экранами эталон держит `/jobs` («Керування посадами»:
Назва посади · Опис · Треки · Статус) и `/departments` («Керування відділами»: Статус · Відділ) — это
подтверждает, что справочники должностей и отделов не являются деревом подчинения, а дерево живёт третьей
сущностью; в Lola справочники уже есть, поэтому новое — только узлы и всё вокруг них. Не подтверждено
эталоном и принято как решение Lola: `is_manager_point`, `headcount_planned`, история назначений, снимки и
откат, конфликты, CSV-импорт, ограничение глубины, права `manager` на свою ветку — обоснования в §15.
Персональные данные руководителей эталона не перенесены, названия филиалов и должностей чужого клиента
заменены обобщёнными.

## 15. Гипотезы и принятые по ним решения

- **Г-32.1 — один корень или несколько.** Число корней не проверено. `[решение]` до 10 корней.
  *Чем проверяется*: создать второй корень на эталоне.
- **Г-32.2 — есть ли перетаскивание.** Не проверено. `[решение]` вводим с переносом поддерева
  целиком. *Чем проверяется*: потащить карточку узла.
- **Г-32.3 — увольнение держателя именного узла.** `[решение]` узел остаётся и становится
  `vacant`. *Чем проверяется*: заархивировать привязанного к узлу сотрудника.
- **Г-32.4 — два узла на одного человека.** Не проверено. `[решение]` можно, но ровно одно
  назначение основное. *Чем проверяется*: привязать человека к двум узлам.
- **Г-32.5 — ограничение глубины.** Не проверено. `[решение]` 12 уровней (ветка эталона —
  4–5). *Чем проверяется*: построить ветку из 13 уровней.
- **Г-32.6 — связь узла с филиалом и подразделением.** На карточке видна только подпись.
  `[решение]` поля необязательные, но нужны для фильтров и отчёта. *Чем проверяется*: открыть
  форму редактирования узла.
- **Г-32.7 — импорт и экспорт структуры.** Не найдены. `[решение]` CSV через `import_jobs`:
  300+ узлов руками неприемлемо. *Чем проверяется*: кнопка импорта на экране.
- **Г-32.8 — права на таб конструктора.** Эталон показывает его как режим, не как право.
  `[решение]` скоуп `org.structure.edit`, руководителю — своя ветка. *Чем проверяется*: открыть
  `/org-structure` под ролью уровня `manager`.
