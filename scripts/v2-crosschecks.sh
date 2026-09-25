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
# Как разрешить конкретное срабатывание (не файл и не каталог целиком — про них см. ниже).
# Поставьте метку на нарушающей строке или на строке НЕПОСРЕДСТВЕННО НАД НЕЙ, синтаксисом
# комментария того места, где она стоит:
#   .ts / .vue <script>:   // v2-allow: checkN — <причина>
#   .sql / sql`...` в .ts: -- v2-allow: checkN — <причина>
#   .vue <template>:       <!-- v2-allow: checkN — <причина> -->
#   .vue <style> / .css:   /* v2-allow: checkN — <причина> */
# N — номер именно той проверки, чьё срабатывание разрешается: метка другой проверки не
# освобождает (check3 не гасит проверку 9). Разделитель причины — тире «—», причина обязательна
# и должна объяснять суть: метка без неё сама считается нарушением, иначе метки начнут ставить
# не глядя (docs/v2/44-decisions.md В-8: «allowlist — не список исключений, а список осознанных
# решений»). Метка живёт на самой нарушающей строке (или прямо над ней) и переезжает вместе
# с кодом при правках — в отличие от старого allowlist'а по номерам строк, её не сдвигают
# правки строк ВЫШЕ по файлу.
#
# Исключения целым файлом или каталогом (справочник `shared/enums.ts`, миграции, посев) не
# страдают от сдвига строк и по-прежнему заданы списком путей внутри самой проверки.
#
# Проверка без единой метки в коде и с пустым результатом grep означает, что на текущем main
# нарушений не найдено.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$(cd "$SCRIPT_DIR/.." && pwd)}"
cd "$ROOT" || { echo "Каталог не найден: $ROOT" >&2; exit 2; }

overall=0

