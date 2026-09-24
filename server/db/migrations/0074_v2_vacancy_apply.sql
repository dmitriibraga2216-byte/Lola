-- docs/v2/45-plan.md PR-16 · docs/v2/29-vacancies.md §3.9, §6.3, §7.1–§7.8, §7.20 ·
-- docs/v2/39-patches.md П-25.3 · docs/v2/44-decisions.md В-9 (публичный контур).
--
-- Публичный контур — единственное место продукта, работающее **без сессии**. Тенант здесь
-- выводится из токена ссылки, а не из тела запроса, и дальше всё идёт через `withTenant()`
-- (CLAUDE.md правило 2). Чтобы вывод тенанта был возможен до установки `app.tenant_id`,
-- нужна одна функция `SECURITY DEFINER` — ровно как `mystery_link_lookup` у тайного
-- покупателя (`0021_mystery_spec20.sql`). Механизм не изобретается заново: он обкатан.
--
-- Отклик заведён **отдельной сущностью**, а не сразу кандидатом (`29` §3.9 [решение]):
-- сырые данные из публичного интернета не попадают в `users` без единой точки проверки,
-- подозрительный отклик придерживается на модерации и не занимает места в оплачиваемой оси
-- `candidates_active`.

-- ── 1. Язык публичной страницы (`29` §7.20) ─────────────────────────────────────────────
-- `29` §3.1 колонки языка не содержит, но §7.20 требует записать откликнувшемуся
-- `comm_language` = «язык публичной страницы». Язык администратора, открывшего форму
-- вакансии, к посетителю отношения не имеет, поэтому язык назван явно: `null` — язык
-- пространства (`tenants.locale`).
ALTER TABLE "vacancies" ADD COLUMN "public_language" text;--> statement-breakpoint
ALTER TABLE "vacancies" ADD CONSTRAINT "vacancies_public_language_chk" CHECK ("public_language" is null or "public_language" in ('uk', 'en', 'ru'));--> statement-breakpoint

-- ── 2. Отклик (`29` §3.9) ───────────────────────────────────────────────────────────────
-- `ip_hash` — HMAC-SHA256 адреса с посолью тенанта: сырой IP не хранится нигде, а частотные
-- правила §7.4 сравнивают именно хэши. `consent_given_at` — момент из формы, а не из
-- транзакции найма: от него считается срок стирания ПД (§7.23), и назначать его задним
-- числом нельзя.
CREATE TABLE "vacancy_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vacancy_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"full_name" text NOT NULL,
	"phone" text,
	"email" text,
	"comment" text,
	"resume_asset_id" uuid,
	"source" text DEFAULT 'vacancy_link' NOT NULL,
	"source_detail" text,
	"utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consent_given_at" timestamp with time zone NOT NULL,
	"consent_text_version" text NOT NULL,
	"candidate_id" uuid,
	"spam_score" integer DEFAULT 0 NOT NULL,
	"spam_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"ip_hash" text NOT NULL,
	"user_agent_hash" text,
	"form_nonce" text NOT NULL,
	"fill_seconds" integer,
	"otp_confirmed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"reject_reason" text,
	CONSTRAINT "vacancy_applications_state_chk" CHECK ("state" in ('pending', 'pending_review', 'accepted', 'merged', 'rejected', 'spam', 'expired')),
	CONSTRAINT "vacancy_applications_contact_chk" CHECK ("phone" is not null or "email" is not null),
	CONSTRAINT "vacancy_applications_name_chk" CHECK (length("full_name") BETWEEN 2 AND 120)
);
--> statement-breakpoint
ALTER TABLE "vacancy_applications" ADD CONSTRAINT "vacancy_applications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_applications" ADD CONSTRAINT "vacancy_applications_vacancy_id_vacancies_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_applications" ADD CONSTRAINT "vacancy_applications_resume_asset_id_media_assets_id_fk" FOREIGN KEY ("resume_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_applications" ADD CONSTRAINT "vacancy_applications_candidate_id_users_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vacancy_applications" ADD CONSTRAINT "vacancy_applications_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vacancy_applications_tenant" ON "vacancy_applications" USING btree ("tenant_id","vacancy_id","state","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_vacancy_applications_ip" ON "vacancy_applications" USING btree ("tenant_id","ip_hash","created_at" DESC);--> statement-breakpoint
ALTER TABLE vacancy_applications ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE vacancy_applications FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON vacancy_applications
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 3. Журнал обращений к публичной форме (`29` §3.9, §7.4) ─────────────────────────────
-- Пишется и на успех, и на отказ: ответ формы одинаков в обоих случаях (§7.3 — форма
-- никогда не сообщает боту, какая проверка сработала), и без этой строки «почему не
-- приняли» не восстановить ни рекрутеру, ни поддержке. Строки старше 30 дней убирает
-- `vacancy.attempts_gc` (§11).
CREATE TABLE "public_apply_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vacancy_id" uuid,
	"ip_hash" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_apply_attempts_outcome_chk" CHECK ("outcome" in ('view', 'submit_ok', 'submit_blocked', 'otp_sent', 'otp_failed'))
);
--> statement-breakpoint
ALTER TABLE "public_apply_attempts" ADD CONSTRAINT "public_apply_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_apply_attempts" ADD CONSTRAINT "public_apply_attempts_vacancy_id_vacancies_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_public_apply_attempts_tenant" ON "public_apply_attempts" USING btree ("tenant_id","ip_hash","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_public_apply_attempts_vacancy" ON "public_apply_attempts" USING btree ("tenant_id","vacancy_id","created_at" DESC);--> statement-breakpoint
ALTER TABLE public_apply_attempts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public_apply_attempts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public_apply_attempts
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 4. Вывод тенанта из токена ссылки (`29` §10 [решение], П-25.3, В-9) ──────────────────
-- Публичная страница приходит без сессии: `app.tenant_id` ещё не выставлен, и обычный
-- SELECT по `vacancies` под RLS вернёт ноль строк. Ровно та же задача решена у тайного
-- покупателя (`mystery_link_lookup`), и решение повторяется буквально: одна функция
-- `SECURITY DEFINER`, отдающая **только** то, что нужно для вывода тенанта и владельца
-- контекста, — ни одного поля вакансии наружу.
--
-- Токен уникален глобально (`uq_vacancies_public_token`, PR-15), поэтому строка не более
-- одной. `public_enabled` и `state` возвращаются, чтобы вызывающий отличил «нет такой
-- ссылки» от «набор приостановлен» — снаружи и то и другое выглядит одинаково (§7.2),
-- но коды ответа разные (404 против 410).
CREATE OR REPLACE FUNCTION vacancy_public_lookup(p_token text)
RETURNS TABLE (id uuid, tenant_id uuid, state text, public_enabled boolean, owner_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, tenant_id, state, public_enabled, coalesce(recruiter_id, created_by)
    FROM vacancies WHERE public_token = p_token
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION vacancy_public_lookup(text) TO app_user;
