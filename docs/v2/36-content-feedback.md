# Lola LMS — ТЗ. 36. Обратная связь по контенту («Звіт про помилки»)

## 1. Назначение и границы

Человек проходит курс и видит ошибку: опечатку, битую ссылку, неоткрывающийся файл, видео без звука, устаревший
факт, некорректный вопрос теста. Сегодня он либо молчит, либо пишет наставнику в мессенджер — до автора контента
это не доходит никогда. Модуль убирает разрыв: кнопка «Повідомити про помилку» есть на каждом экране прохождения,
жалоба уходит одним нажатием вместе с автоматически собранным контекстом, попадает в очередь автора/методиста,
разбирается и закрывается ответом заявителю.

Модуль дешёвый — одна форма из двух полей, одна очередь, один жизненный цикл, — а эффект непропорционально большой:
это единственный канал, где качество контента меряется не мнением автора, а поведением тех, кто по нему учится.
Отсюда два требования, которым подчинено всё остальное: **минимум трения для заявителя** (два тапа, ноль
обязательных полей, не выходя из урока) и **максимум контекста для автора** (открыл жалобу — сразу видит, что было
на экране, в какой версии и какой ответ дал человек).

Входит: точки входа из прохождения, сбор контекста, типы проблем, склейка дубликатов, жизненный цикл, маршрутизация,
ответ заявителю, защита от злоупотребления, связь с пересчётом результатов теста, отчёт качества контента.
Не входит: редактор контента и версионирование (`11`), редактор вопросов и механика попыток (`12`), очередь ручной
проверки заданий (`05` §5.14.7 — там проверяют людей, а не контент), техподдержка платформы (`24`), комментарии
под уроком (`11` §3.1 `allow_comments`, R2 — это разговор, а не дефект).

## 2. Роли и скоупы

| Действие | employee | mentor | manager | author | admin |
| --- | :-: | :-: | :-: | :-: | :-: |
| Подать жалобу из экрана прохождения | ✓ | ✓ | ✓ | ✓ | ✓ |
| Видеть свои жалобы и их статус | ✓ | ✓ | ✓ | ✓ | ✓ |
| Видеть очередь «Звіт про помилки» | — | — | по своим точкам | по своему контенту | ✓ |
| Брать в работу, менять статус, отклонять | — | — | — | ✓ | ✓ |
| Переназначить на другого | — | — | — | — | ✓ |
| Запускать пересчёт результатов теста | — | — | — | — | ✓ |
| Править маршрутизацию, блокировать заявителя | — | — | — | — | ✓ |
| Видеть отчёт качества контента | — | — | ✓ | ✓ | ✓ |

Новые скоупы: `content_issue.report` (по умолчанию у всех), `content_issue.view`, `content_issue.triage`,
`content_issue.assign`, `content_issue.rescore`, `content_issue.mute`. Два последних намеренно отделены от `triage`:
автор правит вопрос, но менять уже выставленные людям результаты может только администратор.

## 3. Сущности и поля

Пять таблиц. `content_issues` — карточка проблемы: один дефект в одном элементе контента одной версии, все жалобы
на него попадают в неё, а не плодят строки. `content_reports` — отдельное обращение человека, привязанное
к карточке. `content_issue_events` — журнал карточки (кто, что сделал, переход статусов, комментарий, флаг
`is_internal` — внутренняя заметка, заявителю не видна). `content_issue_routing_rules` — правила адресации: фильтр
по типу элемента, типу проблемы и категории курса → человек или роль, выигрывает правило с наименьшим `sort` (§7.5).
`content_reporter_stats` — репутация заявителя: подано, подтверждено, отклонено, спам, спама подряд, `muted_until`.

### 3.1 Ключевые поля

Поля, смысл которых из имени не выводится (типы, умолчания и полный набор ограничений — в DDL §3.2):

