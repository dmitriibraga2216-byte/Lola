# Команды прода — общий (не-R1) вариант докс/26 §26.6, §26.8, без Caddy/тунеля см. §26.13.
# Конкретный рабочий runbook для принятой конфигурации R1 (VM без белого IP, каталог
# ~/lola-prod) — docs/26 §26.13, через scripts/{gen-env,first-run-prod,deploy-prod,backup-prod}.sh;
# secrets/deploy здесь делегируют туда же, чтобы не разъезжаться в двух местах.
COMPOSE := docker compose -f docker/docker-compose.prod.yml
ENV_FILE ?= /srv/lola/secrets/.env
export ENV_FILE
APP_TAG ?= latest
export APP_TAG

.PHONY: secrets up down build migrate seed-tenant smoke deploy rollback logs backup restore-check tunnel-init

secrets: ## Сгенерировать .env с секретами (делегирует scripts/gen-env.sh, не перезаписывает существующий)
	@LOLA_PROD_DIR=$(dir $(ENV_FILE)) bash scripts/gen-env.sh

up: ## Поднять все сервисы (без профиля public — см. docs/26 §26.13)
	$(COMPOSE) up -d --wait

down:
	$(COMPOSE) down

build: ## Образ теперь тянется из GHCR, не собирается локально (docs/28 §28.6) — синоним pull
	$(COMPOSE) pull app migrate

migrate: ## Применить миграции (от владельца БД) — то же самое, что делает сервис `migrate`
	$(COMPOSE) run --rm migrate

seed-tenant: ## make seed-tenant NAME="Каппі" SLUG=kappi ADMIN_PHONE=+380...
	@test -n "$(SLUG)" || (echo "SLUG обязателен" && exit 1)
	$(COMPOSE) exec app node -e "fetch('http://localhost:3000/api/v1/platform/tenants',{method:'POST',headers:{'Content-Type':'application/json','Cookie':'lola_ops='+process.env.OPS_TOKEN},body:JSON.stringify({slug:'$(SLUG)',name:'$(NAME)',adminPhone:'$(ADMIN_PHONE)',adminName:'Адміністратор'})}).then(r=>r.json()).then(j=>{console.log(JSON.stringify(j));process.exit(j.error?1:0)})"

smoke: ## /health и /ready
	@curl -sf http://localhost/health -H "Host: $${APP_HOST:-app.lola.local}" -k https://localhost/health >/dev/null 2>&1 || $(COMPOSE) exec app curl -sf http://localhost:3000/health
	@$(COMPOSE) exec app curl -sf http://localhost:3000/ready && echo "\nsmoke ok"

deploy: ## git pull → pull образа → migrate → рестарт app → smoke (см. также scripts/deploy-prod.sh)
	git pull --ff-only
	$(MAKE) build
	$(MAKE) migrate
	$(COMPOSE) up -d --no-deps --wait app
	$(MAKE) smoke || ($(MAKE) rollback && exit 1)
	@echo "deployed $(APP_TAG)"

rollback: ## Откат на конкретный тег образа из GHCR: make rollback APP_TAG=<sha>
	@test "$(APP_TAG)" != "latest" || (echo "укажите APP_TAG=<sha из GHCR> — .github/workflows/ci.yml пушит и :latest, и :<sha>" && exit 1)
	$(COMPOSE) pull app migrate
	$(COMPOSE) up -d --no-deps --wait app
	@echo "rolled back to $(APP_TAG) — миграции откатывать новой миграцией, не руками в БД"

logs:
	$(COMPOSE) logs -f --tail=200 app

backup: ## Ручной дамп сейчас (по крону — scripts/backup-prod.sh, докс/06 §6.6)
	$(COMPOSE) exec db sh -c 'PGPASSWORD=$$POSTGRES_PASSWORD pg_dump -U $$POSTGRES_USER -Fc $$POSTGRES_DB' > backups/db/manual-$$(date +%F-%H%M).dump

restore-check: ## Ежемесячная проверка: вчерашний дамп во временный контейнер + smoke (docs/26 §26.9)
	@f=$$(ls -t backups/db/*.dump | head -1); echo "проверяю $$f"; \
	docker run --rm -d --name lola-restore-check -e POSTGRES_PASSWORD=x pgvector/pgvector:pg16 >/dev/null && sleep 5 && \
	docker cp $$f lola-restore-check:/tmp/d.dump && \
	docker exec lola-restore-check sh -c 'pg_restore -U postgres -d postgres /tmp/d.dump && psql -U postgres -c "select count(*) as tenants from tenants"' ; \
	docker rm -f lola-restore-check >/dev/null

tunnel-init: ## Регистрация именованного тунеля Cloudflare — конфиг-файлом, не токеном (docs/26 §26.13.1)
	@echo "1) cloudflared tunnel login  2) cloudflared tunnel create lola-prod"
	@echo "3) cloudflared tunnel route dns lola-prod app.<домен>  (и wildcard '*.<домен>')"
	@echo "4) заполнить \$${CF_DIR:-./cf}/config.yml (tunnel/credentials-file/ingress) — см. docs/26 §26.13.1"
	@echo "5) $(COMPOSE) up -d tunnel  (без профиля — сервис поднимается по умолчанию)"
