#!/usr/bin/env bash
# Бэкап БД и медиа (docs/06 §6.6: «pg_dump ежедневно + WAL, хранение 30 дней, ежемесячная
# проверка восстановления»; WAL-архив и офсайт-копия — вручную по докс/26 §26.9, сюда не входят).
# Выполняется на VM в каталоге ~/lola-prod.
#
# Крон:
#   0 3 * * * cd ~/lola-prod && bash backup-prod.sh >> backup.log 2>&1
set -euo pipefail
DIR="${LOLA_PROD_DIR:-$HOME/lola-prod}"
cd "$DIR"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
COMPOSE=(docker compose -f "$COMPOSE_FILE")
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

mkdir -p backups/db backups/media

# --- БД: pg_dump | gzip в backups/db/YYYY-MM-DD.sql.gz (докс/06 §6.6) ------------------
DB_FILE="backups/db/$(date +%F).sql.gz"
"${COMPOSE[@]}" exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "${POSTGRES_USER:-lola}" "${POSTGRES_DB:-lola}"' | gzip > "$DB_FILE"
echo "$(date '+%F %T') backup db: $DB_FILE ($(du -h "$DB_FILE" | cut -f1))"
find backups/db -name '*.sql.gz' -mtime "+$KEEP_DAYS" -delete

# --- Медиа: mc mirror бакета MinIO в backups/media/YYYY-MM-DD (докс/26 §26.9) ----------
if [ -n "${S3_ACCESS_KEY:-}" ] && [ -n "${S3_SECRET_KEY:-}" ]; then
  NET="${COMPOSE_PROJECT_NAME:-lola-prod}_default"
  MEDIA_DIR="backups/media/$(date +%F)"
  mkdir -p "$MEDIA_DIR"
  if docker run --rm --network "$NET" -v "$DIR/$MEDIA_DIR:/backup" \
      --entrypoint sh minio/mc:latest -c \
      "mc alias set src http://minio:9000 '$S3_ACCESS_KEY' '$S3_SECRET_KEY' >/dev/null && mc mirror --quiet --overwrite src/${S3_BUCKET:-lola-media} /backup"; then
    echo "$(date '+%F %T') backup media: $MEDIA_DIR"
  else
    echo "$(date '+%F %T') backup media: mc mirror упал — проверь, поднят ли minio (сеть $NET)" >&2
    rmdir "$MEDIA_DIR" 2>/dev/null || true
  fi
  find backups/media -maxdepth 1 -mindepth 1 -type d -mtime "+$KEEP_DAYS" -exec rm -rf {} +
else
  echo "$(date '+%F %T') backup media: S3_ACCESS_KEY/S3_SECRET_KEY не заданы — пропускаю" >&2
fi