| Поле | Тип | Обяз. | По умолчанию | Валидация | Комментарий |
| --- | --- | :-: | --- | --- | --- |
| `issues.target_type` | text | ✓ | | 9 значений, DDL | материал, урок, блок, тест, вопрос, практикум, опрос, статья, медиа |
| `issues.block_id` | uuid | — | null | есть в `body` | блок внутри материала (`11` §3.3) — чтобы автор понял, какой абзац |
| `issues.content_version` | int | ✓ | | ≥1 | версия материала/вопроса на момент жалобы |
| `issues.issue_type` | text | ✓ | | 11 значений, §7.3 | фильтр «Тип» эталона |
| `issues.resolution_comment` | text | — | null | ≤1000, обязателен при `not_an_error`, `wont_fix`, `spam` | виден заявителям |
| `issues.reports_count` | int | ✓ | 1 | ≥1 | сколько человек пожаловались — сортировка очереди |
| `issues.severity` | text | ✓ | `normal` | `blocking`\|`normal`\|`cosmetic` | считает система, не человек, §7.4 |
| `issues.affects_scoring` | boolean | ✓ | false | | дефект влияет на выставленные баллы |
| `issues.rescore_state` | text | ✓ | `none` | 5 значений, DDL | §7.8, ключевое поле модуля |
| `issues.dedupe_key` | text | ✓ | §7.2 | уникален среди незакрытых | склейка дубликатов |
| `issues.course_ids` | uuid[] | ✓ | `{}` | | где встречается элемент — колонка «Трек» |
| `reports.comment` | text | — | null | ≤1000; обязателен при `other`, `wrong_fact`, `bad_question`, `wrong_key` | единственное, что человек печатает |
| `reports.context` | jsonb | ✓ | `{}` | §7.1 | собирается системой, не человеком |
| `reports.attempt_id` | uuid | — | null | FK `attempts` | жалоба подана во время попытки |
| `reports.question_version` | int | — | null | | версия вопроса из снапшота попытки |
| `reports.notified_at` | timestamptz | — | null | | когда заявителю ушёл ответ по закрытию |

### 3.2 DDL

```sql
create table content_issues (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  target_type text not null check (target_type in ('resource','lesson','block','quiz','question','workshop','survey','knowledge_article','media')),
  target_id uuid not null, block_id uuid,
  content_version int not null default 1 check (content_version >= 1),
  issue_type text not null check (issue_type in ('typo','wrong_fact','outdated','unclear','broken_media','broken_link','broken_file','bad_question','wrong_key','tech','other')),
  title text not null check (char_length(title) between 3 and 200),
  status text not null default 'new' check (status in ('new','in_progress','fixed','rejected','deferred','closed')),
  resolution text check (resolution in ('fixed','question_fixed','question_void','not_an_error','duplicate','wont_fix','spam')),
  resolution_comment text check (char_length(resolution_comment) <= 1000),
  reports_count int not null default 1 check (reports_count >= 1),
  first_reported_at timestamptz not null default now(), last_reported_at timestamptz not null default now(),
  assignee_id uuid references users(id) on delete set null, assigned_at timestamptz,
  severity text not null default 'normal' check (severity in ('blocking','normal','cosmetic')),
  affects_scoring boolean not null default false,
  rescore_state text not null default 'none' check (rescore_state in ('none','needed','in_progress','done','skipped')),
  rescored_attempts int not null default 0, dedupe_key text not null,
  course_ids uuid[] not null default '{}', due_at timestamptz, closed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index idx_content_issues_tenant on content_issues (tenant_id);
create unique index uq_content_issues_open_dedupe on content_issues (tenant_id, dedupe_key) where status <> 'closed';
create index idx_content_issues_queue on content_issues (tenant_id, status, last_reported_at desc);
create index idx_content_issues_target on content_issues (tenant_id, target_type, target_id);
create index idx_content_issues_rescore on content_issues (tenant_id, rescore_state) where rescore_state = 'needed';

create table content_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  issue_id uuid not null references content_issues(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  comment text check (char_length(comment) <= 1000), context jsonb not null default '{}'::jsonb,
  screenshot_media_id uuid references media_assets(id) on delete set null,
  enrollment_id uuid references enrollments(id) on delete set null,
  lesson_id uuid references lessons(id) on delete set null,
  attempt_id uuid references attempts(id) on delete set null, question_version int,
  source text not null default 'lesson' check (source in ('lesson','attempt','workshop','catalog','knowledge','review')),
  notified_at timestamptz, created_at timestamptz not null default now()
);
create index idx_content_reports_tenant on content_reports (tenant_id);
create index idx_content_reports_issue on content_reports (tenant_id, issue_id, created_at desc);
create index idx_content_reports_attempt on content_reports (tenant_id, attempt_id) where attempt_id is not null;
create unique index uq_content_reports_once on content_reports (tenant_id, issue_id, user_id);

create table content_issue_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  issue_id uuid not null references content_issues(id) on delete cascade,
  actor_id uuid references users(id) on delete set null,
  kind text not null check (kind in ('created','merged','status_changed','assigned','commented','rescored','reopened')),
  from_status text, to_status text, comment text check (char_length(comment) <= 2000),
  payload jsonb not null default '{}'::jsonb, is_internal boolean not null default false,
  created_at timestamptz not null default now()
);
create index idx_content_issue_events_tenant on content_issue_events (tenant_id);
create index idx_content_issue_events_issue on content_issue_events (tenant_id, issue_id, created_at);

create table content_issue_routing_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  sort int not null default 100, target_type text, issue_type text,
  category_id uuid references course_categories(id) on delete cascade,
  assignee_user_id uuid references users(id) on delete set null,
  assignee_role_id uuid references roles(id) on delete set null,
  fallback boolean not null default false, is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (assignee_user_id is not null or assignee_role_id is not null)
);
create index idx_content_issue_routing_rules_tenant on content_issue_routing_rules (tenant_id);
create index idx_content_issue_routing_rules_order on content_issue_routing_rules (tenant_id, is_active, sort);

create table content_reporter_stats (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  reports_total int not null default 0, confirmed_count int not null default 0,
  rejected_count int not null default 0, spam_count int not null default 0,
  consecutive_spam int not null default 0, muted_until timestamptz,
  muted_by uuid references users(id) on delete set null,
  mute_reason text check (char_length(mute_reason) <= 300),
  last_report_at timestamptz, updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index idx_content_reporter_stats_tenant on content_reporter_stats (tenant_id);
```