# Оставляет только срабатывания ("путь:номер:..."), у которых нет метки v2-allow для проверки
# $2 на этой же строке или на строке над ней (формат — см. инструкцию в шапке файла). Метка без
# причины не освобождает: строка остаётся в выводе, но отдельным, легко узнаваемым сообщением —
# так «метку без причины» видно в [FAIL], а не молча пропускают (docs/v2/44-decisions.md В-8).
apply_markers() {
  local hits="$1" check="$2"
  [ -z "$hits" ] && return 0
  V2_ALLOW_HITS="$hits" V2_ALLOW_CHECK="$check" python3 - <<'PYEOF'
import os
import re

hits = os.environ.get('V2_ALLOW_HITS', '')
check = os.environ['V2_ALLOW_CHECK']

# Комментарий любого синтаксиса репозитория (см. шапку файла), затем "v2-allow: checkN" точно
# этого номера — (?!\d) не даёт, например, check1 поймать метку check13.
MARKER = re.compile(r'(?://|--|<!--|/\*)\s*v2-allow:\s*check' + re.escape(check) + r'(?!\d)(.*)$')
EM_DASH = '—'  # «—»: разделитель причины (не путать с "--" — открывающей комментарий SQL)

def reason_of(tail: str) -> str:
    tail = tail.strip()
    for end in ('-->', '*/'):
        if tail.endswith(end):
            tail = tail[:-len(end)].strip()
    return tail[1:].strip() if tail.startswith(EM_DASH) else ''

_cache: dict = {}
def lines_of(path: str):
    if path not in _cache:
        try:
            with open(path, encoding='utf-8') as fh:
                _cache[path] = fh.read().split('\n')
        except OSError:
            _cache[path] = None
    return _cache[path]

out = []
for entry in hits.split('\n'):
    if not entry:
        continue
    parts = entry.split(':', 2)
    if len(parts) < 3 or not parts[1].isdigit():
        out.append(entry)  # неожиданный формат строки — не трогаем
        continue
    path, lineno = parts[0], int(parts[1])
    lines = lines_of(path)
    marked, reason = False, ''
    if lines is not None:
        for ln in (lineno, lineno - 1):  # сама строка, затем строка над ней
            if 1 <= ln <= len(lines):
                m = MARKER.search(lines[ln - 1])
                if m:
                    marked, reason = True, reason_of(m.group(1))
                    break
    if marked and reason:
        continue  # законное исключение — не показываем
    if marked:
        out.append(f'{path}:{lineno}: метка "v2-allow: check{check}" без причины — не освобождает ({entry})')
        continue
    out.append(entry)

print('\n'.join(out))
PYEOF
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
  # Точечные срабатывания разрешены меткой v2-allow: check1 прямо в коде (см. шапку файла):
  # значение 'knowledge' там — код модуля «база знань» (контент), а не код этапа жизненного
  # цикла «навчання» (lifecycle_stages.code). Текстовое совпадение случайное — модуль появился
  # в базовом ТЗ задолго до пакета docs/v2, и переименовывать его не входит в план.
  hits="$(apply_markers "$hits" 1)"
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
#
# Чего не видит ни скрипт, ни тест: запрос, собранный из фрагментов, у которых `from` и `where`
# живут в разных местах, — конструктор отчётов (`reportBuilder.ts`, `ENTITIES`). Его держит
# tests/unit/report-builder-kind.spec.ts: проверка идёт по итоговому SQL каждой сущности, и
# на коде до исправления она красная (три сущности без вида с PR #91).
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
# Вид назван явно: имена репозитория, `frameWhere()`/`frameKind()` (подставляют EMPLOYEES_ONLY
# сами) или сам kind. Список держится в одном виде с FILTERED из users-kind-filter.spec.ts.
FILTERED = re.compile(r"EMPLOYEES_ONLY|CANDIDATES_ONLY|IS_EMPLOYEE|IS_CANDIDATE|employeeOnly|candidateOnly"
                      r"|\bemployees\(|\bcandidates\(|frameWhere\(|frameKind\(|users\.kind|\b[a-z_]+\.kind\s*=|\bkind\s*=\s*'(?:employee|candidate)'")
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
  # Точечные срабатывания разрешены меткой v2-allow: check5 прямо в коде, комментарием CSS
  # (`/* ... */`, см. шапку файла) над правилом: letterbox-фон видео, «бумажный» фон превью
  # письма и чёрно-белая подложка QR — во всех трёх буквальный чёрный/белый нужен независимо
  # от темы оформления, а токен --color-bg этого не гарантирует.
  hex_hits="$(apply_markers "$hex_hits" 5)"

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
  # Точечные срабатывания разрешены меткой v2-allow: check9 прямо в коде (см. шапку файла).
  # Три вида законных обращений к полю точки, на которые ссылаются причины меток:
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
  #
  # [При переносе на метки, PR crosschecks-markers: строка server/services/assessment.ts:400,
  # категория (б) «какими точками человек руководит», снята как протухшая. PR-30 перевёл этот
  # файл на managerIdsOf() из orgManager.ts (см. doc-комментарий у placementsOf()), и обращений
  # к полю точки напрямую в нём больше нет — метку не на что вешать.]
  hits="$(apply_markers "$hits" 9)"
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

# ── Проверка 11. Время обучения — биениями, у колонок учёта один писатель ───────────────────
# docs/v2/42-stages-delta.md §5 проверка 22, docs/v2/37 §7.10: «время считается биениями, а не
# разницей «открыл — закрыл»». Поведение проверяет тест (`tests/integration/v2-learning-time.spec.ts`,
# блок «сквозная проверка 22»); здесь — статический сторож того же правила: колонки учёта
# `net_seconds`, `content_seconds`, `attempt_seconds` (attempts, lesson_progress,
# workshop_submissions, review_queue_items, learning_time_totals) пишет **только** свёртка
# `server/services/learningTimeRollup.ts`. Любая другая запись в них — это и есть «посчитать
# время иначе»: `net_seconds = extract(epoch from submitted_at - started_at)` в сервисе или в
# миграции-бэкфилле. Ловятся SQL-присваивание (`col = …`, но не `>=`/`<=`) и запись Drizzle
# через `.set({…})` / `.values({…})` на одной строке. Чтение (`select`) нарушением не считается.
check11_time_single_writer() {
  local hits
  hits="$(grep -rnE "(net_seconds|content_seconds|attempt_seconds)\"?[[:space:]]*=[^=>]|\.(set|values)\(\{[^}]*(netSeconds|contentSeconds|attemptSeconds)[[:space:]]*:" \
    server --include='*.ts' --include='*.sql' 2>/dev/null \
    | grep -v '^server/services/learningTimeRollup.ts:' \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|//|--|#)' || true)"
  report "11. время обучения пишет только свёртка биений (docs/v2/42 §5 проверка 22)" "$hits"
}

# ── Проверка 12. Контуры PR-39 не смешиваются: Bearer — только скоупами, лента платформы — одна ─
# docs/v2/44 В-20 и docs/v2/39 П-21, условия выхода docs/v2/45 PR-39: «чёрного списка путей нет»,
# «две новости не смешаны». Поведение проверяют тесты (`tests/integration/v2-settings-39*.spec.ts`);
# здесь — статический сторож того, что правило не расползётся по коду:
#  (а) права Bearer-токена читает **одно** место — `server/services/access.ts` (там же вычёркиваются
#      скоупы `sessionOnly`). Ручка, которая сама смотрит на `event.context.tokenScopes`, — это и есть
#      начало списка путей, от которого В-20 отказалось: «путь меняется рефакторингом, и список тихо
#      перестаёт действовать». Allowlist — поимённо, по файлам:
#        - server/middleware/01.session.ts — единственный писатель контекста токена;
#        - server/utils/sessionAuth.ts — ручки второго фактора отвергают токен целиком: у токена
#          нет человека за экраном и его телефона (это отсутствие сессии, а не список путей);
#  (б) таблицу `platform_announcements` читает и пишет **один** модуль —
#      `server/services/platformAnnouncements.ts` (плюс схема и миграции). Лента новостей тенанта
#      к ней не обращается: две «новости» разведены не соглашением, а кодом.
check12_contours_pr39() {
  local tokens news
  tokens="$(grep -rnE "tokenScopes" server app --include='*.ts' --include='*.vue' 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|//)' \
    | grep -v '^server/services/access.ts:' \
    | grep -v '^server/middleware/01.session.ts:' \
    | grep -v '^server/utils/sessionAuth.ts:' || true)"
  news="$(grep -rnE "platform_announcements|platformAnnouncements[.)]" server app --include='*.ts' --include='*.vue' 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|//)' \
    | grep -v '^server/services/platformAnnouncements.ts:' \
    | grep -v '^server/db/schema/' || true)"
  report "12. Bearer разграничен только скоупами, лента платформы — один модуль (docs/v2/44 В-20, П-21)" "$(printf '%s\n%s\n' "$tokens" "$news" | sed '/^$/d')"
}

