# Lola LMS — ТЗ. Часть 26. Локальный сервер: развёртывание на своём железе

Цель: поднять Lola на собственном сервере (Proxmox), чтобы она работала круглосуточно,
переживала перезагрузку хоста, обновлялась одной командой и восстанавливалась из бэкапа.
Публикация наружу и ссылка для третьих лиц — в `27-gateway-public.md`.

## 26.1 Итог, который должен получиться

- `https://app.lola.local` — приложение внутри домашней сети.
- `https://lola.<домен>` — то же приложение снаружи (документ 27).
- `pnpm` не нужен на сервере: всё запускается контейнерами.
- Обновление: `git pull && make deploy` — с миграциями и без простоя дольше 30 секунд.
- Бэкап БД и файлов каждую ночь, проверка восстановления — ежемесячно.

## 26.2 Виртуальная машина в Proxmox

Создаётся **VM (KVM)**, а не LXC: нужны вложенные контейнеры Docker и предсказуемая работа
ffmpeg. LXC допускается, но тогда контейнер должен быть привилегированным и с включённым
nesting — это хуже по изоляции. `[решение]`

| Параметр | Значение | Обоснование |
| --- | --- | --- |
| Имя | `lola-prod` | |
| ОС | Debian 12 (netinst) | тот же дистрибутив, что в остальном homelab |
| vCPU | 4 (host) | ffmpeg при перекодировании видео берёт всё, что дадут |
| RAM | 8 ГБ (min 6) | Postgres 2 ГБ + приложение 1.5 ГБ + воркер 2 ГБ + запас |
| Диск 1 (система) | 40 ГБ, SSD-пул, `discard=on` | |
| Диск 2 (данные) | 200 ГБ, монтируется в `/srv/lola` | отдельно от системы, чтобы расширять |
| Сеть | vmbr0, статический IP `192.168.x.50` | статика нужна для проброса и DNS |
| QEMU Guest Agent | включён | корректное выключение и снапшоты |
| Автозапуск | `onboot=1`, `startup=order=3` | после сетевого контейнера |

Базовая настройка ОС:

1. Пользователь `lola`, вход по ключу, вход root по паролю запрещён.
2. `ufw`: разрешены 22 (только из локальной сети), 80 и 443 (только с адреса шлюза),
   всё остальное закрыто.
3. `fail2ban` на ssh.
4. `unattended-upgrades` для security-обновлений ОС.
5. Часовой пояс `Europe/Kyiv`, `chrony` для времени: расхождение времени ломает OTP и подписи.
6. `systemd-journald` с ограничением журнала 500 МБ.

## 26.3 Структура каталогов

```
/srv/lola/
├─ app/                  # git-репозиторий приложения
├─ data/
│  ├─ postgres/          # том БД
│  ├─ minio/             # объектное хранилище (медиа)
│  └─ redis/             # опционально, если появится
├─ backups/
│  ├─ db/                # дампы
│  └─ media/             # зеркало бакета
├─ secrets/              # .env, ключи (chmod 600, владелец lola)
└─ logs/
```

## 26.4 Состав docker compose

Файл `docker-compose.prod.yml` в репозитории, переменные — из `/srv/lola/secrets/.env`.

| Сервис | Образ | Назначение | Порты | Ресурсы |
| --- | --- | --- | --- | --- |
| `db` | `postgres:16-alpine` + расширение pgvector | база | только внутри сети compose | 2 ГБ RAM |
| `minio` | `minio/minio` | S3-совместимое хранилище медиа | 9000 внутри | 1 ГБ |
| `app` | образ из репозитория (Node 22, Nuxt build) | веб-приложение и API | 3000 внутри | 1.5 ГБ |
| `worker` | тот же образ, команда `node worker.mjs` | фоновые задачи pg-boss, ffmpeg | — | 2 ГБ |
| `proxy` | `caddy:2` | локальный TLS, единая точка входа | 80, 443 наружу VM | 256 МБ |
| `backup` | `offen/docker-volume-backup` или свой cron-контейнер | ночные дампы | — | 256 МБ |

Правила:
- `restart: unless-stopped` у всех сервисов.
- Healthcheck у каждого: `db` — `pg_isready`; `app` — `GET /health`; `worker` — файл-heartbeat,
  обновляемый каждые 30 секунд; `minio` — `/minio/health/live`.
- Логи: драйвер `json-file`, `max-size=20m`, `max-file=5`.
- Никаких `latest`: версии образов фиксируются.
- Только `app` и `proxy` слушают наружу VM; `db` и `minio` — во внутренней сети compose.

