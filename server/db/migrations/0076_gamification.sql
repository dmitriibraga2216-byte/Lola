-- Геймификация: книга баллов и бонусов, магазин подарков, заказы (docs/02 §2.10 и «Корпоративный
-- хаб», docs/21 §3.7, §14.3, §14.9, Г-21.1; docs/15 §14.3 «Нагороди»; docs/33 D-069).
--
-- Четыре таблицы тенанта, у каждой — FK на tenants, RLS enable+force с политикой using/with check
-- и индекс, начинающийся с tenant_id (CLAUDE.md п. 1; rls.spec.ts, schema-parity.spec.ts).
-- Перечни значений (currency, event, status) — из docs/02 «Перечисления» и shared/enums.ts.

-- ── 1. points_ledger — книга операций с остатком в строке (§2.10, `21` §14.9) ─────────────
-- Баланс человека по валюте — balance_after последней строки (по id), отдельного поля нет.
-- Строки не правятся и не удаляются: отмена заказа — компенсирующая строка refund.
CREATE TABLE "points_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"event" text NOT NULL,
	"ref_id" uuid,
	"title" text,
	"comment" text,
	"actor_id" uuid,
	"request_context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_ledger_currency_chk" CHECK (currency in ('points', 'bonuses')),
	CONSTRAINT "points_ledger_event_chk" CHECK (event in ('task_completed', 'manual', 'purchase', 'refund')),
	CONSTRAINT "points_ledger_delta_chk" CHECK (delta <> 0),
	CONSTRAINT "points_ledger_balance_chk" CHECK (balance_after >= 0),
	-- Тип ссылки задаёт событие: у ручной операции ссылки нет, у остальных она обязательна —
	-- иначе уникальный индекс ниже (null различны) перестал бы защищать от повтора
	CONSTRAINT "points_ledger_ref_chk" CHECK ((event = 'manual') = (ref_id is null))
);--> statement-breakpoint
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Идемпотентность: одно завершение назначения / одна покупка / один возврат — одна строка
CREATE UNIQUE INDEX "points_ledger_once_uq" ON "points_ledger" USING btree ("tenant_id","user_id","currency","event","ref_id");--> statement-breakpoint
-- «Последняя строка человека по валюте» и история в кабинете
CREATE INDEX "points_ledger_user_idx" ON "points_ledger" USING btree ("tenant_id","user_id","currency","id");--> statement-breakpoint
-- Журнал операций по периоду
CREATE INDEX "points_ledger_created_idx" ON "points_ledger" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE points_ledger ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE points_ledger FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON points_ledger
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON COLUMN "points_ledger"."balance_after" IS 'Остаток этой валюты у человека после операции. Баланс = balance_after последней строки; расхождение с суммой delta — повод для алерта, а не для тихой правки (docs/21 §14.9)';--> statement-breakpoint
COMMENT ON COLUMN "points_ledger"."ref_id" IS 'task_completed → assignments.id; purchase/refund → shop_orders.id; manual → null';--> statement-breakpoint

-- ── 2. shop_categories — справочник категорий товаров тенанта (`21` §14.3) ─────────────────
CREATE TABLE "shop_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "shop_categories_tenant_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "shop_categories_name_chk" CHECK (char_length(name) between 1 and 60)
);--> statement-breakpoint
ALTER TABLE "shop_categories" ADD CONSTRAINT "shop_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE shop_categories ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE shop_categories FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON shop_categories
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 3. shop_items — товар (`21` Г-21.1 [решение]) ────────────────────────────────────────────
-- stock null — без ограничения (выходной, скидка); location_id null — «будь-яка» точка выдачи;
-- limit_per_user null — без лимита. Удаление мягкое: на товар ссылаются заказы и книга.
CREATE TABLE "shop_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"image_key" text,
	"category_id" uuid,
	"price_bonuses" integer NOT NULL,
	"stock" integer,
	"location_id" uuid,
	"limit_per_user" integer,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "shop_items_title_chk" CHECK (char_length(title) between 2 and 120),
	CONSTRAINT "shop_items_price_chk" CHECK (price_bonuses between 1 and 10000),
	CONSTRAINT "shop_items_stock_chk" CHECK (stock is null or stock >= 0),
	CONSTRAINT "shop_items_limit_chk" CHECK (limit_per_user is null or limit_per_user >= 1)
);--> statement-breakpoint
ALTER TABLE "shop_items" ADD CONSTRAINT "shop_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_items" ADD CONSTRAINT "shop_items_category_id_shop_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."shop_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_items" ADD CONSTRAINT "shop_items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_items" ADD CONSTRAINT "shop_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shop_items_tenant_idx" ON "shop_items" USING btree ("tenant_id","is_active");--> statement-breakpoint
ALTER TABLE shop_items ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE shop_items FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON shop_items
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON COLUMN "shop_items"."stock" IS 'null — без ограничения: у выходного дня или скидки физического остатка нет, выдача — отметкой ответственного';--> statement-breakpoint
COMMENT ON COLUMN "shop_items"."image_key" IS 'media_assets.id изображения товара (origin content_cover — обложка карточки каталога, docs/v2/40 §4.1)';--> statement-breakpoint