# ── Проверка 13. Норма времени и флаг отклонения не входят в балл ───────────────────────────
# docs/v2/37 §7.14 б, критерий приёмки 11 (PR-22): «отклонение факта от плана — сигнал качества
# контента, а не основание наказывать человека; время не участвует ни в одной формуле балла,
# зачёта, рейтинга или начисления баллов — ни прямо, ни коэффициентом». Поведение проверяет
# тест (`tests/integration/v2-time-norms.spec.ts`, «бал жодної людини не змінився»); здесь —
# статический сторож того же правила: таблицу норм, флаг отклонения и модуль норм знают только
# сам модуль (`server/services/timeNorms.ts`, схема, миграция, его ручки и планировщик) и
# ровно пять входов снаружи, каждый — одним именем: писатели очереди проверки берут снимок нормы
# (`plannedSecondsFor`, `37` §7.14: «попадает в очередь снимком на момент сдачи»), сохранение
# материала отдаёт в норму его «Орієнтовний час» (`syncMaterialEstimate`, `37` §3.5), блок
# «Призначені треки» карточки показывает «Плановий час» трека (`versionPlannedSeconds`,
# `docs/v2/38` §5.1, PR-35) — только показ рядом с «Часом проходження». Индекс залученості
# (`server/services/engagementIndex.ts`) нормы не читает: порог `38` §7.3 «Плановий час × 0.5»
# отклонён именно этим правилом (Р-35.2). Конструктор выгрузок (`server/services/
# reportBuilder.ts`, PR-38, П-22) регистрирует уже готовый отчёт «План і факт часу» второй
# точкой входа — вызывает `timePlanFactReport()`/`planFactExportRows()` теми же аргументами,
# что и его собственная ручка, не читая норму или флаг напрямую и не вводя нового расчёта.
# Любое другое упоминание в server/ и shared/ — это правило балла, зачёта или рейтинга, которое
# начало смотреть на время. Комментарии нарушением не считаются.
check13_time_norms_not_in_score() {
  local hits
  hits="$(grep -rnE "content_time_norms|contentTimeNorms|\bdeviation_flag\b|\bdeviationFlag\b|/timeNorms'" \
    server shared --include='*.ts' --include='*.sql' 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|//|--|#)' \
    | grep -vE '^(server/services/timeNorms\.ts|server/db/schema/timeNorms\.ts|server/db/schema/index\.ts|server/db/migrations/0085_v2_time_norms\.sql|server/api/v1/content/time-norms/[^:]+|server/api/v1/reports/time-plan-fact\.get\.ts|server/plugins/worker\.ts|shared/domain/timeNorms\.ts|shared/schemas/timeNorms\.ts):' \
    | grep -vE "^server/services/(attempts|workshops)\.ts:[0-9]+:import \{ plannedSecondsFor \} from '\./timeNorms'$" \
    | grep -vE "^server/services/resources\.ts:[0-9]+:import \{ syncMaterialEstimate \} from '\./timeNorms'$" \
    | grep -vE "^server/services/personTracks\.ts:[0-9]+:import \{ versionPlannedSeconds \} from '\./timeNorms'$" \
    | grep -vE "^server/services/reportBuilder\.ts:[0-9]+:import \{ planFactExportRows, timePlanFactReport \} from '\./timeNorms'$" \
    | grep -vE "^server/services/reportBuilder\.ts:[0-9]+:import \{ timePlanFactQuerySchema \} from '\.\./\.\./shared/schemas/timeNorms'$" \
    | grep -vE "^server/services/reportBuilder\.ts:[0-9]+:import type \{ TimePlanFactQuery \} from '\.\./\.\./shared/schemas/timeNorms'$" || true)"
  report "13. норма времени и флаг отклонения не входят в балл (docs/v2/37 §7.14 б, критерий 11)" "$hits"
}