RLS на всех пяти таблицах (`enable` + `force`), политика по `tenant_id` с `using` и `with check`, доступ только
через `withTenant()`.

## 4. Состояния и переходы

`new` («Нова») → `in_progress` («В роботі») → `fixed` («Виправлено») → `closed` («Закрито»); ветки
`new|in_progress → rejected` («Відхилено») и `new|in_progress → deferred` («Відкладено»).

| Переход | Кто | Условие |
| --- | --- | --- |
| `new → in_progress` | author, admin | назначил себя или назначен правилом §7.5 |
| `in_progress → fixed` | author, admin | обязателен `resolution` = `fixed`\|`question_fixed`\|`question_void` |
| `fixed → closed` | система | опубликована версия выше `content_version` и `rescore_state ≠ needed` |
| `fixed → closed` | admin | вручную, если правка сделана вне версии |
| `* → rejected` | author, admin | обязателен `resolution_comment` |
| `* → deferred` | author, admin | обязателен `due_at` |
| `rejected|closed → in_progress` | admin | только вручную |

Автоматического переоткрытия нет: новая жалоба после `closed` создаёт **новую** карточку (уникальный индекс
`dedupe_key` действует только среди незакрытых), её событие `created` ссылается на предыдущую — так история
«чинили трижды» не теряется.

## 5. Экраны

**5.1 Кнопка «Повідомити про помилку» (прохождение).** Плеер урока (`11` §5.5): иконка флажка в шапке рядом
с крестиком и пункт в меню «…». Долгий тап (наведение на десктопе) на блоке `text`, `image`, `video`, `file`,
`embed`, `table` даёт точечный флажок — подставится `block_id`. Экран попытки теста (`12`) — флажок в строке
вопроса, всегда виден, варианты ответа не перекрывает. Практикум (`13`) — в карточке задания. База знаний (`21`) —
в шапке статьи. Каталог (`10`) — флажка нет: там нечему быть неверным.

**5.2 Форма жалобы (модалка, mobile-first).** Список типов крупными кнопками (одно нажатие) и поле «Що не так?»,
необязательное для 7 типов из 11. Внизу серым: «Ми вже бачимо, де ти зараз: урок «…», версія 4, питання 3».
Кнопки «Надіслати» (солнечная) и «Скасувати». После отправки — тост «Дякуємо. Ми розберемось і повідомимо тобі»
и возврат ровно туда, где человек был: урок не перезагружается, таймер попытки не сбрасывается. Если открытая
карточка на этот элемент уже есть — «Про це вже повідомили — ми додамо твій голос» и одна кнопка «Підтвердити»:
это склейка глазами заявителя.

**5.3 «Звіт про помилки» — очередь (`/content-issues`).** Вкладки-фильтры: «Нові» (по умолчанию) · «В роботі» ·
«Виправлені» · «Відхилені» · «Усі». Фильтры: **Тип** (селект, как на эталоне), Трек/курс, Тип елемента, Автор
контенту, Відповідальний, Точка заявника, Період, «Тільки ті, що впливають на бали». Колонки: Тип · Елемент ·
**Трек** · Кількість скарг · Статус · Відповідальний · Остання скарга · Термін (просроченные — коралловые).
Сортировка по умолчанию `reports_count desc, last_reported_at desc`: сначала то, на что жалуются многие. Массовые
действия: назначить, отклонить с общей причиной, отложить. 10/25/50/100 на странице. Пусто: «Скарг немає. Це добре —
або про кнопку ніхто не знає» + ссылка на отчёт «Скарг на 100 проходжень». Загрузка — скелет на 10 строк.
Ошибка — «Не вдалося завантажити список» и «Спробувати ще раз».

**5.4 Карточка жалобы.** Слева: тип, элемент со ссылкой «Відкрити як учень» (открывает именно ту версию контента,
а для вопроса — именно тот вариант из снапшота), заявители с комментариями и скриншотами, журнал событий. Справа:
статус, ответственный, срок, severity и блок «Вплив на результати» — сколько попыток содержат вопрос, сколько людей
провалили тест из-за него, кнопка «Перерахувати результати» (§7.8). Внизу: «Виправлено», «Відхилити», «Відкласти»,
поле внутренней заметки. Manager видит карточку только по своим точкам, без кнопок разбора.