## 26.5 Переменные окружения

`/srv/lola/secrets/.env` (права 600). Полный перечень, обязательные помечены `*`.

```ini
NODE_ENV=production
APP_URL*=https://lola.example.com          # публичный адрес, используется в письмах и ссылках
APP_INTERNAL_URL=https://app.lola.local
PORT=3000

DATABASE_URL*=postgres://lola:<pass>@db:5432/lola
DB_POOL_MAX=20

S3_ENDPOINT*=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET*=lola-media
S3_ACCESS_KEY*=
S3_SECRET_KEY*=
S3_PUBLIC_BASE=/files                      # отдаётся через proxy, не напрямую

SESSION_SECRET*=                           # 64 hex, ротация ломает активные сессии
ENCRYPTION_KEY*=                           # 32 байта base64, AES-GCM для секретов тенантов
OTP_PEPPER*=

TELEGRAM_BOT_TOKEN=
SMS_PROVIDER=turbosms|kyivstar|none
SMS_API_KEY=
SMTP_URL=

SENTRY_DSN=
LOG_LEVEL=info
TZ=Europe/Kyiv
```

Правила:
- Секреты генерируются командой `make secrets` и никогда не попадают в git.
- Приложение при старте валидирует `.env` zod-схемой и падает с понятной ошибкой,
  если обязательная переменная пуста — молча стартовать с дырой нельзя.
- Ротация `ENCRYPTION_KEY` — отдельной задачей с перешифрованием (см. `09-integrations.md`).

## 26.6 Первый запуск

```bash
git clone <repo> /srv/lola/app && cd /srv/lola/app
make secrets                 # генерация SESSION_SECRET, ENCRYPTION_KEY, OTP_PEPPER, паролей
make up                      # docker compose up -d
make migrate                 # drizzle-kit migrate
make seed-tenant NAME="Каппі" SLUG=kappi ADMIN_PHONE=+380661864742
make smoke                   # проверка /health, /ready, вход по OTP в тестовом режиме
```

`make seed-tenant` создаёт тенанта, системные роли, одну точку, одну позицию и админа;
код OTP в режиме `SMS_PROVIDER=none` пишется в лог — это допустимо только до подключения канала.

## 26.7 Локальный TLS и доменное имя внутри сети

- В домашнем DNS (Pi-hole / AdGuard / роутер) заводится запись `app.lola.local → 192.168.x.50`.
- Caddy выпускает **внутренний** сертификат (`tls internal`) и раздаёт его; корневой CA Caddy
  ставится на рабочие машины один раз, иначе браузер ругается.
- Альтернатива, если внутренний CA неудобен: использовать реальный домен и DNS-01 проверку
  Let's Encrypt (см. документ 27) — тогда сертификат валидный и внутри, и снаружи.

`Caddyfile` (локальная часть):

```
app.lola.local {
  tls internal
  encode zstd gzip
  handle /files/* {
    reverse_proxy minio:9000
  }
  handle {
    reverse_proxy app:3000
  }
  request_body {
    max_size 500MB          # загрузка видео уроков
  }
}
```

## 26.8 Обновление и откат

```bash
make deploy      # git pull → build образа → migrate → rolling restart app, worker → smoke
make rollback    # откат на предыдущий тег образа + инструкция по обратной миграции
```

Правила:
- Миграции применяются **до** переключения трафика; они обязаны быть обратно совместимыми
  с предыдущей версией кода (две версии живут одновременно секунды, но живут).
- `make deploy` останавливается, если `make smoke` не прошёл, и оставляет старую версию.
- Версия и хеш коммита видны в `/health` и в подвале интерфейса — чтобы понимать, что развёрнуто.

## 26.9 Бэкапы

| Что | Как | Расписание | Хранение |
| --- | --- | --- | --- |
| БД | `pg_dump -Fc` в `/srv/lola/backups/db` | ежедневно 03:00 | 30 дней |
| БД (точка во времени) | WAL-архив на второй диск | непрерывно | 7 дней |
| Медиа | `mc mirror` бакета в `/srv/lola/backups/media` | ежедневно 03:30 | 14 дней |
| Секреты | ручная копия при изменении | по факту | вне сервера |
| VM целиком | снапшот Proxmox | еженедельно | 4 снапшота |

Обязательное правило: **раз в месяц восстановление проверяется** — поднимается временный
контейнер, в него заливается вчерашний дамп, прогоняются миграции и smoke-тест. Непроверенный
бэкап бэкапом не считается. Копия дампа уезжает на второе устройство (NAS или облако),
шифрованная `age` или `gpg`.