# ── Проверка 14. ИИ ничего не решает о людях ────────────────────────────────────────────────
# docs/v2/42-stages-delta.md §5 проверка 17, docs/v2/30 §7.1, CLAUDE.md инвариант 18: код ИИ
# (`server/services/ai/`, заведён PR-27) не трогает состояние и колонку воронки кандидата,
# правильность ответа и сдачу практикума — вывод модели ложится «одним числом рядом с тремя
# человеческими, а не вместо них», и записывает его сервис-владелец, а не ИИ. Команда документа —
# дословно (snake_case), плюс те же имена в camelCase: Drizzle-запрос назвал бы колонку так,
# и grep документа его бы не увидел. Комментарии тоже считаются — как в команде документа.
check14_ai_no_decisions() {
  if [ ! -d server/services/ai ]; then
    echo "[skip] 14. ИИ ничего не решает о людях (каталог server/services/ai ещё не создан — PR-27)"
    return
  fi
  local hits
  hits="$(grep -rnE "candidate_state|candidate_status_id|is_correct|workshop_submissions|candidateState|candidateStatusId|isCorrect|workshopSubmissions" \
    server/services/ai 2>/dev/null || true)"
  hits="$(apply_markers "$hits" 14)"
  report "14. ИИ ничего не решает о людях (docs/v2/42 §5 проверка 17)" "$hits"
}

