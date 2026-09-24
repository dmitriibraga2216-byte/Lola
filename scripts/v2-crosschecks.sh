#!/usr/bin/env bash
# Сквозные проверки пакета docs/v2 (HANDOFF.md §7.3, docs/v2/42-stages-delta.md §5,
# docs/v2/39-patches.md П-07). Каждая — grep/поиск, обязанный вернуть пустой результат;
# любое совпадение красит соответствующую проверку и весь скрипт.
#
# Запуск:
#   scripts/v2-crosschecks.sh          # против текущего репозитория (CI, локально)
#   scripts/v2-crosschecks.sh <ROOT>   # против произвольного каталога (используется тестом
#                                       # tests/unit/v2-crosschecks.spec.ts на фикстурах)
#
# Каждая проверка сопровождается allowlist'ом — поимённым списком строк с комментарием,
# почему строка не считается нарушением (docs/v2/44-decisions.md В-8: «allowlist — не список
# исключений, а список осознанных решений; строка без комментария не принимается ревьюером»).
# Пустой allowlist для проверки означает, что на текущем main нарушений не найдено.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"
cd "$ROOT" || { echo "Каталог не найден: $ROOT" >&2; exit 2; }

overall=0

# Оставляет только строки вида "путь:номер:...", чьё "путь:номер:" НЕ входит в allowlist.
# Allowlist передаётся построчно через stdin вторым потоком не используется — проще: аргументы.
filter_allowlist() {
  local hits="$1"; shift
  local out="$hits"
  for entry in "$@"; do
    [ -z "$entry" ] && continue
    out="$(printf '%s\n' "$out" | grep -vF "$entry:" || true)"
  done
  printf '%s\n' "$out" | sed '/^$/d'
}

report() {
  local name="$1" hits="$2"
  if [ -n "$hits" ]; then
    echo "[FAIL] $name"
    printf '%s\n' "$hits" | sed 's/^/    /'
    overall=1
  else
    echo "[ok]   $name"
  fi
}

# ── Проверка 1. Ветвление по коду этапа — только через stageCan() ──────────────────────────
# HANDOFF §7.3 п.1, docs/v2/42-stages-delta.md §5 проверка 9, docs/v2/39-patches.md П-07 п.1.
# Литералы кодов этапов вне справочника и миграций — признак ветвления мимо stageCan().
check1_stage_codes() {
  local pattern="'(recruiting|onboarding|integration|training|attestation|psychological|knowledge|offboarding)'"
  local hits
  # Три места, где код этапа обязан встречаться буквально и потому исключены из поиска
  # (docs/v2/45-plan.md PR-05, условие выхода: «коды живут только в справочнике, посеве и
  # миграции»): справочник `shared/enums.ts` (LIFECYCLE_STAGE_CODES — единственный источник
  # перечня, docs/v2/44 В-3), посев нового тенанта `server/db/tenantDefaults.ts`
  # (DEFAULT_LIFECYCLE_STAGES, docs/v2/33 §3.3) и миграции (они .sql, под --include='*.ts'
  # не попадают вовсе). Всё остальное в server/ и app/ обязано ходить через stageCan().
  hits="$(grep -rEn "$pattern" server app shared --include='*.ts' 2>/dev/null \
    | grep -v 'server/db/seed' | grep -v 'server/db/tenantDefaults.ts' | grep -v 'shared/enums.ts' \
    | grep -v 'drizzle/sql' | grep -v 'i18n/' || true)"
  # Allowlist: значение 'knowledge' здесь — код модуля «база знань» (контент), а не код этапа
  # жизненного цикла «навчання» (lifecycle_stages.code). Текстовое совпадение случайное —
  # модуль появился в базовом ТЗ задолго до пакета docs/v2 и переименовывать его не входит
  # в план (docs/v2/45-plan.md ничего об этом не говорит).
  local allow=(
    "server/db/schema/content.ts:103" # строка сдвинулась на 1 в v2 PR-11/12 (импорт enrollments в схеме media_assets)
    "server/api/v1/access-groups/index.get.ts:7"
    # Номера сдвинулись дважды: fix-keyset-cursor (+2, импорт keyset) и PR-30 (+1 импорт
    # orgManager, −2 на сжатии локального managerOf()). Сами строки не менялись: 29 → 32, 89 → 90.
    "server/services/comments.ts:32"
    "server/services/comments.ts:90"
    "server/services/modules.ts:34"
    "server/services/modules.ts:54"
    "server/services/resources.ts:479"
    "shared/schemas/resources.ts:89"
    "shared/schemas/settings.ts:14"
    "shared/schemas/catalog.ts:35" # строка сдвинулась на 2 в fix-keyset-cursor (импорт keyset)
  )
  hits="$(filter_allowlist "$hits" "${allow[@]}")"
  report "1. коды этапов вне справочника/миграций" "$hits"
}