## 26.10 Мониторинг и алерты

- `node_exporter`, `cadvisor`, `postgres_exporter` на VM; Prometheus и Grafana — там же,
  где уже живёт мониторинг homelab.
- Метрики приложения — `/metrics` (RED по HTTP, глубина очереди, время задач, ошибки Telegram).
- Uptime-проверка снаружи (Uptime Kuma): `GET /health` каждые 60 секунд.
- Алерты в Telegram: сервис не отвечает 2 минуты, место на диске < 15%, очередь > 500 задач,
  падений задач > 10 за 10 минут, бэкап не создан к 04:00, сертификат истекает через 10 дней.

## 26.11 Ресурсы и рост

Ориентир на старте: 300 человек, 50 одновременных, 20 ГБ медиа в год.
Триггеры расширения: диск данных > 70% → расширить том; CPU > 70% пять минут подряд в будни →
+2 vCPU; очередь стабильно > 200 → вынести `worker` во вторую VM (compose это позволяет,
меняется только `docker-compose.worker.yml` и адрес БД).

## 26.12 Критерии приёмки

1. `make up && make migrate && make smoke` на чистой VM проходит без ручных правок.
2. Перезагрузка VM: все сервисы поднимаются сами, приложение доступно за 60 секунд.
3. `docker compose down` и `up` не теряет ни данных БД, ни файлов.
4. Восстановление из вчерашнего дампа на пустой базе даёт рабочую систему.
5. `/health` отдаёт версию и хеш коммита; `/ready` краснеет, если БД или MinIO недоступны.
6. Ни один секрет не лежит в git и не виден в `docker inspect` в открытом виде.

## 26.13 Розгортання R1: VM за Tailscale + тунель Cloudflare (прийнята конфігурація)

Фактична середовище, під яке готується прод зараз (докс/32 §Б рядок 22, §Г.1). Відрізняється
від загального плану §26.2–26.12 ресурсами (одна VM на 4 ГБ, не 8) і способом виходу назовні:
публічного IP немає, тунель уже є для стенду — прод використовує другий, іменований тунель
на тому самому Cloudflare-акаунті. **Caddy (докс/27) у цій конфігурації не піднімається** —
TLS і вхід термінує Cloudflare, тунель ходить прямо у `app:3000`; профіль `public` з Caddy
лишається в `docker/docker-compose.prod.yml` як резерв для VM з білим IP.

| Параметр | Значення |
| --- | --- |
| VM | `devbox` (Proxmox), Debian 12, 2 vCPU / 4 ГБ / 32 ГБ, Docker 29 + compose v5 |
| Доступ до VM | тільки Tailscale, публічного IP немає |
| Домен | `lmscappi.pp.ua` у Cloudflare, Universal SSL покриває `*.lmscappi.pp.ua` |
| Прод | `app.lmscappi.pp.ua`; тенанти — `<slug>.lmscappi.pp.ua` (докс/25 §16.1, Spec 25) |
| Тунель стенду (є) | `lola-stand` → `lms.lmscappi.pp.ua`, конфіг `~/lola-demo/cf/config.yml` |
| Тунель прода (створити) | окремий іменований тунель, конфіг `~/lola-prod/cf/config.yml` |
| Каталог розгортання | `~/lola-prod` (не `/srv/lola` з §26.3 — без root, за зразком `~/lola-demo`) |

### 26.13.1 Тунель: створення (виконується один раз, вручну — не автоматизовано цим PR)

```bash
cloudflared tunnel login                       # якщо ще не логінились для lola-stand
cloudflared tunnel create lola-prod            # видає <UUID> і credentials-file ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns lola-prod app.lmscappi.pp.ua
cloudflared tunnel route dns lola-prod '*.lmscappi.pp.ua'   # wildcard — резолв тенанта по Host усередині app
```

`~/lola-prod/cf/config.yml` (том `tunnel` у `docker-compose.prod.yml` монтує `./cf` як
`/etc/cloudflared:ro`; сам файл і credentials — поза git):

```yaml
tunnel: lola-prod
credentials-file: /etc/cloudflared/<UUID>.json
ingress:
  - hostname: app.lmscappi.pp.ua
    service: http://app:3000
  - hostname: "*.lmscappi.pp.ua"
    service: http://app:3000
  - service: http_status:404
```

Резолв тенанта за `Host` — усередині застосунку (`server/middleware/01.host.ts`,
`TENANT_HOST_BASE=lmscappi.pp.ua`), тунелю не потрібно знати список тенантів.

### 26.13.2 Перший запуск