# ── Проверка 15. Вызов модели — только через шлюз ───────────────────────────────────────────
# docs/v2/45 PR-27, docs/v2/30 §7.16 «каждый вызов — строка ai_calls», docs/v2/35 §7.1: вызов
# мимо шлюза `server/services/ai/gateway.ts` не попадает ни в журнал, ни в ось потребления, и
# тенант получает бесплатный ИИ, а владелец продукта — невидимый счёт. Статический сторож:
#  (а) драйверы (`runDriver`, `setAiHttp` из `server/services/ai/drivers.ts`) и HTTP эмбеддингов
#      (`requestEmbeddings`, `httpEmbeddingProvider`, `stubEmbeddingProvider`, `embeddingOverride`)
#      вызываются только в `server/services/ai/` и в самом `server/services/embeddings.ts`;
#  (б) никто не выбирает провайдер эмбеддингов сам (`embeddingProvider(` — путь PR-25 до шлюза) и не
#      зовёт его `.embed(` напрямую;
#  (в) подключение платформы (`process.env.AI_PROVIDER_*`, `process.env.EMBEDDINGS_*`) читает
#      только шлюз — ключ платформы уходит только на адрес платформы, и решает это одно место.
# Комментарии нарушением не считаются.
check15_ai_gateway_only() {
  local hits
  hits="$(grep -rnE "\b(runDriver|setAiHttp|requestEmbeddings|httpEmbeddingProvider|stubEmbeddingProvider|embeddingOverride|embeddingProvider)\b|\.embed\(|process\.env\.(AI_PROVIDER|EMBEDDINGS)_|/ai/drivers'" \
    server app shared --include='*.ts' --include='*.vue' 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|//)' \
    | grep -vE '^server/services/ai/' \
    | grep -v '^server/services/embeddings.ts:' || true)"
  hits="$(apply_markers "$hits" 15)"
  report "15. вызов модели — только через шлюз server/services/ai (docs/v2/30 §7.16, PR-27)" "$hits"
}

# ── Проверка 16. ИИ ничего не решает о людях: модуль собеседования и неснимаемое обоснование ──
# docs/v2/42-stages-delta.md §5 проверка 17 (вторая половина), docs/v2/30 §3.5, §7.1, §7.2,
# CLAUDE.md инвариант 18; план `45` PR-28. Проверка 14 держит команду документа над
# `server/services/ai/` — шлюзом и промптами. Вывод модели обрабатывает модуль собеседования
# `server/services/interview/`: кладёт расшифровку в реплику, баллы по критериям — в
# `interview_criterion_scores`, одно число — в карточку. Правило 17 распространяется и на него:
#  (а) модуль собеседования не называет колонок решения о человеке — состояния и колонки воронки
#      кандидата, правильности ответа, сдачи практикума (snake_case и camelCase, как проверка 14;
#      комментарии тоже считаются — как в команде документа). Оценку в карточку он кладёт только
#      владельцем оценок `candidates.ts#writeAiScoreTx`, колонку канбана при отказе от ИИ двигает
#      `candidateJobs.ts#interviewAlternativeTx` — решения там, где им место, и по воле человека;
#  (б) оценки ИИ по критериям пишет только модуль собеседования: Drizzle-запись
#      `insert|update|delete(interviewCriterionScores)` и сырой `insert into | update
#      interview_criterion_scores` вне `server/services/interview/` — нарушение (комментарии — нет);
#  (в) ни одна миграция не снимает ограничений «балл без обоснования и цитаты не сохраняется»:
#      `drop constraint ics_*` и `drop trigger ics_insert_guard` в `server/db/migrations/`.
# Тест на саму запись (балл без цитаты отклоняется, сессия уходит в `needs_human`) —
# `tests/integration/v2-interview.spec.ts`, критерий `30` §13 к. 4.
check16_interview_no_decisions() {
  if [ ! -d server/services/interview ]; then
    echo "[skip] 16. ИИ ничего не решает о людях: модуль собеседования (каталог server/services/interview ещё не создан — PR-28)"
    return
  fi
  local own writers drops hits
  own="$(grep -rnE "candidate_state|candidate_status_id|is_correct|workshop_submissions|candidateState|candidateStatusId|isCorrect|workshopSubmissions" \
    server/services/interview 2>/dev/null || true)"
  writers="$(grep -rnE "\b(insert|update|delete)\(interviewCriterionScores\)|(insert[[:space:]]+into|update)[[:space:]]+\"?interview_criterion_scores\b" \
    server app shared --include='*.ts' --include='*.vue' 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(\*|//)' \
    | grep -vE '^server/services/interview/' || true)"
  drops="$(grep -rniE "drop[[:space:]]+(constraint|trigger)([[:space:]]+if[[:space:]]+exists)?[[:space:]]+\"?ics_" \
    server/db/migrations 2>/dev/null || true)"
  hits="$(printf '%s\n%s\n%s\n' "$own" "$writers" "$drops" | sed '/^[[:space:]]*$/d')"
  hits="$(apply_markers "$hits" 16)"
  report "16. ИИ ничего не решает о людях: модуль собеседования, балл без обоснования (docs/v2/42 §5 проверка 17)" "$hits"
}

