#!/usr/bin/env bash
# Обновление прода (docs/26 «Розгортання R1», по образцу scripts/deploy-demo.sh).
# Выполняется на самой VM (devbox, каталог ~/lola-prod), где лежит копия
# docker/docker-compose.prod.yml (под именем docker-compose.yml), .env и cf/config.yml.
#
# Крон каждые 5 минут (обновляет только когда в GHCR появился новый образ):
#   */5 * * * * cd ~/lola-prod && bash deploy-prod.sh --if-changed >> deploy.log 2>&1
# Руками: cd ~/lola-prod && bash deploy-prod.sh
# Откат на конкретный коммит: APP_TAG=<sha> bash deploy-prod.sh (перечитывает .env, но
# переменная окружения имеет приоритет — docker compose так же трактует ENV vs env_file).
set -euo pipefail
DIR="${LOLA_PROD_DIR:-$HOME/lola-prod}"
cd "$DIR"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
COMPOSE=(docker compose -f "$COMPOSE_FILE")

before=$(docker inspect --format '{{.Image}}' "$("${COMPOSE[@]}" ps -q app 2>/dev/null)" 2>/dev/null || echo none)
"${COMPOSE[@]}" pull -q app migrate   # только образ приложения: db/minio/tunnel не меняются деплоем
IMG=$("${COMPOSE[@]}" config --format json | grep -o '"image": *"[^"]*lola[^"]*"' | head -1 | sed 's/.*: *"//; s/"$//')
after=$(docker image inspect --format '{{.Id}}' "$IMG" 2>/dev/null || echo none)
if [ "${1:-}" = "--if-changed" ] && [ "$before" = "$after" ]; then exit 0; fi

# migrate — одноразовый сервис с service_completed_successfully: --wait ждёт его завершения
# и только потом поднимает app (докс/26 §26.8: миграции применяются до переключения трафика).
"${COMPOSE[@]}" up -d --wait --quiet-pull
docker image prune -f >/dev/null      # только dangling-слои, не трогает предыдущий тег для отката

# health приложения (образ содержит curl — docker/Dockerfile)
ok=0
for i in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T app curl -sf http://localhost:3000/health 2>/dev/null | grep -q '"status":"ok"'; then
    ok=1; break
  fi
  sleep 2
done

echo "$(date '+%F %T') deploy-prod: image $IMG"
echo "digest: $(docker image inspect --format '{{index .RepoDigests 0}}' "$after" 2>/dev/null || echo '?')"
if [ "$ok" != "1" ]; then
  echo "health не поднялся за 120с — предыдущий образ не откатывается автоматически, смотри: ${COMPOSE[*]} logs app" >&2
  exit 1
fi
