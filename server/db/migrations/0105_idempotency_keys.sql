-- cross-cutting-tails · docs/04 §4.1 `Idempotency-Key` (хранение 24 часа) · решение docs/v2/44 §18 Р-CC.3.
--
-- Написана руками: снимок drizzle не пересобирается начиная с `0056` (см. `0098`).
--
-- Ответ на повтор мутации с тем же ключом нужно отдать тот же, что и в первый раз, — значит его
-- надо где-то хранить, и хранить общо для всех процессов приложения: словарь в памяти не
-- переживает рестарт и второй экземпляр (как с OAuth state, docs/09 §9.2). Отсюда таблица.
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_tenant_user_key_unique" UNIQUE("tenant_id","user_id","key"),
	CONSTRAINT "idempotency_keys_key_chk" CHECK (char_length("key") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE INDEX "idx_idempotency_keys_tenant_expires" ON "idempotency_keys" USING btree ("tenant_id","expires_at");--> statement-breakpoint
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
