# Команды прода (docs/26 §26.6, §26.8). Запускать из /srv/lola/app.
COMPOSE := docker compose -f docker/docker-compose.prod.yml
ENV_FILE ?= /srv/lola/secrets/.env
export ENV_FILE
APP_VERSION ?= $(shell git describe --tags --always 2>/dev/null || echo dev)
APP_COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo local)
export APP_VERSION APP_COMMIT

.PHONY: secrets up down build migrate seed-tenant smoke deploy rollback logs backup restore-check tunnel-init

secrets: ## Сгенерировать .env с секретами (не перезаписывает существующий)
	@test -f $(ENV_FILE) && echo "$(ENV_FILE) уже есть — не трогаю" || ( \
		mkdir -p $(dir $(ENV_FILE)) && cp .env.production.example $(ENV_FILE) && \
		sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$$(openssl rand -hex 32)|; \
		        s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$$(openssl rand -base64 32)|; \
		        s|^OTP_PEPPER=.*|OTP_PEPPER=$$(openssl rand -hex 24)|; \
		        s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$$(openssl rand -hex 16)|; \
		        s|^S3_SECRET_KEY=.*|S3_SECRET_KEY=$$(openssl rand -hex 20)|; \
		        s|^PLATFORM_ADMIN_PASSWORD=.*|PLATFORM_ADMIN_PASSWORD=$$(openssl rand -base64 18)|" $(ENV_FILE) && \
		chmod 600 $(ENV_FILE) && echo "Секреты записаны в $(ENV_FILE). Заполните APP_URL и пароли БД для app_user/platform_admin." )

up: ## Поднять все сервисы
	$(COMPOSE) up -d --wait

down:
	$(COMPOSE) down

build: ## Собрать образ приложения с версией и хешем коммита
	$(COMPOSE) build app

migrate: ## Применить миграции (от владельца БД)
	$(COMPOSE) run --rm -e DATABASE_ADMIN_URL app node --import tsx server/db/migrate.ts

seed-tenant: ## make seed-tenant NAME="Каппі" SLUG=kappi ADMIN_PHONE=+380...
	@test -n "$(SLUG)" || (echo "SLUG обязателен" && exit 1)
	$(COMPOSE) exec app node -e "fetch('http://localhost:3000/api/v1/platform/tenants',{method:'POST',headers:{'Content-Type':'application/json','Cookie':'lola_ops='+process.env.OPS_TOKEN},body:JSON.stringify({slug:'$(SLUG)',name:'$(NAME)',adminPhone:'$(ADMIN_PHONE)',adminName:'Адміністратор'})}).then(r=>r.json()).then(j=>{console.log(JSON.stringify(j));process.exit(j.error?1:0)})"

smoke: ## /health и /ready
	@curl -sf http://localhost/health -H "Host: $${APP_HOST:-app.lola.local}" -k https://localhost/health >/dev/null 2>&1 || $(COMPOSE) exec app curl -sf http://localhost:3000/health
	@$(COMPOSE) exec app curl -sf http://localhost:3000/ready && echo "\nsmoke ok"

deploy: ## git pull → build → migrate → rolling restart → smoke (docs/26 §26.8)
	git pull --ff-only
	$(MAKE) build
	$(MAKE) migrate
	$(COMPOSE) up -d --no-deps --wait app worker
	$(MAKE) smoke || ($(MAKE) rollback && exit 1)
	@echo "deployed $(APP_VERSION) ($(APP_COMMIT))"

rollback: ## Откат на предыдущий образ
	@prev=$$(docker images lola/app --format '{{.Tag}}' | sed -n 2p); \
	test -n "$$prev" || (echo "нет предыдущего образа" && exit 1); \
	APP_VERSION=$$prev $(COMPOSE) up -d --no-deps --wait app worker && echo "rolled back to $$prev — миграции откатывать новой миграцией"

logs:
	$(COMPOSE) logs -f --tail=200 app worker

backup: ## Ручной дамп сейчас
	$(COMPOSE) exec db sh -c 'PGPASSWORD=$$POSTGRES_PASSWORD pg_dump -U $$POSTGRES_USER -Fc $$POSTGRES_DB' > backups/db/manual-$$(date +%F-%H%M).dump

restore-check: ## Ежемесячная проверка: вчерашний дамп во временный контейнер + smoke (docs/26 §26.9)
	@f=$$(ls -t backups/db/*.dump | head -1); echo "проверяю $$f"; \
	docker run --rm -d --name lola-restore-check -e POSTGRES_PASSWORD=x pgvector/pgvector:pg16 >/dev/null && sleep 5 && \
	docker cp $$f lola-restore-check:/tmp/d.dump && \
	docker exec lola-restore-check sh -c 'pg_restore -U postgres -d postgres /tmp/d.dump && psql -U postgres -c "select count(*) as tenants from tenants"' ; \
	docker rm -f lola-restore-check >/dev/null

tunnel-init: ## Регистрация Cloudflare Tunnel (docs/27 §27.4)
	@echo "1) cloudflared tunnel login  2) cloudflared tunnel create lola  3) токен → CF_TUNNEL_TOKEN в .env  4) $(COMPOSE) --profile tunnel up -d cloudflared"
