-- docs/v2/45-plan.md PR-35 · docs/v2/38-people-extensions.md §3.1 (`users.rating_pct`,
-- `users.rating_updated_at`, частичный индекс), §3.7 (DDL снимков), §5.2 (колонка «%»), §5.3
-- (экран расшифровки), §7.1–§7.3 (формула, пересчёт, правила показа), §11 (`rating.recalc`),
-- §13 критерии 1–3 · docs/v2/39 П-16.3 · docs/v2/40 §2.11.
--
-- ── Что здесь и почему так ─────────────────────────────────────────────────────────────
-- Індекс навчальної залученості — **не «Поточний рейтинг»**. Баллы рейтинга (`points_ledger`,
-- docs/33 D-069) — валюта геймификации: копятся, тратятся, начисляются вручную. Индекс — справочная
-- величина 0…130 %, пересчитывается раз в сутки целиком из первичных данных (`enrollments` и
-- суточного агрегата ленты `user_activity_daily`) и вручную не меняется. Имена колонки и таблицы —
-- из DDL пакета; подписи интерфейса называют величину «індекс залученості», чтобы на карточке не
-- было двух разных «рейтингов».
--
-- Источник истины — снимок `person_rating_snapshots`: он хранит не только итог, но и числа,
-- подставленные в формулу (`breakdown`), — экран «Звідки взявся мій відсоток» их показывает, а не
-- пересчитывает. `users.rating_pct` — денормализованная копия текущего снимка для колонки «%» и её
-- сортировки. `null` — «не рассчитан»: назначений в окне нет (в списке «—», не «0 %»), кандидатам
-- индекс не считается вовсе.
--
-- ── Отступления от DDL `38` §3.1, §3.7 (решения Р-35.x, `46-progress.md`) ─────────────────
-- * Частичный индекс — `where kind = 'employee'`, без `and status = 'active'`: вкладка «Активні»
--   списка — это `invited` + `active`, у архивированных фиксируется последнее значение (§7.2), а
--   индекс с предикатом `status = 'active'` планировщик не может взять ни для одной из вкладок.
-- * Отдельного `idx_person_rating_snapshots_tenant (tenant_id, user_id, calc_date desc)` нет:
--   уникальный ключ `(tenant_id, user_id, calc_date)` — тот же btree (читается и в обратном порядке),
--   второй такой же индекс только удваивал бы запись (тот же довод, что у `user_activity_daily`, PR-34).
-- * Сверх DDL: `uq_person_rating_current` — «текущий» снимок у человека ровно один, схемой, а не
--   кодом (как `uq_employee_lifecycle_current`, PR-07); проверки слагаемых по их пределам
--   (0…100 основа, 0…10 каждый бонус) и порядка окна.
-- * `rating_pct` получает тот же `check` 0…130, что и снимок: копия не может разойтись с
--   источником по диапазону.

-- ── 1. users: денормализованный индекс для колонки «%» (`38` §3.1) ──────────────────────────
ALTER TABLE "users" ADD COLUMN "rating_pct" numeric(5, 1);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "rating_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_rating_pct_chk" CHECK ("rating_pct" IS NULL OR "rating_pct" BETWEEN 0 AND 130);--> statement-breakpoint
CREATE INDEX "idx_users_tenant_rating" ON "users" USING btree ("tenant_id", "rating_pct" DESC NULLS LAST) WHERE kind = 'employee';--> statement-breakpoint
COMMENT ON COLUMN "users"."rating_pct" IS 'Індекс навчальної залученості 0…130 % (docs/v2/38 §7.1) — копия текущего снимка person_rating_snapshots для колонки «%» списка. НЕ баллы рейтинга points_ledger. null — не рассчитан (назначений в окне нет, кандидат)';--> statement-breakpoint
COMMENT ON COLUMN "users"."rating_updated_at" IS 'Когда индекс пересчитан; старше 48 часов — цифра серая с подсказкой «Дані оновлюються» (docs/v2/38 §3.1)';--> statement-breakpoint

-- ── 2. person_rating_snapshots — снимок расчёта с разложением формулы (`38` §3.7) ──────────
CREATE TABLE "person_rating_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"calc_date" date NOT NULL,
	"base_pct" numeric(5, 1) NOT NULL,
	"bonus_early" numeric(4, 1) DEFAULT '0' NOT NULL,
	"bonus_streak" numeric(4, 1) DEFAULT '0' NOT NULL,
	"bonus_help" numeric(4, 1) DEFAULT '0' NOT NULL,
	"total_pct" numeric(5, 1) NOT NULL,
	"breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"window_from" date NOT NULL,
	"window_to" date NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_person_rating_day" UNIQUE("tenant_id","user_id","calc_date"),
	CONSTRAINT "person_rating_total_chk" CHECK ("total_pct" BETWEEN 0 AND 130),
	CONSTRAINT "person_rating_parts_chk" CHECK ("base_pct" BETWEEN 0 AND 100 AND "bonus_early" BETWEEN 0 AND 10 AND "bonus_streak" BETWEEN 0 AND 10 AND "bonus_help" BETWEEN 0 AND 10),
	CONSTRAINT "person_rating_window_chk" CHECK ("window_from" <= "window_to")
);--> statement-breakpoint
ALTER TABLE "person_rating_snapshots" ADD CONSTRAINT "person_rating_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_rating_snapshots" ADD CONSTRAINT "person_rating_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_person_rating_current" ON "person_rating_snapshots" USING btree ("tenant_id","user_id") WHERE is_current;--> statement-breakpoint
ALTER TABLE person_rating_snapshots ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE person_rating_snapshots FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON person_rating_snapshots
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON TABLE "person_rating_snapshots" IS 'Снимок індексу навчальної залученості (docs/v2/38 §3.7, §7.2): итог, четыре слагаемых и числа формулы (breakdown) на дату расчёта. Пишет только rating.recalc и ручной пересчёт. Не баллы points_ledger';--> statement-breakpoint
COMMENT ON COLUMN "person_rating_snapshots"."breakdown" IS 'Числа, подставленные в формулу (formula_version, основа с вкладом записей, досрочность, серия, действия помощи) — экран расшифровки показывает их, а не пересчитывает (§5.3, §7.2)';--> statement-breakpoint
COMMENT ON COLUMN "person_rating_snapshots"."is_current" IS 'Текущий снимок человека — ровно один (uq_person_rating_current); у «не рассчитан» текущего снимка нет';--> statement-breakpoint

-- ── 3. Скоуп чужого индекса руководителю точки (`38` §2) ──────────────────────────────────
-- «Видеть чужой рейтинг и расшифровку»: manager — свои точки, hr — весь тенант (скоуп на кастомной
-- роли), admin — весь тенант. Скоуп заведён PR-03 и был только у администратора свежих тенантов;
-- руководителю точки — в области его роли, администратору заведённых тенантов — догоняющая выдача
-- (его набор в БД собирался до PR-03), как в PR-32 и PR-34.
UPDATE roles SET scopes = scopes || ARRAY(
	SELECT s FROM unnest(ARRAY['person.rating.view_others']::text[]) AS s
	WHERE NOT s = ANY(roles.scopes)
)
WHERE is_system AND code IN ('manager', 'admin');