# ── Проверка 2. Выборка людей без фильтра по users.kind ─────────────────────────────────────
# HANDOFF §7.3 п.2, docs/v2/44-decisions.md В-8 (слой 2 — сканер), docs/v2/42 §5 проверка 10.
# До PR-04 репозиторного слоя server/services/repo/people.ts не существует — при 148 точках
# обращения к users в текущем коде (В-8, оценка) строгая проверка «нет обращений вне
# репозитория» гарантированно красит всё сразу и не несёт сигнала. Проверка активируется
# автоматически, как только появится файл репозитория (условие, а не постоянное исключение).
#
# Что именно проверяется здесь, а что — тестом. Полный классификатор (соединения ради ФИО,
# внешние соединения, выборки по первичному ключу) живёт в
# tests/integration/users-kind-filter.spec.ts — он и есть слой 2. Скрипт держит более узкий,
# но самый важный инвариант П-16.1: **там, где `users` — ведущая таблица выборки, вид людей
# назван явно**. Соединения оставлены тесту намеренно, чтобы два механизма не разошлись в
# трактовке; поимённый allowlist не дублируется, а читается из самого теста.
check2_users_kind_filter() {
  local repo_file="server/services/repo/people.ts"
  if [ ! -f "$repo_file" ]; then
    echo "[skip] 2. выборки users без фильтра kind (репозиторный слой $repo_file ещё не создан — PR-04)"
    return
  fi
  local hits
  hits="$(python3 - <<'PYEOF'
import re
import pathlib

REPO = 'server/services/repo/people.ts'
SPEC = pathlib.Path('tests/integration/users-kind-filter.spec.ts')

# users как ведущая таблица выборки: Drizzle .from(users) и сырое `from users`.
HIT = re.compile(r'\.from\((?:\w+\.)?users\)|\bfrom\s+users\b', re.I)
# Вид назван явно: имена репозитория, `frameWhere()` (он подставляет EMPLOYEES_ONLY сам) или сам kind.
FILTERED = re.compile(r"EMPLOYEES_ONLY|CANDIDATES_ONLY|IS_EMPLOYEE|IS_CANDIDATE|employeeOnly|candidateOnly"
                      r"|\bemployees\(|\bcandidates\(|frameWhere\(|users\.kind|\b[a-z_]+\.kind\s*=|\bkind\s*=\s*'(?:employee|candidate)'")
# Выборка одного человека по первичному ключу — фильтровать её по виду бессмысленно (В-8).
BY_ID = re.compile(r"eq\(users\.id,|inArray\(users\.id,|\$\{users\.id\}\s+in|\b[\w.]*\bid\s*(?:=|in)\s*\(?\$\{", re.I)

allow = set()
if SPEC.is_file():
    allow = set(re.findall(r"'((?:server|app)/[^']+:\d+)':", SPEC.read_text(encoding='utf-8')))

def expression(lines, i):
    ticks = '\n'.join(lines[:i]).count('`')
    s = e = i
    if ticks % 2 == 1:
        while s > 0 and '`' not in lines[s] and i - s < 40:
            s -= 1
        while e < len(lines) - 1 and '`' not in lines[e] and e - i < 40:
            e += 1
        s = max(0, s - 1)
    else:
        bal = sum(lines[i].count(c) for c in '([{') - sum(lines[i].count(c) for c in ')]}')
        while s > 0 and bal < 0 and i - s < 40:
            s -= 1
            bal += sum(lines[s].count(c) for c in '([{') - sum(lines[s].count(c) for c in ')]}')
        while e < len(lines) - 1 and bal > 0 and e - i < 40:
            e += 1
            bal += sum(lines[e].count(c) for c in '([{') - sum(lines[e].count(c) for c in ')]}')
    while s > 0 and re.match(r'^\s*[.?:]|[([,=]$|sql`$', lines[s - 1].rstrip()):
        s -= 1
    while e < len(lines) - 1 and re.match(r'^\s*[.?:)]', lines[e + 1]):
        e += 1
    return '\n'.join(lines[s:e + 1])

out = []
root = pathlib.Path('server')
if root.is_dir():
    for f in sorted(root.rglob('*.ts')):
        rel = f.as_posix()
        if rel == REPO:
            continue
        lines = f.read_text(encoding='utf-8').split('\n')
        for i, line in enumerate(lines):
            if not HIT.search(line) or re.match(r'\s*(//|\*)', line):
                continue
            key = f'{rel}:{i + 1}'
            if key in allow:
                continue
            expr = expression(lines, i)
            if FILTERED.search(expr) or BY_ID.search(expr):
                continue
            out.append(f'{key}: {line.strip()}')
print('\n'.join(out))
PYEOF
)"
  report "2. выборки users без фильтра kind" "$hits"
}

