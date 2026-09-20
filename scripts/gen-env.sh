#!/usr/bin/env bash
# Генерация .env для прода (docs/26 «Розгортання R1», аналог `make secrets` из docs/26 §26.6,
# по образцу того, как заводился стенд). Не перезаписывает существующий .env — безопасно
# запускать повторно. Каталог по умолчанию — ~/lola-prod (LOLA_PROD_DIR переопределяет).
#
# Использование: bash scripts/gen-env.sh
set -euo pipefail

DIR="${LOLA_PROD_DIR:-$HOME/lola-prod}"
ENV_FILE="$DIR/.env"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/.env.production.example"

if [ -f "$ENV_FILE" ]; then
  echo "$ENV_FILE уже есть — не трогаю (секреты не перегенерирую)." >&2
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "нужен openssl" >&2
  exit 1
fi

mkdir -p "$DIR"
cp "$SRC" "$ENV_FILE"

rand() { openssl rand -hex 24; }

# Пароли БД генерируются здесь одним источником правды и подставляются во все три URL,
# чтобы не разойтись (docs/26 §26.5: роли app_user/platform_admin создаются миграцией
# 0001/0009 с dev-паролем — first-run-prod.sh делает ALTER ROLE тем же значением).
pg_pw="$(rand)"
app_pw="$(rand)"
platform_pw="$(rand)"
s3_pw="$(rand)"
session_secret="$(rand)"
encryption_key="$(rand)"
otp_pepper="$(rand)"
platform_admin_password="$(rand)"

set_line() { # set_line '^NAME=.*' 'NAME=value'
  sed -i.bak "s|$1|$2|" "$ENV_FILE"
}

set_line '^POSTGRES_PASSWORD=.*' "POSTGRES_PASSWORD=$pg_pw"
set_line '^DATABASE_URL=.*' "DATABASE_URL=postgres://app_user:$app_pw@db:5432/lola"
# dotenv (server/db/seed.ts, migrate.ts) не разворачивает ${POSTGRES_PASSWORD} — подставляем
# значение буквально, а не переменной, иначе DATABASE_ADMIN_URL уедет со сломанным паролем.
set_line '^DATABASE_ADMIN_URL=.*' "DATABASE_ADMIN_URL=postgres://lola:$pg_pw@db:5432/lola"
set_line '^PLATFORM_DATABASE_URL=.*' "PLATFORM_DATABASE_URL=postgres://platform_admin:$platform_pw@db:5432/lola"
set_line '^S3_SECRET_KEY=.*' "S3_SECRET_KEY=$s3_pw"
set_line '^SESSION_SECRET=.*' "SESSION_SECRET=$session_secret"
set_line '^ENCRYPTION_KEY=.*' "ENCRYPTION_KEY=$encryption_key"
set_line '^OTP_PEPPER=.*' "OTP_PEPPER=$otp_pepper"
set_line '^PLATFORM_ADMIN_PASSWORD=.*' "PLATFORM_ADMIN_PASSWORD=$platform_admin_password"
rm -f "$ENV_FILE.bak"
chmod 600 "$ENV_FILE"

cat <<EOF
Секреты сгенерированы: $ENV_FILE (chmod 600).

Дозаполнить руками перед scripts/first-run-prod.sh:
  - APP_URL, TENANT_HOST_BASE, TENANT_HOST_DEFAULT — домен (R1: lmscappi.pp.ua, docs/25 §16.1)
  - PLATFORM_ADMIN_EMAIL — почта первого оператора платформы (пароль уже сгенерирован)
  - FIRST_TENANT_SLUG, FIRST_TENANT_NAME, FIRST_ADMIN_PHONE — первый тенант и его админ
  - SMTP_URL, SMTP_FROM — почта для писем и отчётов
  - SMS — глобального ключа нет: провайдер настраивается в панели тенанта после первого входа
    (docs/09 §9.1, ключи шифруются ENCRYPTION_KEY и лежат в tenant_secrets, не в .env)
  - CF_DIR (по умолчанию ./cf относительно каталога компоуза) — config.yml и credentials
    именованного тунеля Cloudflare, заводятся отдельно (docs/26 «Розгортання R1»)
  - GOOGLE_CLIENT_ID/SECRET, ZOOM_CLIENT_ID/SECRET — если нужен OAuth (docs/09 §9.2)
  - SENTRY_DSN, METRICS_TOKEN, GEOIP_DB_PATH — по желанию (docs/06 §6.7)

Пароли ролей БД (app_user, platform_admin) в .env уже расставлены — first-run-prod.sh
применит их к самим ролям (ALTER ROLE) после первой миграции, до этого миграции идут
от суперпользователя lola/\$POSTGRES_PASSWORD и на них ALTER ROLE не влияет.
EOF
