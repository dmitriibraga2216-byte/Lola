-- docs/v2/45-plan.md PR-10 · docs/v2/35-billing-limits.md §3.5, §3.6, §7.8 п. 6, §10 ·
-- docs/v2/39-patches.md П-24.4 · docs/v2/44-decisions.md §8 (обходной путь «платёжный провайдер»)
--
-- Приём платежа и заявка на смену тарифа: `tenant_payments`, `plan_change_requests`, плюс
-- отложенный FK `tenant_addons.payment_id` → `tenant_payments(id)` (объявлен в PR-08,
-- 0059_v2_billing_plans.sql, как «появится в PR-10»).
--
-- `plan_code`, а не `plan_id uuid references plans(id)` / `from_plan_id` / `to_plan_id`:
-- то же исправление В-5, что уже внесено в `plan_prices` (0059) и `tenant_usage.plan_code`
-- (0061) — у `plans` нет колонки `id`, PK по `code`. Документ `35` §3.5 правится этим же PR
-- пометкой `[исправлено]` — его DDL ещё показывал старые `plan_id`/`*_plan_id`.

-- ── 1. tenant_payments — история платежей (§3.5, §9, §10) ────────────────────────────────
-- Провайдера нет (`44` §8, `HANDOFF` §6): платёж принимает оператор платформы вручную,
-- `POST /platform/tenants/:id/payments`. Статус пишется сразу `paid` — отдельного webhook'а
-- подтверждения нет и не появится в этом PR.
CREATE TABLE "tenant_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"plan_code" text,
	"addon_code" text,
	"billing_period" text,
	"period_from" date,
	"period_to" date,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"paid_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text,
	"invoice_number" text,
	"invoice_media_id" uuid,
	"comment" text,
	"created_by" uuid,
	CONSTRAINT "tenant_payments_kind_check" CHECK ("kind" IN ('subscription', 'addon', 'adjustment')),
	CONSTRAINT "tenant_payments_billing_period_check" CHECK ("billing_period" IS NULL OR "billing_period" IN ('month', 'year')),
	-- Деньги в минорных единицах, как в plan_prices.amount_minor (§3.4) — целым числом, без float
	CONSTRAINT "tenant_payments_amount_minor_check" CHECK ("amount_minor" >= 0),
	CONSTRAINT "tenant_payments_status_check" CHECK ("status" IN ('pending', 'paid', 'failed', 'refunded', 'written_off')),
	CONSTRAINT "tenant_payments_method_check" CHECK ("method" IS NULL OR "method" IN ('bank_transfer', 'card', 'manual')),
	CONSTRAINT "tenant_payments_tenant_id_invoice_number_unique" UNIQUE("tenant_id","invoice_number")
);--> statement-breakpoint
ALTER TABLE "tenant_payments" ADD CONSTRAINT "tenant_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_payments" ADD CONSTRAINT "tenant_payments_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tenant_payments" ADD CONSTRAINT "tenant_payments_addon_code_plan_addons_code_fk" FOREIGN KEY ("addon_code") REFERENCES "public"."plan_addons"("code") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
-- Индекс §3.5 дословно: tenant-first, непартиальный (контрактный тест v2-contract-02)
CREATE INDEX "tenant_payments_tenant_id_created_at_index" ON "tenant_payments" USING btree ("tenant_id","created_at" DESC);--> statement-breakpoint
-- Таблица тенанта — RLS обязателен (CLAUDE.md п. 1, контрактный тест v2-contract-01)
ALTER TABLE tenant_payments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_payments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_payments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON COLUMN "tenant_payments"."period_from" IS 'Для kind=subscription: прежний paid_until (или сегодня при первой оплате) — точка, ОТ которой считается продление (§7.8 п. 6)';--> statement-breakpoint
COMMENT ON COLUMN "tenant_payments"."period_to" IS 'Новый paid_until: period_from + период. НЕ дата оплаты + период — иначе просрочка стала бы бесплатной отсрочкой';--> statement-breakpoint

-- ── 2. plan_change_requests — заявка на смену тарифа (§3.5, §4, §7.6) ────────────────────
-- Самообслуживание (preflight/blocked, экраны §5.2, §6.1) в этот PR не входит (не названо во
-- «Входит» плана PR-10 и не встречается ни в одном другом PR `45-plan.md`) — таблица и статусная
-- модель заведены, использует их пока только прямая смена тарифа оператором (`server/services/
-- platformTenants.ts` changeTenantPlan, §7.10 «может назначить любой план»): статус сразу
-- `applied`, blockers пустой массив. Самообслуживание владельца — следующий PR, отдельно от
-- этого (см. `docs/v2/46-progress.md`).
CREATE TABLE "plan_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_plan_code" text,
	"to_plan_code" text NOT NULL,
	"billing_period" text NOT NULL,
	"status" text DEFAULT 'preflight' NOT NULL,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_at" date,
	"requested_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	CONSTRAINT "plan_change_requests_billing_period_check" CHECK ("billing_period" IN ('month', 'year')),
	CONSTRAINT "plan_change_requests_status_check" CHECK ("status" IN ('preflight', 'blocked', 'scheduled', 'applied', 'cancelled'))
);--> statement-breakpoint
ALTER TABLE "plan_change_requests" ADD CONSTRAINT "plan_change_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_change_requests" ADD CONSTRAINT "plan_change_requests_from_plan_code_plans_code_fk" FOREIGN KEY ("from_plan_code") REFERENCES "public"."plans"("code") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "plan_change_requests" ADD CONSTRAINT "plan_change_requests_to_plan_code_plans_code_fk" FOREIGN KEY ("to_plan_code") REFERENCES "public"."plans"("code") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "plan_change_requests_tenant_id_status_index" ON "plan_change_requests" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE plan_change_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE plan_change_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON plan_change_requests
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 3. tenant_addons.payment_id → tenant_payments(id) — отложенный FK из PR-08 ───────────
-- `set null`, не cascade: удаления строк `tenant_payments` не бывает (§7.10 «не может удалить
-- строку tenant_payments»), но на случай ручной правки данных доплата не должна утянуть за
-- собой удаление — только потерять ссылку на платёж.
ALTER TABLE "tenant_addons" ADD CONSTRAINT "tenant_addons_payment_id_tenant_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."tenant_payments"("id") ON DELETE set null ON UPDATE no action;