**5.5 «Мої повідомлення про помилки» (сотрудник).** Вкладка профиля: тип, элемент, дата, статус простыми словами
(«Розглядається», «Виправлено», «Не підтвердилось»), ответ автора. Пусто: «Ти ще не повідомляв про помилки.
Побачиш щось дивне — тисни на прапорець».

## 6. Формы

**6.1 Жалоба.**

| Поле | Контрол | Обяз. | Валидация | Ошибка (uk) |
| --- | --- | :-: | --- | --- |
| Тип проблеми | список из 11 кнопок | ✓ | значение §7.3 | «Оберіть тип проблеми» |
| Що не так? | текст, подсказка «Одним реченням — цього досить» | по типу | 10–1000 | «Опишіть проблему хоча б одним реченням» |
| Скріншот | загрузка изображения | — | jpg/png/webp, ≤5 МБ | «Файл завеликий, максимум 5 МБ» |

Отказы формы: лимит — «Ти вже надіслав 5 повідомлень сьогодні. Спробуй завтра»; mute — «Надсилання повідомлень
тимчасово недоступне. Звернись до адміністратора»; архив — «Цей матеріал більше не використовується».

**6.2 Разбор (автор).**

| Поле | Контрол | Обяз. | Валидация |
| --- | --- | :-: | --- |
| Результат | радио: «Виправлено» / «Питання виправлено» / «Питання анульовано» / «Не є помилкою» / «Не будемо виправляти» | ✓ | |
| Коментар для заявника | текст | ✓ при трёх последних значениях | 10–1000 |
| Внутрішня нотатка | текст | — | ≤2000, заявителю не видна |
| Впливає на бали | переключатель | — | только для `quiz` и `question` |
| Термін | дата | ✓ при «Відкласти» | ≤180 дней вперёд |

**6.3 Правило маршрутизации (admin).** Порядок (число), Тип елемента (селект + «Будь-який»), Тип проблеми
(селект + «Будь-який»), Категорія курсу, Призначити на (людина или роль), «Запасне правило», Активне. Валидация:
ровно одно запасное правило на тенант — «Має бути одне запасне правило».

## 7. Правила и алгоритмы

1. **Сбор контекста.** Человек ничего не описывает словами: при открытии формы в `context` кладутся `course_id`,
   `course_version_id`, `lesson_id`, `item_type`, `item_id`, `block_id`, `content_version`, `enrollment_id`,
   `assignment_id`, `attempt_id`, `attempt_no`, `question_id`, `question_version`, `given_answer` (ответ человека,
   если он уже дан), `scroll_pct`, `player_position_sec`, `device`, `viewport`, `user_agent`, `locale`, `url`,
   `client_ts`; сервер добавляет `server_ts` и `request_context`. Ни одно поле не вводится руками и не показывается
   как форма — только строкой-подтверждением (§5.2).
2. **Склейка дубликатов.** `dedupe_key = target_type:target_id:block_id|-:issue_type:content_version`. Есть открытая
   карточка с этим ключом — создаётся только `content_reports`, у карточки `reports_count += 1`,
   `last_reported_at = now()`, событие `merged`. Повторная жалоба того же человека на тот же ключ — 409
   `content_issue.already_reported`, счётчик не растёт (индекс `uq_content_reports_once`).
3. **Типы проблем** (закрытый список, он же фильтр «Тип» эталона) `[решение]`: `typo` «Помилка в тексті» ·
   `wrong_fact` «Невірна інформація» · `outdated` «Застаріла інформація» · `unclear` «Незрозуміло пояснено» ·
   `broken_media` «Не відтворюється відео або аудіо» · `broken_link` «Не працює посилання» · `broken_file`
   «Не відкривається файл» · `bad_question` «Некоректне питання» · `wrong_key` «Невірна правильна відповідь» ·
   `tech` «Технічна проблема» · `other` «Інше». Список построен не по предметности, а по тому, **кто чинит и чем**:
   `typo`/`unclear` — правка текста автором, баллов не касается; `wrong_fact`/`outdated` — содержательная правка
   со сверкой у владельца стандарта; три `broken_*` разведены потому, что это три разные починки (перезалить медиа,
   поменять URL, заменить файл) и все три проверяются автоматически (§11); `bad_question`/`wrong_key` — единственные,
   что тянут пересчёт результатов; `tech` уходит администратору, а не автору; `other` есть, чтобы человек не бросил
   жалобу на полпути, и требует комментария.