# ── Проверка 3. Прямой вызов драйвера БД мимо withTenant() ──────────────────────────────────
# HANDOFF §7.3 п.3, CLAUDE.md правило 2. Определение сделано намеренно узким и проверяемым:
# создание нового подключения драйвера `postgres(...)` — единственный способ обойти
# единственный экземпляр db (server/db/client.ts) и его обёртку withTenant(). Обращение к
# самому экспортированному `db` без транзакции withTenant тоже нежелательно, но не ловится
# статическим grep без разбора AST; здесь фиксируется более узкий, но точный инвариант —
# драйвер инстанцируется ровно в трёх местах инфраструктуры.
check3_driver_bypass() {
  local hits
  hits="$(grep -rln "^import postgres from 'postgres'" server app --include='*.ts' 2>/dev/null || true)"
  # Allowlist — три инфраструктурных файла и один документированный обход RLS:
  # - server/db/client.ts — единственное сущее подключение приложения (создаёт db, вокруг
  #   которого и построен withTenant());
  # - server/db/migrate.ts, server/db/seed.ts — офлайн-скрипты миграции и сида, выполняются
  #   до старта приложения и вне HTTP-запроса, тенанта ещё нет;
  # - server/services/platform.ts — задокументированное собственное подключение ролью
  #   platform_admin с BYPASSRLS для панели оператора платформы (docs/25 §7 п.1; см. комментарий
  #   в самом файле: «Единственный модуль, работающий ролью platform_admin с BYPASSRLS»).
  local allow=(
    "server/db/client.ts"
    "server/db/migrate.ts"
    "server/db/seed.ts"
    "server/services/platform.ts"
  )
  local filtered="$hits"
  for entry in "${allow[@]}"; do
    filtered="$(printf '%s\n' "$filtered" | grep -vxF "$entry" || true)"
  done
  filtered="$(printf '%s\n' "$filtered" | sed '/^$/d')"
  report "3. прямое подключение драйвера мимо withTenant()" "$filtered"
}

# ── Проверка 4. Строка интерфейса мимо i18n ──────────────────────────────────────────────────
# HANDOFF §7.3 п.4, CLAUDE.md правило 8. Ищет кириллический текст в шаблонах .vue, стоящий
# прямо между тегами или в частых текстовых атрибутах, минуя i18n-ключи (t('...')). Комментарии
# (<!-- --> и JS-комментарии в <script>) исключаются — там кириллица легальна.
# Реализовано через python3 (везде есть, в т.ч. на ubuntu-latest CI), а не `grep -P`: точный
# диапазон кодовых точек Ѐ–ӿ нужен для юникода, а BSD grep (macOS по умолчанию) не
# понимает -P вовсе — скрипт должен запускаться и локально, и в CI одинаково корректно.
check4_i18n() {
  local hits
  hits="$(python3 - <<'PYEOF'
import re
import pathlib

root = pathlib.Path('app')
text_node = re.compile(r'>[^<{]*[Ѐ-ӿ][^<]*<')
attr = re.compile(r'\b(placeholder|title|alt|aria-label|label)="[^"]*[Ѐ-ӿ][^"]*"')
out = []
if root.is_dir():
    for f in sorted(root.rglob('*.vue')):
        s = f.read_text(encoding='utf-8')
        m = re.search(r'<template>(.*?)</template>', s, re.S)
        if not m:
            continue
        block = re.sub(r'<!--.*?-->', '', m.group(1), flags=re.S)
        tm = text_node.search(block)
        if tm:
            out.append(f"{f}: текст в шаблоне мимо t(): {tm.group(0).strip()[:80]}")
        am = attr.search(block)
        if am:
            out.append(f"{f}: атрибут мимо t(): {am.group(0)[:80]}")
print('\n'.join(out))
PYEOF
)"
  report "4. строка интерфейса мимо i18n" "$hits"
}