# ── Проверка 17. Голос не живёт дольше срока ───────────────────────────────────────────────
# docs/v2/42-stages-delta.md §5 проверка 18, docs/v2/30 §7.7, §11 `interview.media_purge`,
# §13 к. 10; план `45` PR-29. Аудио ответа собеседования (`origin = 'interview_answer'`) живёт
# 90 дней от конца сессии, но не дольше согласия на обработку ПД; отзыв согласия и перезапись
# отправляют его в корзину сразу. SQL документа («ноль строк после прогона задачи») исполняет
# интеграционный тест `tests/integration/v2-ai-summary.spec.ts` (нужна БД и S3): прогон
# `interview.media_purge` по всем тенантам — и `select count(*) from media_assets where origin =
# 'interview_answer' and purge_after < now() and lifecycle <> 'purged'` даёт ноль; отказ S3 —
# строка остаётся, задача падает. Здесь — то, что делает этот ноль возможным и что статически
# ломается одной правкой:
#  (а) задача стоит в очереди и по расписанию: `createQueue` и `schedule('interview.media_purge'`
#      в `server/services/queue.ts`, обработчик `work('interview.media_purge'` в `server/plugins/worker.ts`;
#  (б) голос не помечается `purged` мимо модуля стирания `server/services/interview/mediaPurge.ts`:
#      пометка без удаления объекта оставила бы запись в S3 навсегда (так работает корзина
#      хранилища, `docs/v2/44` §8). Любая запись `lifecycle = 'purged'` / `lifecycle: 'purged'` в
#      `server/` вне модуля обязана в пределах своего запроса исключать `interview_answer`;
#  (в) корзина не возвращает голос: `restoreFile` в `server/services/storage.ts` отказывает
#      `interview_answer` (отзыв согласия — «записи видалено», обещано кандидату);
#  (г) ошибка удаления объекта голоса не глушится: в модуле стирания нет пустого `catch`,
#      `.catch(() => …)` и пакетного `DeleteObjectsCommand` (он и давал `MissingContentMD5` на
#      MinIO, проглоченный `deleteS3Prefix()` при удалении тенанта).
check17_voice_retention() {
  local purge="server/services/interview/mediaPurge.ts"
  if [ ! -f "$purge" ]; then
    echo "[skip] 17. голос не живёт дольше срока (модуль $purge ещё не создан — PR-29)"
    return
  fi
  local hits
  hits="$(V2_PURGE_MODULE="$purge" python3 - <<'PY'
import os
import pathlib
import re

purge = os.environ['V2_PURGE_MODULE']
out = []

def code_lines(text):
    return text.split('\n')

def is_comment(line):
    t = line.strip()
    return t.startswith('//') or t.startswith('*') or t.startswith('/*') or t.startswith('--')

# (а) расписание и обработчик
queue = pathlib.Path('server/services/queue.ts')
worker = pathlib.Path('server/plugins/worker.ts')
qs = queue.read_text(encoding='utf-8') if queue.is_file() else ''
ws = worker.read_text(encoding='utf-8') if worker.is_file() else ''
if "createQueue('interview.media_purge'" not in qs:
    out.append('server/services/queue.ts:0: нет очереди interview.media_purge — голос некому стирать по сроку')
if "schedule('interview.media_purge'" not in qs:
    out.append('server/services/queue.ts:0: interview.media_purge не стоит в расписании — срок голоса не исполняется')
if "work('interview.media_purge'" not in ws:
    out.append('server/plugins/worker.ts:0: нет обработчика interview.media_purge')

# (б) пометка purged мимо модуля стирания — только запись: `set … lifecycle = 'purged'` в SQL и
# `lifecycle: 'purged'` внутри `.set({…})` Drizzle; чтение (`where m.lifecycle = 'purged'`) — не запись
PURGED_SQL = re.compile(r"\bset\b.*\blifecycle\s*=\s*'purged'", re.IGNORECASE)
PURGED_ORM = re.compile(r"lifecycle\s*:\s*'purged'")
EXCLUDES = re.compile(r"origin\s*(<>|!=)\s*'interview_answer'|ne\(\s*mediaAssets\.origin\s*,\s*'interview_answer'\s*\)")
for f in sorted(pathlib.Path('server').rglob('*.ts')):
    path = f.as_posix()
    if path == purge:
        continue
    lines = code_lines(f.read_text(encoding='utf-8'))
    for i, line in enumerate(lines):
        if is_comment(line):
            continue
        orm = PURGED_ORM.search(line) and '.set(' in '\n'.join(lines[max(0, i - 3):i + 1])
        if not (PURGED_SQL.search(line) or orm):
            continue
        window = '\n'.join(lines[max(0, i - 12):i + 13])
        if not EXCLUDES.search(window):
            out.append(f"{path}:{i + 1}: lifecycle 'purged' без исключения interview_answer — голос помечен удалённым, а объект остался в S3")

# (в) восстановление из корзины
storage = pathlib.Path('server/services/storage.ts')
if storage.is_file():
    st = storage.read_text(encoding='utf-8')
    m = re.search(r'export async function restoreFile\b[\s\S]*?\n}\n', st)
    if m and 'interview_answer' not in m.group(0):
        out.append('server/services/storage.ts:0: restoreFile возвращает голос кандидата из корзины — запись без срока мимо interview.media_purge')

# (г) ошибка удаления не глушится
lines = code_lines(pathlib.Path(purge).read_text(encoding='utf-8'))
SWALLOW = re.compile(r'catch\s*(\([^)]*\))?\s*\{\s*\}|\.catch\(\s*\(\s*\w*\s*\)\s*=>|DeleteObjectsCommand')
for i, line in enumerate(lines):
    if SWALLOW.search(line) and not is_comment(line):
        out.append(f'{purge}:{i + 1}: ошибка удаления голоса глушится или удаление пакетное — неудача должна остаться видна')

print('\n'.join(out))
PY
)"
  hits="$(apply_markers "$hits" 17)"
  report "17. голос не живёт дольше срока: interview.media_purge, purged только с удалением объекта (docs/v2/42 §5 проверка 18)" "$hits"
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
check11_time_single_writer
check12_contours_pr39
check13_time_norms_not_in_score
check14_ai_no_decisions
check15_ai_gateway_only
check16_interview_no_decisions
check17_voice_retention

exit $overall