4. **Severity** считает система: `blocking` при `issue_type in (broken_media, broken_file, broken_link, tech)` либо
   если урок обязателен (`lessons.is_required`); `cosmetic` для `typo` и `unclear`; иначе `normal`.
5. **Маршрутизация.** По порядку: (а) первое активное правило по `sort`, совпавшее по `target_type`, `issue_type`,
   `category_id`; (б) первый из `author_ids` материала или теста со статусом `active`; (в) владелец категории курса,
   если все авторы неактивны (уволены, заблокированы); (г) запасное правило тенанта; (д) любой носитель
   `content_issue.triage` с наименьшим числом открытых карточек. Увольнение ответственного разбирает
   `content_issue.reassign_scan`.
6. **SLA.** `due_at = created_at +` 2 рабочих дня для `blocking`, 7 — `normal`, 30 — `cosmetic`. Просрочка 1 день —
   напоминание ответственному, 3 — его руководителю, 7 — администратору с переназначением по §7.5 (д).
7. **Жалоба на вопрос во время попытки: попытка не блокируется** `[решение]`. Блокировка превратила бы кнопку
   в оружие («не знаю ответ — жалуюсь») и сломала таймер, аудит и статистику; молчание обесценило бы самый ценный
   сигнал. Поэтому жалоба фиксируется, человек отвечает как обычно, ответ оценивается по снапшоту (`12` §7.4 —
   снапшот неизменен всегда). Три ограничения, снимающих несправедливость: (а) не больше одной жалобы на вопрос
   за попытку и не больше трёх за попытку; (б) при `time_limit_sec` время в форме компенсируется сдвигом
   `deadline_at` — до 60 секунд на жалобу и не больше 180 за попытку, факт пишется в `content_issue_events.payload`;
   (в) карточка сразу получает `affects_scoring = true` и `rescore_state = needed`, то есть попадает в очередь
   с пометкой «впливає на бали» и не может быть тихо закрыта.
8. **Пересчёт результатов после подтверждения** `[решение]` — продолжение кнопки **«Перерахувати»** из отчёта
   по тесту (`22` §13.7, `05` §5.14.8). Подтверждение жалобы `bad_question`/`wrong_key` даёт две резолюции:
   `question_fixed` (ключ исправлен, вопрос пересчитывается по новому эталону) и `question_void` (вопрос негоден,
   исключается из знаменателя: `score = Σ баллов без него / Σ весов без него × 100`). Дальше — массовый пересчёт
   прямо из карточки: администратор жмёт «Перерахувати результати», видит предпросмотр «Зміниться 37 спроб із 214,
   з них 12 стануть «ВИКОНАНО», 0 стануть «ПРОВАЛЕНО», середній бал +4.1», указывает причину и подтверждает.
   Выборка — попытки, чей `snapshot` содержит этот `question_id` версии ≤ `content_version`, статус
   `submitted`/`graded`, за последние 365 дней; аннулированные и незавершённые не трогаются. Снапшот попытки
   не переписывается никогда: создаётся новая запись результата со ссылкой `issue_id` и причиной, прежнее значение
   остаётся в истории (`12` §7.11). **Результат может только улучшиться**: `passed=false → true` применяется,
   обратный переход не применяется ни при каких условиях — отобрать зачтённое нельзя; такие попытки перечисляются
   в отчёте о пересчёте отдельным списком. Выданный сертификат не отзывается; при улучшении до `passed` сертификат
   выдаётся, если предусмотрен назначением; смена `passed` запускает `enrollment.recalc` (`10` §11). Каждый пересчёт
   пишется в `audit_log` с `issue_id`, числом затронутых попыток и причиной; повторный по той же карточке запрещён
   (`rescore_state = done`) — нужна новая карточка. Администратор вправе выбрать `skipped` («не перераховувати»),
   тогда обязателен комментарий, видимый заявителям.
9. **Что считается закрытием.** Карточка закрывается, только когда: стоит `resolution`; для `fixed`/`question_fixed`
   опубликована версия контента выше `content_version`; `rescore_state ≠ needed`; всем заявителям отправлено
   уведомление. Правка в черновике закрытием не считается — пока версия не опубликована, люди видят ту же ошибку.
10. **Ограничение частоты** `[решение]`: не больше 5 жалоб в сутки и 20 за календарный месяц на человека; не больше
    3 за одну попытку теста; не больше 1 на тот же `dedupe_key`. Превышение — 429 `content_issue.rate_limited`.
    К носителям `content_issue.triage` лимиты не применяются.
11. **Поток пустых жалоб.** Резолюция `spam` увеличивает `spam_count` и `consecutive_spam`; три подряд за 30 дней
    дают `muted_until = now() + 14 дней` автоматически, с уведомлением человеку и его руководителю. Любая
    подтверждённая жалоба обнуляет `consecutive_spam`. Снимает mute администратор. Заявители с долей подтверждения
    выше 60% при не менее 5 жалобах получают метку «надійний» — их карточки идут выше при равном `reports_count`.