# ── Проверка 5. Цвет и отступ мимо токенов бренд-бука ────────────────────────────────────────
# HANDOFF §7.3 п.5, CLAUDE.md правило 9. Полный запрет любых px/rgb() магических значений
# сегодня красит ~60 существующих строк добренд-бучного кода (мелкие визуальные подгонки
# 2–5px в <style scoped>, полупрозрачные подложки rgb(12 15 20 / N%) поверх токена --color-ink,
# для которых var() не несёт альфа-канал) — это унаследованный долг всего приложения, а не
# нарушение конкретного PR, и его переписывание не входит в объём PR-01 (только тесты, скрипт,
# CI, документы). Проверка сужена до двух точных, воспроизводимых сигналов:
#   а) hex-литерал цвета (#rgb/#rrggbb) вне app/assets/tokens.css и app/assets/ui.css —
#      однозначный магический цвет, который обязан быть токеном;
#   б) inline style/:style с px-значением в шаблоне — обход токенов прямо в разметке, самый
#      дешёвый в написании и самый простой в проверке случай.
check5_tokens() {
  local hex_hits
  hex_hits="$(grep -rnoE '#[0-9a-fA-F]{3,8}\b' app --include='*.vue' --include='*.css' 2>/dev/null \
    | grep -v 'app/assets/tokens.css' | grep -v 'app/assets/ui.css' || true)"
  # Allowlist — четыре хекс-литерала, найденных на момент написания проверки (main, 2026-09-23):
  # - app/pages/learn/profile.vue:186 `#fff4c7` — дублирует существующий токен
  #   --color-sun-soft: #fff4c7 (app/assets/tokens.css); реальная мелкая рассинхронизация,
  #   не исправляется в PR-01 (только тесты/скрипт/CI/документы) — заведена отдельная задача.
  #   Номер строки сдвинулся 166→185 в задаче про третий язык интерфейса, затем 185→186 —
  #   в задаче про единое форматирование дат (добавлена строка `const { formatDate,
  #   formatShortDate } = useFormat()` в начале <script setup>); сам хекс-литерал не трогали;
  # - app/pages/learn/meetups/checkin.vue:83 `#000` — фон видео-плеера (letterbox), должен
  #   быть буквально чёрным независимо от темы оформления, не элемент бренд-палитры.
  #   Строка 82→83 — тот же сдвиг на одну строку (задача про единое форматирование дат);
  # - app/pages/admin/settings/notifications.vue:348 `#fff` — фон превью HTML-письма: должен
  #   быть буквально белым «листом бумаги», иначе превью не соответствует письму получателя.
  #   Строка 347→348 — тот же сдвиг;
  # - app/pages/admin/meetups/[id].vue:222 `#fff` — фон под QR-кодом: контраст QR обязан быть
  #   чёрным/белым для сканирования, тон беж-фона токена --color-bg этого не гарантирует.
  #   Строка 221→222 — тот же сдвиг.
  local allow=(
    "app/pages/learn/profile.vue:186"
    "app/pages/learn/meetups/checkin.vue:83"
    "app/pages/admin/settings/notifications.vue:348"
    "app/pages/admin/meetups/[id].vue:222"
  )
  hex_hits="$(filter_allowlist "$hex_hits" "${allow[@]}")"

  local inline_hits
  inline_hits="$(grep -rnoE '\s(style|:style)="[^"]*[0-9]+px[^"]*"' app --include='*.vue' 2>/dev/null \
    | grep -v 'var(--' || true)"

  local combined
  combined="$(printf '%s\n%s\n' "$hex_hits" "$inline_hits" | sed '/^$/d')"
  report "5. цвет/отступ мимо токенов (hex-литералы, inline style с px)" "$combined"
}

