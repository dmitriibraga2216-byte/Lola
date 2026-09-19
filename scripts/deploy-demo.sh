#!/usr/bin/env bash
# Обновление демо-стенда (README «Демо-стенд»): выполняется на машине стенда
# (devbox, каталог ~/lola-demo). Две схемы запуска:
#   • по крону каждые 5 минут с флагом --if-changed — обновляет только когда в GHCR появился
#     новый :latest (стенд за Tailscale, CI до него не достучится — поэтому pull, а не push);
#   • руками: ssh devbox 'bash -s' < scripts/deploy-demo.sh
set -euo pipefail
DIR="${LOLA_DEMO_DIR:-$HOME/lola-demo}"
cd "$DIR"
before=$(docker inspect --format '{{.Image}}' "$(docker compose ps -q app 2>/dev/null)" 2>/dev/null || echo none)
docker compose pull -q app migrate   # только образ приложения: остальные не меняются
IMG=$(docker compose config --format json | grep -o '"image": *"[^"]*lola[^"]*"' | head -1 | sed 's/.*: *"//; s/"$//')
after=$(docker image inspect --format '{{.Id}}' "$IMG" 2>/dev/null || echo none)
if [ "${1:-}" = "--if-changed" ] && [ "$before" = "$after" ]; then exit 0; fi
docker compose up -d --wait --quiet-pull   # migrate накатывает миграции до старта app
docker image prune -f >/dev/null           # только dangling-слои
# ждём health приложения (образ содержит curl — docker/Dockerfile)
for i in $(seq 1 60); do docker compose exec -T app curl -sf http://localhost:3000/health 2>/dev/null | grep -q '"status":"ok"' && break; sleep 2; done
URL=$(docker compose logs tunnel 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)
echo "$(date '+%F %T') demo: $URL"
echo "image: $(docker image inspect --format '{{index .RepoDigests 0}}' "$after" 2>/dev/null || echo '?')"