12. **Мотивация** `[решение]`: подтверждённая жалоба (`fixed`, `question_fixed`, `question_void`) даёт 10 баллов
    в `points_ledger` с источником `content_issue`, пятая — бейдж «Уважний». За отклонённые баллы не снимаются:
    иначе люди перестанут жаловаться, а это ровно то, что модуль предотвращает.
13. **Архивный контент.** Жалоба на `archived` принимается, но карточка создаётся с `severity = cosmetic`,
    подсказкой автору «Матеріал в архіві» и без SLA.

## 8. Уведомления

| Код | Событие | Канал | Кому | Шаблон (суть) |
| --- | --- | --- | --- | --- |
| `content_issue_created` | создана карточка | in-app, telegram | ответственный | «Нова скарга на «{{item.title}}»: {{issue.type_label}}» |
| `content_issue_merged` | 3-я и каждая 5-я жалоба | in-app | ответственный | «Вже {{issue.reports_count}} скарг на «{{item.title}}»» |
| `content_issue_blocking` | карточка `severity=blocking` | telegram | ответственный, admin | «Контент не працює: {{item.title}}» |
| `content_issue_overdue` | просрочка 1/3/7 дней | in-app, telegram | ответственный → руководитель → admin | «Скарга прострочена на {{days}} дн.» |
| `content_issue_accepted` | `new → in_progress` | in-app | заявители | «Твоє повідомлення прийняли в роботу» |
| `content_issue_fixed` | закрытие с исправлением | in-app, telegram | заявители | «Помилку виправлено. Дякуємо — {{points}} балів» + `{{link}}` |
| `content_issue_rejected` | `→ rejected` | in-app | заявители | «Ми перевірили: {{issue.resolution_comment}}» |
| `content_issue_rescore_ready` | `rescore_state = needed` | in-app, email | admin | «{{count}} спроб можна перерахувати» |
| `content_issue_rescored` | пересчёт применён | in-app, telegram | те, чей результат изменился | «Питання виправили, твій результат перераховано: {{score_old}} → {{score_new}}» |
| `content_reporter_muted` | авто-mute | in-app | человек, его руководитель | «Надсилання повідомлень призупинено до {{until}}» |

Все коды, кроме `content_issue_blocking` и `content_issue_overdue`, — `is_mandatory=false`. `content_issue_merged`
троттлится `{max_per_day: 3, per_subject: true}`. Тихие часы применяются ко всем (`23` §6.3). Новых каналов нет.

## 9. Отчёты и выгрузки

**«Якість контенту»** — главный отчёт модуля, строки — элементы контента. Колонки: Елемент · Тип · **Трек** ·
Автор · Проходжень за період · Скарг · **Скарг на 100 проходжень** · Підтверджено · Відхилено · Середній час
до виправлення · Відкриті зараз. Сортировка по «Скарг на 100 проходжень»: нормировка обязательна, иначе в топ
попадёт самый популярный курс, а не худший. Фильтры: период, категория, автор, тип проблемы, тип элемента, точка.
**«Скарги»** — плоская выгрузка карточек: дата, тип, элемент, трек, версия, заявителей, статус, резолюция,
ответственный, срок, просрочка, пересчёт; CSV и XLSX. **«Дисципліна авторів»** — открытых, просрочено, среднее
время до `fixed`, доля отклонённых. **«Проблемні питання»** — только `bad_question`/`wrong_key`: вопрос, тест,
доля неверных ответов, число жалоб, пересчитано ли; вместе со статистикой вопросов (`12` §11) даёт диагноз —
вопрос с долей ошибок выше 80% и жалобами почти наверняка сломан. **«Заявники»** — кто сколько подал, доля
подтверждённых, mute; только для admin.

## 10. API

| Метод | Путь | Вход | Выход | Ошибки |
| --- | --- | --- | --- | --- |
| POST | `/content-issues/reports` | `target_type`, `target_id`, `block_id?`, `issue_type`, `comment?`, `context`, `screenshot_media_id?` | `{issue_id, report_id, merged}` | 400 `validation_failed`, 404 чужой тенант, 409 `content_issue.already_reported`, 423 `content_issue.reporter_muted`, 429 `content_issue.rate_limited` |
| GET | `/content-issues` \| `/content-issues/:id` | фильтры §5.3, курсор | список; карточка с заявителями и журналом | 403, 404 |
| PATCH | `/content-issues/:id` | `status`, `resolution`, `resolution_comment`, `severity`, `affects_scoring`, `due_at` | карточка | 400 `content_issue.resolution_required`, 409 `content_issue.invalid_transition` |
| POST | `/content-issues/:id/assign` \| `/comment` | `user_id`; `comment`, `is_internal` | карточка, событие | 403, 404 |
| GET | `/content-issues/:id/rescore-preview` | | `{attempts_total, attempts_changed, to_passed, to_failed_skipped, avg_delta}` | 409 `content_issue.not_a_quiz_issue` |
| POST | `/content-issues/:id/rescore` | `mode: recalc\|void`, `reason` | `{rescored_attempts}` | 403, 409 `content_issue.already_rescored` |
| GET | `/me/content-reports` | | свои жалобы со статусами | |
| CRUD | `/settings/content-issue-routing-rules` | | | 400 `content_issue.fallback_rule_required` |
| POST | `/content-reporters/:userId/mute` \| `/unmute` | `until`, `reason` | | 403 |
| GET | `/reports/content-quality` | фильтры §9 | | 403 |