```bash
mkdir -p ~/lola-prod/cf
cp docker/docker-compose.prod.yml ~/lola-prod/docker-compose.yml
cp docker/Caddyfile ~/lola-prod/Caddyfile           # лежить про запас (профіль public)
cp scripts/{gen-env,first-run-prod,deploy-prod,backup-prod}.sh ~/lola-prod/
# credentials-file і config.yml тунеля — вручну, за 26.13.1
cd ~/lola-prod && bash first-run-prod.sh
```

`first-run-prod.sh`: генерує `.env` (`gen-env.sh`), піднімає `db`+`minio`, накочує міграції,
сіє `SEED_MODE=prod` (мінімальний тенант з `FIRST_TENANT_SLUG`/`FIRST_TENANT_NAME` і
адміністратором `FIRST_ADMIN_PHONE` — без демо-даних «Каппі»), виставляє реальні паролі
ролям `app_user`/`platform_admin` (`ALTER ROLE`, докс §26.5 — міграції 0001/0009 створюють
їх із dev-паролем), піднімає `app`+`tunnel`, чекає `/health`. Оператора платформи
(`PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD`) створює сам застосунок при старті
(`ensureFirstAdmin`, `server/plugins/worker.ts`) — окремого кроку не потрібно.

### 26.13.3 Оновлення (крон)

```
*/5 * * * * cd ~/lola-prod && bash deploy-prod.sh --if-changed >> deploy.log 2>&1
0   3 * * * cd ~/lola-prod && bash backup-prod.sh >> backup.log 2>&1
```

`deploy-prod.sh` тягне `:${APP_TAG:-latest}` з GHCR тільки для `app`/`migrate`, накочує
міграції одноразовим сервісом до перезапуску `app` (`depends_on: service_completed_successfully`),
чекає `/health`, друкує digest образу — щоб потім знайти саме цей знімок у GHCR. Руками:
`cd ~/lola-prod && bash deploy-prod.sh` (без `--if-changed` — оновлює завжди).

### 26.13.4 Відкат на конкретний коміт

```bash
cd ~/lola-prod
APP_TAG=<sha> bash deploy-prod.sh    # job `image` у CI пушить і :latest, і :<sha> (.github/workflows/ci.yml)
```

Міграції вперед сумісні (§26.8) — відкат образу без відкату схеми безпечний; відкат самої
схеми — новою міграцією, не руками в БД (CLAUDE.md п. 5).

### 26.13.5 Відновлення з бэкапа

```bash
cd ~/lola-prod
gunzip -c backups/db/<YYYY-MM-DD>.sql.gz | docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
# медіа — назад у бакет:
docker run --rm --network lola-prod_default -v "$PWD/backups/media/<YYYY-MM-DD>:/backup" \
  --entrypoint sh minio/mc:latest -c \
  "mc alias set dst http://minio:9000 \"$S3_ACCESS_KEY\" \"$S3_SECRET_KEY\" && mc mirror /backup dst/${S3_BUCKET:-lola-media}"
```

Перевірка відновлення — щомісяця, на окремому/тимчасовому стенді, не на проді (докс/26 §26.9,
докс/25 §16.2): «неперевірений бэкап бэкапом не рахується».

### 26.13.6 Чек-лист перед показом замовнику

- [ ] `OTP_DEBUG` відсутній або `0` — код входу не в логах.
- [ ] SMS-провайдер підключено в панелі тенанта (докс/09 §9.1) — вхід не залежить від логів.
- [ ] Свіжий бэкап є (`backups/db/*.sql.gz` за сьогодні/вчора, `backup.log` без помилок).
- [ ] `GET https://app.lmscappi.pp.ua/health` і `/ready` — `200`.
- [ ] `GET /metrics` з `Authorization: Bearer $METRICS_TOKEN` — `200`; без токена — відмова
      (докс/06 §6.7, `.env.production.example`).
- [ ] `SENTRY_DSN` заповнено — помилки не губляться мовчки.
- [ ] `<slug>.lmscappi.pp.ua` для першого тенанта відкривається (wildcard-маршрут тунеля).

### 26.13.7 Чого цей PR свідомо не робить

Підготовка, не викатка (докс/32 §Б рядок 22 → «🟡 підготовлено»): нічого не запускалося на
реальній VM, тунель прода не створювався, секрети не генерувалися. Рішення, що залишаються
за замовником/оператором до фактичної викатки — докс/32 §Г.1 (окрема VM чи прод поруч зі
стендом на тому самому `devbox`) і §Г.3 (уже закрито на користь іменованого тунеля — застосовано
тут для прода за аналогією зі стендом).
