#!/usr/bin/env bash
# Пять сквозных проверок пакета docs/v2 (HANDOFF.md §7.3, docs/v2/42-stages-delta.md §5,
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
  hits="$(grep -rEn "$pattern" server app shared --include='*.ts' 2>/dev/null \
    | grep -v 'server/db/seed' | grep -v 'drizzle/sql' | grep -v 'i18n/' || true)"
  # Allowlist: значение 'knowledge' здесь — код модуля «база знань» (контент), а не код этапа
  # жизненного цикла «навчання» (lifecycle_stages.code). Текстовое совпадение случайное —
  # модуль появился в базовом ТЗ задолго до пакета docs/v2 и переименовывать его не входит
  # в план (docs/v2/45-plan.md ничего об этом не говорит).
  local allow=(
    "server/db/schema/content.ts:101"
    "server/api/v1/access-groups/index.get.ts:7"
    "server/services/comments.ts:29"
    "server/services/comments.ts:89"
    "server/services/modules.ts:34"
    "server/services/modules.ts:54"
    "server/services/resources.ts:479"
    "shared/schemas/resources.ts:89"
    "shared/schemas/settings.ts:14"
    "shared/schemas/catalog.ts:33"
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
  # - app/pages/learn/profile.vue:166 `#fff4c7` — дублирует существующий токен
  #   --color-sun-soft: #fff4c7 (app/assets/tokens.css); реальная мелкая рассинхронизация,
  #   не исправляется в PR-01 (только тесты/скрипт/CI/документы) — заведена отдельная задача;
  # - app/pages/learn/meetups/checkin.vue:82 `#000` — фон видео-плеера (letterbox), должен
  #   быть буквально чёрным независимо от темы оформления, не элемент бренд-палитры;
  # - app/pages/admin/settings/notifications.vue:347 `#fff` — фон превью HTML-письма: должен
  #   быть буквально белым «листом бумаги», иначе превью не соответствует письму получателя;
  # - app/pages/admin/meetups/[id].vue:221 `#fff` — фон под QR-кодом: контраст QR обязан быть
  #   чёрным/белым для сканирования, тон беж-фона токена --color-bg этого не гарантирует.
  local allow=(
    "app/pages/learn/profile.vue:166"
    "app/pages/learn/meetups/checkin.vue:82"
    "app/pages/admin/settings/notifications.vue:347"
    "app/pages/admin/meetups/[id].vue:221"
  )
  hex_hits="$(filter_allowlist "$hex_hits" "${allow[@]}")"

  local inline_hits
  inline_hits="$(grep -rnoE '\s(style|:style)="[^"]*[0-9]+px[^"]*"' app --include='*.vue' 2>/dev/null \
    | grep -v 'var(--' || true)"

  local combined
  combined="$(printf '%s\n%s\n' "$hex_hits" "$inline_hits" | sed '/^$/d')"
  report "5. цвет/отступ мимо токенов (hex-литералы, inline style с px)" "$combined"
}

check1_stage_codes
check2_users_kind_filter
check3_driver_bypass
check4_i18n
check5_tokens

exit $overall