Мутации идемпотентны по `Idempotency-Key`; `POST /content-issues/reports` дополнительно дедуплицируется
по `dedupe_key + user_id`.

## 11. Фоновые задачи

| Задача | Частота | Что делает |
| --- | --- | --- |
| `content_issue.sla_scan` | ежечасно | просрочки и эскалации §7.6 |
| `content_issue.autoclose_scan` | по событию публикации версии | закрывает `fixed` §7.9 |
| `content_issue.reassign_scan` | ежедневно | переназначает карточки неактивных ответственных |
| `content_issue.rescore` | по команде | массовый пересчёт §7.8, партиями по 200 попыток |
| `content_issue.notify_reporters` | по событию закрытия | рассылка заявителям, `notified_at` |
| `content_link_check` | еженедельно | `external_url` и `embed` опубликованных материалов; 404/410 → автокарточка `broken_link` от системного пользователя |
| `content_media_check` | еженедельно | материалы со ссылками на медиа в `failed`/`quarantined` → карточка `broken_media` |
| `content_quality.refresh` | ночью | материализованное представление отчёта §9 |
| `content_reporter.stats_refresh` | ночью | пересчёт репутации, снятие истёкших mute |

## 12. Крайние случаи

- Блок, на который пожаловались, автор уже удалил новой версией → карточка остаётся с пометкой «Блок відсутній
  у поточній версії», предлагается резолюция `fixed` без правки.
- Автор пожаловался на свой контент → карточка сразу `in_progress` на него же, баллы не начисляются.
- Вопрос исправлен, а попытка ещё идёт → она работает по своему снапшоту, пересчёт применится к ней после
  завершения повторным запуском `content_issue.rescore`.
- Тест архивирован после подтверждения жалобы → пересчёт возможен: он идёт по попыткам, а не по текущему тесту.
- Вопрос в снапшотах у 3000 человек → предпросмотр считается фоном, кнопка показывает «Розрахунок…», результат
  приходит уведомлением.
- Два автора одновременно ставят разные резолюции → выигрывает первый, второй получает 409 и видит актуальное состояние.
- 40 жалоб на одно битое видео за 10 минут → карточка одна, `reports_count = 40`, ответственному уходит
  3 уведомления (§8), не 40.
- Заявитель уволен до закрытия → карточка живёт, уведомление не отправляется, в списке пометка «неактивний».
- Скриншот с персональными данными другого человека → виден только носителям `content_issue.view`, хранится
  180 дней, затем удаляется очисткой медиа `[решение]`.
- Жалоба подана офлайн (плохая связь на кухне) → форма хранится локально и уходит при появлении сети,
  `client_ts` сохраняет фактическое время.

## 13. Критерии приёмки

1. **Дано** урок с видеоблоком, **коли** сотрудник жмёт флажок у блока и выбирает «Не відтворюється відео або
   аудіо», **тоді** жалоба создана без единого введённого символа, а в `context` есть `block_id`, `content_version`
   и `player_position_sec`.
2. **Дано** открытая карточка на вопрос 4, **коли** второй человек жалуется на тот же вопрос с тем же типом,
   **тоді** новая карточка не создана, `reports_count = 2`, в журнале событие `merged`.
3. **Дано** попытка с `time_limit_sec = 1800`, **коли** человек подаёт жалобу на вопрос и тратит на форму 40 секунд,
   **тоді** попытка не прервана, `deadline_at` сдвинут на 40 секунд, карточка получила `affects_scoring = true`
   и `rescore_state = needed`.
4. **Дано** карточка `wrong_key` закрыта резолюцией `question_fixed`, **коли** администратор запускает пересчёт,
   **тоді** попытки с улучшением получают новый балл и статус, попытки с ухудшением остаются как есть
   и перечислены отдельным списком, всё записано в `audit_log`.