# ── Проверка 6. Очередь проверки не пересоздаётся ───────────────────────────────────────────
# docs/v2/42-stages-delta.md §5 проверка 21, docs/v2/39-patches.md П-13, решение В-2.
# Наполнение очереди производное, но перестроение «с нуля» запрещено: собственное состояние
# строки (assigned_reviewer_id, sla_breached_at, delegation_depth, origin_reviewer_id) из
# источников не восстанавливается, и `truncate`/`delete from` молча стёрли бы делегирование
# и историю SLA. Закрытие элемента — `status = 'done'`, а не удаление строки.
#
# Проверяются server/ и миграции (drizzle/ — историческое имя каталога в `42` §5; в этом
# репозитории миграции лежат в server/db/migrations, и они попадают под server/).
# Allowlist пуст: ни одного места удаления на текущем main нет и появиться не должно.
check6_review_queue_rebuild() {
  local hits
  # Строки-комментарии отбрасываются: запрет обязан быть объяснён в коде словами, и
  # объяснение («ни truncate, ни delete from review_queue_items») не является нарушением.
  hits="$(grep -rniE "truncate[[:space:]]+(table[[:space:]]+)?\"?review_queue_items|delete[[:space:]]+from[[:space:]]+\"?review_queue_items|\.delete\([[:space:]]*reviewQueueItems" \
    server drizzle --include='*.ts' --include='*.sql' 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|//|--|#)' || true)"
  report "6. очередь проверки не пересоздаётся (нет truncate/delete review_queue_items)" "$hits"
}

# ── Проверка 7. Вакансия не стала носителем правил прохождения ──────────────────────────────
# docs/v2/42-stages-delta.md §5 проверка 13, docs/v2/39-patches.md П-15, инвариант 1 `29` §1.
# Вакансия хранит шаблон параметров и применяет его созданием обычной `assignments`. Если
# в её схемах заводится собственный «проходной балл» или «попытки», правила прохождения
# получают второго носителя — и расходятся с назначением в первый же день.
#
# > [исправлено, PR-15: файл назван по соглашению репозитория]
# > Ранее в `42` §5: «grep ... shared/schemas/vacancy*.ts».
# Схемы лежат в `shared/schemas/vacancies.ts` (множественное число — как `candidates.ts`,
# `assignments.ts`), поэтому шаблон расширен до `vacanc*`: он покрывает оба написания и не
# зависит от того, разделят ли схему на несколько файлов.
check7_vacancy_not_rules_carrier() {
  local hits
  hits="$(grep -rniE "attempts|pass_score|due_at|time_limit" shared/schemas/vacanc*.ts 2>/dev/null \
    | grep -viE "params_template|assignment_template|assignmentTemplate|paramsTemplate" || true)"
  report "7. вакансия не носитель правил прохождения (docs/v2/42 §5 проверка 13)" "$hits"
}

