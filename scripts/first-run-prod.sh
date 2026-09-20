#!/usr/bin/env bash
# Первый запуск прода (docs/26 «Розгортання R1», docs/32 §Б рядок 22). Выполняется на VM
# в каталоге ~/lola-prod, куда заранее скопированы docker/docker-compose.prod.yml (как
# docker-compose.yml), docker/Caddyfile (если понадобится профиль public) и создан
# cf/config.yml с credentials именованного тунеля Cloudflare (докс/26 «Розгортання R1» —
# тунель заводится вручную: cloudflared login/create/route dns, сюда не входит).
#
# Использование: cd ~/lola-prod && bash first-run-prod.sh
set -euo pipefail
DIR="${LOLA_PROD_DIR:-$HOME/lola-prod}"
cd "$DIR"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
COMPOSE=(docker compose -f "$COMPOSE_FILE")
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f .env ]; then
  echo "== .env нет — генерирую секреты (scripts/gen-env.sh) =="
  LOLA_PROD_DIR="$DIR" bash "$REPO_ROOT/scripts/gen-env.sh"
  echo "!! Дозаполните недостающие поля в $DIR/.env (см. вывод выше: домен, FIRST_TENANT_*," >&2
  echo "!! PLATFORM_ADMIN_EMAIL, тунель) и запустите скрипт ещё раз." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

: "${FIRST_TENANT_SLUG:?заполните FIRST_TENANT_SLUG в .env}"
: "${FIRST_TENANT_NAME:?заполните FIRST_TENANT_NAME в .env}"
: "${FIRST_ADMIN_PHONE:?заполните FIRST_ADMIN_PHONE в .env}"
: "${PLATFORM_ADMIN_EMAIL:?заполните PLATFORM_ADMIN_EMAIL в .env}"

echo "== db, minio =="
"${COMPOSE[@]}" up -d --wait db minio

echo "== миграции (от суперпользователя lola — DATABASE_ADMIN_URL) =="
"${COMPOSE[@]}" run --rm migrate

echo "== сид: SEED_MODE=prod — минимальный тенант без демо-контента (докс/28 «prod-proxmox») =="
"${COMPOSE[@]}" run --rm -e SEED_MODE=prod migrate node --import tsx server/db/seed.ts

echo "== ALTER ROLE: пароли app_user/platform_admin из .env (докс/26 §26.5) — миграции 0001/0009 =="
echo "== создают роли с dev-паролём, реальный пароль применяется здесь =="
app_pw=$(printf '%s' "$DATABASE_URL" | sed -E 's#^postgres://[^:]+:([^@]+)@.*#\1#')
platform_pw=$(printf '%s' "$PLATFORM_DATABASE_URL" | sed -E 's#^postgres://[^:]+:([^@]+)@.*#\1#')
"${COMPOSE[@]}" exec -T db psql -U "${POSTGRES_USER:-lola}" -d "${POSTGRES_DB:-lola}" -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE app_user PASSWORD '$app_pw';" \
  -c "ALTER ROLE platform_admin PASSWORD '$platform_pw';"

echo "== app (+ воркер), тунель =="
"${COMPOSE[@]}" up -d --wait

echo "== health =="
ok=0
for i in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T app curl -sf http://localhost:3000/health 2>/dev/null | grep -q '"status":"ok"'; then
    ok=1; break
  fi
  sleep 2
done
"${COMPOSE[@]}" exec -T app curl -sf http://localhost:3000/health || true
echo
if [ "$ok" != "1" ]; then
  echo "health не поднялся за 120с — смотри: ${COMPOSE[*]} logs app" >&2
  exit 1
fi

cat <<EOF

Готово.
  Оператор платформы (создаётся при старте app — ensureFirstAdmin):
    email:  $PLATFORM_ADMIN_EMAIL
    пароль: PLATFORM_ADMIN_PASSWORD в .env
  Первый тенант: $FIRST_TENANT_NAME ($FIRST_TENANT_SLUG), админ по телефону $FIRST_ADMIN_PHONE.

Дальше — чек-лист перед показом заказчику из docs/26 «Розгортання R1»
(OTP_DEBUG выключен, бэкап настроен, SMS подключен, /health и /metrics отвечают).
EOF