5. **Дано** пересчёт выполнен, **коли** результат сменился с «ПРОВАЛЕНО» на «ВИКОНАНО», **тоді** человеку ушло
   `content_issue_rescored` со старым и новым баллом, прогресс назначения пересчитан, сертификат выдан,
   если предусмотрен назначением.
6. **Дано** карточка в `fixed`, **коли** автор опубликовал новую версию материала, **тоді** карточка закрыта
   автоматически, всем заявителям ушло `content_issue_fixed`.
7. **Дано** 5 жалоб за сутки, **коли** человек открывает форму шестой раз, **тоді** отправка заблокирована текстом
   «Ти вже надіслав 5 повідомлень сьогодні»; **дано** три подряд жалобы закрыты как `spam`, **тоді** `muted_until`
   = +14 дней, человеку и его руководителю ушло уведомление.
8. **Дано** автор материала уволен, **коли** приходит жалоба, **тоді** ответственным становится владелец категории,
   а не уволенный.
9. **Дано** отчёт «Якість контенту», **тоді** курс с 2 жалобами на 40 прохождений стоит выше курса с 15 жалобами
   на 3000 прохождений.

## 14. Сверено с эталоном

Проверено по материалам аудита Sintegrum (`05-tracks.md` §5.1, экран `/tracks/report`). С эталона снято ровно три
факта: (а) «Звіт про помилки» — **самостоятельный экран** в разделе треков, а не вкладка курса; (б) у него есть
**фильтр «Тип»** (селект); (в) в таблице есть колонка **«Трек»**. Таблица в снятой установке пуста
(«немає даних»), поэтому значения фильтра, статусы, карточка жалобы и точка входа со стороны сотрудника
наблюдением не подтверждены.

Очередь Lola (§5.3) повторяет эталон дословно: отдельный путь, фильтр «Тип» первым, колонка «Трек» обязательна —
по ней методист понимает, чей это контент, раньше, чем откроет карточку. Всё остальное — цикл, склейка,
маршрутизация, ответ заявителю, пересчёт — наше добавление `[решение]`: список без цикла разбора превращается
в свалку, что на эталоне и видно — он пуст. Связь с базовым ТЗ: адресация элемента — `11` §3.1–3.3 (материал,
урок, блок `body`), неизменность снапшота попытки — `12` §3.6 и §7.11, кнопка «Перерахувати» — `22` §13.7
и `05` §5.14.8, доставка, тихие часы и троттлинг — `23` §6.

## 15. Гипотезы и принятые по ним решения

**Г-36.1. Состав фильтра «Тип».** На эталоне селект не раскрыт (нет данных). `[решение]` Закрытый список
из 11 значений (§7.3) по принципу «кто чинит и чем», с обязательным комментарием для четырёх типов.
Чем проверяется: открыть `/tracks/report` установки, где жалобы есть, и раскрыть селект.

**Г-36.2. Точка входа со стороны сотрудника.** На эталоне кнопка в прохождении не обнаружена, но экран отчёта
существует — значит источник есть. `[решение]` Флажок в плеере урока, у блока контента, в строке вопроса теста,
в карточке практикума и в шапке статьи базы знаний (§5.1). Чем проверяется: пройти любой модуль трека от лица
сотрудника и осмотреть шапку и подвал экрана прохождения.

**Г-36.3. Жизненный цикл жалобы.** Таблица пуста, колонка «Статус» не наблюдалась. `[решение]` Шесть статусов (§4)
с авто-закрытием по публикации новой версии контента. Чем проверяется: колонки таблицы `/tracks/report`
на установке с данными.

**Г-36.4. Влияние жалобы на результаты теста.** На Sintegrum связи между отчётом об ошибках и результатами нет;
в базовом ТЗ есть «Перерахувати», но она не связана с жалобами. `[решение]` Связь введена (§7.7–7.8): попытка
не блокируется, подтверждённая жалоба ставит `rescore_state = needed`, пересчёт массовый, из карточки, только
в сторону улучшения, с предпросмотром и записью в аудит. Обоснование «не блокировать»: блокировка делает кнопку
инструментом срыва попытки, а пересчёт задним числом честнее и дешевле, чем отмена попыток. Чем проверяется:
на эталонах не проверяется — собственное решение, пересматривается по данным эксплуатации (доля жалоб
`bad_question`, приведших к пересчёту, за первые 3 месяца).

**Г-36.5. Мотивация заявителя баллами.** На эталонах не наблюдалась. `[решение]` 10 баллов за подтверждённую
жалобу, бейдж на пятой, без снятия за отклонённые (§7.12). Чем проверяется: доля сотрудников, подавших хотя бы
одну жалобу за квартал, с баллами и без.

**Г-36.6. Срок хранения скриншотов.** Не наблюдался. `[решение]` 180 дней, затем автоматическое удаление медиа
(§12). Чем проверяется: политика хранения персональных данных тенанта при внедрении.