# ── Проверка 8. Публичный контур не ходит в БД мимо withTenant() ────────────────────────────
# docs/v2/42-stages-delta.md §5 проверка 16, docs/v2/39-patches.md П-25.3, решение В-9 п. 2.
#
# Это главный риск PR-16 и всего контура: публичная страница работает **без сессии**, тенанта
# в контексте нет, и соблазн «сходить в базу напрямую, всё равно фильтровать не по чему»
# максимален. Проверяются два инварианта правила контура сразу:
#
#   (а) ни один обработчик под `server/api/v1/public/` не обращается к БД сам — он зовёт
#       сервис; единственный разрешённый импорт из слоя данных ему просто не нужен;
#   (б) у каждого обработчика контура стоит `hitRateLimit` (пункт «в» правила В-9) —
#       без него перебор токенов ограничен только их длиной.
#
# Обращение сервисов контура к `db` мимо `withTenant()` этим grep'ом не ловится и ловиться не
# должно: ровно одно такое обращение разрешено и необходимо — вызов функции `SECURITY DEFINER`,
# выводящей тенанта из токена (`vacancy_public_lookup`, `mystery_link_lookup`). Оно закрыто
# тестом `tests/integration/v2-vacancy-apply.spec.ts`, который проверяет результат, а не текст:
# чужой токен отдаёт 404, а не данные.
check8_public_contour() {
  local dir="server/api/v1/public"
  if [ ! -d "$dir" ]; then
    echo "[skip] 8. публичный контур (каталог $dir не найден)"
    return
  fi
  local hits=""
  # (а) обращение к слою данных прямо из обработчика контура
  hits="$(grep -rln "from '.*db/client'\|from '.*db/schema'\|drizzle-orm" "$dir" --include='*.ts' 2>/dev/null || true)"
  hits="$(printf '%s\n' "$hits" | sed '/^$/d' | sed 's/$/: обработчик контура обращается к БД сам/')"
  # (б) обработчик контура без частотного ограничения
  local missing=""
  local f
  for f in $(find "$dir" -name '*.ts' 2>/dev/null | sort); do
    grep -q 'hitRateLimit' "$f" || missing="$missing$f: нет hitRateLimit (правило публичного контура, В-9 п. 2в)\n"
  done
  local combined
  combined="$(printf '%s\n%b' "$hits" "$missing" | sed '/^$/d')"
  report "8. публичный контур: БД только через сервис, у каждой ручки hitRateLimit" "$combined"
}

# ── Проверка 9. Руководитель человека — только через resolveManager() ───────────────────────
# docs/v2/39-patches.md П-16.4, docs/v2/32-org-structure.md §7.8, план PR-30.
# До PR-30 «руководитель» вычислялся в шестнадцати местах, и каждое делало это по-своему:
# где-то с `is_primary`, где-то без; где-то с проверкой «не сам себе», где-то без; условие
# «у человека есть руководитель» то стояло в `where`, то не стояло — и люди без точки молча
# выпадали из эскалаций. Одно поле `locations.manager_id` вдобавок не описывает подчинение
# ВНУТРИ точки (шеф-кухар → кухарі) и ломается на совместителях.
#
# Проверяется: ни одного чтения `locations.manager_id` / `locations.managerId` вне
# `server/services/orgManager.ts`. Allowlist — поимённый, каждая строка с причиной
# (docs/v2/44 В-8: «список осознанных решений, а не исключений»).
check9_resolve_manager() {
  local hits
  hits="$(grep -rnE "locations\.manager_id|locations\.managerId|l\.manager_id|managerId: locations\.managerId" \
    server app shared --include='*.ts' --include='*.vue' 2>/dev/null \
    | grep -v 'server/services/orgManager.ts' \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|//|--|#)' || true)"
  # Allowlist. Три вида законных обращений к полю точки:
  #
  # (а) САМО ПОЛЕ как элемент справочника точек — его заводят, правят и показывают
  #     (`docs/16` §3.3). Понижение поля до резервного источника не означает, что его больше
  #     нельзя редактировать: `resolveManager()` шаг 2 из него и читает.
  # (б) «КТО РУКОВОДИТЕЛЬ ЭТОЙ ТОЧКИ» — вопрос о точке, а не о человеке. Чек-лист заполняется
  #     ПО ТОЧКЕ, недельный дайджест считает цифры ПО ТОЧКЕ, право провести занятие даётся
  #     держателю точки. Подставлять сюда руководителя человека было бы не «единым источником
  #     истины», а подменой вопроса.
  # (в) ЗАПИСЬ поля — импорт людей заполняет `user_placements.manager_id` по внешнему номеру,
  #     посев платформы ставит администратора руководителем точки. Ни то ни другое не читает
  #     поле ради ответа «кто руководитель человека X».
  local allow=(
    "server/db/schema/org.ts:26"                  # (а) объявление колонки locations.manager_id
    "server/db/schema/people.ts:112"              # (а) объявление колонки user_placements.manager_id
    "server/services/refs.ts:32"                  # (а) список редактируемых полей справочника точек
    "server/services/refs.ts:35"                  # (а) карта camelCase → snake_case того же справочника
    "server/api/v1/refs/[kind]/[id].patch.ts:15"  # (а) zod-схема правки точки
    "server/services/orgTree.ts:11"               # (б) карточка точки в публичной оргструктуре: «керівник точки»
    "server/services/orgTree.ts:21"               # (б) то же, подстановка имени в карточку
    "server/services/meetupSessions.ts:380"       # (б) право вести занятие — у держателя точки (docs/18 §7)
    "server/services/checklists.ts:198"           # (б) чек-лист по точке провален → руководителю точки (docs/20 §8)
    "server/services/checklists.ts:415"           # (б) точка не выполнила норму прогонов → руководителю точки
    "server/services/checklists.ts:418"           # (б) то же, условие выборки
    "server/services/checklists.ts:419"           # (б) то же, тип строки
    "server/services/reportsExtra.ts:283"         # (б) недельный дайджест по точке (docs/22 §8): цифры тоже по точке
    "server/services/assessment.ts:400"           # (б) «какими точками человек руководит» — вопрос о точках
    "server/services/importPeople.ts:622"         # (в) запись user_placements.manager_id из файла
    "server/services/platform.ts:172"             # (в) посев нового тенанта: администратор — руководитель точки
  )
  hits="$(filter_allowlist "$hits" "${allow[@]}")"
  report "9. руководитель человека мимо resolveManager() (docs/v2/39 П-16.4)" "$hits"
}