-- ── 4. shop_orders — заказ (docs/02 «Корпоративный хаб», `21` Г-21.1) ──────────────────────
CREATE TABLE "shop_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"price_bonuses" integer NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_until" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"issued_by" uuid,
	"issued_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	CONSTRAINT "shop_orders_status_chk" CHECK (status in ('reserved', 'ready', 'issued', 'cancelled')),
	CONSTRAINT "shop_orders_price_chk" CHECK (price_bonuses >= 1),
	CONSTRAINT "shop_orders_issued_chk" CHECK ((status = 'issued') = (issued_at is not null)),
	CONSTRAINT "shop_orders_cancelled_chk" CHECK ((status = 'cancelled') = (cancelled_at is not null))
);--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_item_id_shop_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."shop_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_orders" ADD CONSTRAINT "shop_orders_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Очередь «До видачі» и автоотмена просроченного резерва
CREATE INDEX "shop_orders_status_idx" ON "shop_orders" USING btree ("tenant_id","status","reserved_until");--> statement-breakpoint
-- «Мої замовлення» / «Придбані»
CREATE INDEX "shop_orders_user_idx" ON "shop_orders" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
-- Лимит на человека и «Замовлено» по товару
CREATE INDEX "shop_orders_item_idx" ON "shop_orders" USING btree ("tenant_id","item_id","status");--> statement-breakpoint
ALTER TABLE shop_orders ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE shop_orders FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON shop_orders
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 5. Стартовые категории товаров для уже заведённых тенантов ──────────────────────────────
-- Решение владельца продукта (24.09.2026): мерч, вихідні дні, знижки, «щось у закладі». Новым
-- тенантам их засевает ensureTenantDefaults (server/db/tenantDefaults.ts, DEFAULT_SHOP_CATEGORIES);
-- на чистой БД (CI) тенантов ещё нет, и эта вставка ничего не делает.
INSERT INTO shop_categories (tenant_id, name, sort)
SELECT t.id, c.name, c.sort
FROM tenants t
CROSS JOIN (VALUES ('Мерч', 0), ('Вихідні дні', 1), ('Знижки', 2), ('У закладі', 3)) AS c(name, sort)
ON CONFLICT (tenant_id, name) DO NOTHING;--> statement-breakpoint

-- ── 6. Скоупы магазина и бонусов у системных ролей уже заведённых тенантов ─────────────────
-- docs/01 §1.3 «Мотивація», §1.4: shop.manage — admin; shop.issue — manager, admin;
-- bonus.grant — mentor, manager, admin (docs/21 §2 «Начислять баллы вручную»). Новым тенантам —
-- из SYSTEM_ROLES (shared/domain/roles.ts).
UPDATE roles SET scopes = array_cat(scopes, ARRAY['bonus.grant'])
	WHERE is_system AND code = 'mentor' AND NOT scopes @> ARRAY['bonus.grant'];--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['shop.issue', 'bonus.grant'])
	WHERE is_system AND code = 'manager' AND NOT scopes @> ARRAY['shop.issue'];--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['shop.manage', 'shop.issue', 'bonus.grant'])
	WHERE is_system AND code = 'admin' AND NOT scopes @> ARRAY['shop.manage'];
