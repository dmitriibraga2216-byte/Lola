#!/usr/bin/env bash
# Обновление демо-стенда (docs/26 §26.4, README «Демо-стенд»): выполняется на песочнице
# (cappi-bot, botdev, /home/botdev/app/lola-demo) — руками через ssh или как forced command
# ключа CI (сам этот файл лежит на сервере под именем deploy.sh).
set -euo pipefail
DIR="${LOLA_DEMO_DIR:-$HOME/app/lola-demo}"
cd "$DIR"
docker compose pull -q app migrate   # только образ приложения: docker.io (pgvector, cloudflared) с песочницы отдаёт ошибки
docker compose up -d --wait --quiet-pull   # migrate накатывает миграции до старта app
docker image prune -f >/dev/null           # диск на песочнице 92 % — только dangling
# ждём health приложения (образ содержит curl — docker/Dockerfile)
for i in $(seq 1 60); do docker compose exec -T app curl -sf http://localhost:3000/health 2>/dev/null | grep -q '"status":"ok"' && break; sleep 2; done
URL=$(docker compose logs tunnel 2>&1 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)
echo "demo: $URL"
echo "image: $(docker image inspect --format '{{index .RepoDigests 0}}' "$(docker inspect --format '{{.Image}}' "$(docker compose ps -q app)")" 2>/dev/null || echo '?')"