# ── Проверка 10. Тихие часы кандидата — безусловны и по его собственному окну ───────────────
# docs/v2/42-stages-delta.md §5 проверка 19, docs/v2/39-patches.md П-23.
# Полная проверка расписания (22:10 → завтра 09:00; 20:30 → завтра 09:00, не немедленно) —
# тест tests/integration/v2-notify-37.spec.ts (нужна БД: кандидат с вакансией и точкой).
# Здесь — узкий, но самый важный инвариант: ветка кандидата в enqueueNotification() (a) не
# проверяет тумблер settings.quietHours.enabled тенанта (правило абсолютное — «вне тихих
# часов тенанта» из П-23 в буквальном смысле: тенантский тумблер тут не при чём) и
# (б) действительно использует CANDIDATE_QUIET_HOURS, а не таймзону/окно сотрудника.
check10_candidate_quiet_hours() {
  # Фикстуры остальных проверок в tests/unit/v2-crosschecks.spec.ts создают минимальные
  # каталоги без server/services/notifications.ts вовсе — как и check2 при отсутствии
  # репозиторного слоя, это не нарушение, а условие «проверке нечего проверять».
  if [ ! -f "server/services/notifications.ts" ]; then
    echo "[skip] 8. тихие часы кандидата (server/services/notifications.ts не найден)"
    return
  fi
  local hits
  hits="$(python3 - <<'PYEOF'
import re
import pathlib

f = pathlib.Path('server/services/notifications.ts')
if not f.is_file():
    print('server/services/notifications.ts:0: файл не найден')
else:
    s = f.read_text(encoding='utf-8')
    m = re.search(r'export async function enqueueNotification\b[\s\S]*?\n}\n', s)
    if not m:
        print('server/services/notifications.ts:0: enqueueNotification не найдена')
    else:
        body = m.group(0)
        cand = re.search(r"kind\s*===\s*'candidate'", body)
        if not cand:
            print('server/services/notifications.ts: enqueueNotification не различает kind==candidate — тихие часы кандидата не могут применяться')
        else:
            branch = body[cand.start():]
            else_pos = branch.find('\n  else')
            branch = branch[:else_pos] if else_pos != -1 else branch
            if 'quietHours.enabled' in branch:
                print('server/services/notifications.ts: ветка кандидата смотрит на settings.quietHours.enabled — тихие часы кандидата обязаны быть безусловными (П-23)')
            if 'CANDIDATE_QUIET_HOURS' not in branch:
                print('server/services/notifications.ts: ветка кандидата не использует CANDIDATE_QUIET_HOURS (09:00–20:00 його часу)')
PYEOF
)"
  report "10. тихие часы кандидата — безусловны, своим окном (docs/v2/42 §5 проверка 19)" "$hits"
}

check1_stage_codes
check2_users_kind_filter
check3_driver_bypass
check4_i18n
check5_tokens
check6_review_queue_rebuild
check7_vacancy_not_rules_carrier
check8_public_contour
check9_resolve_manager
check10_candidate_quiet_hours

exit $overall
