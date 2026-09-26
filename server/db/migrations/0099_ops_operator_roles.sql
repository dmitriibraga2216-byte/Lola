-- ops-console-1 · docs/25 §7 п. 6–8 · решение владельца продукта 26.09.2026: отдельная консоль
-- операторов, операторов несколько, у каждого роль, второй фактор обязателен.
--
-- Написана руками: снимок drizzle не пересобирается начиная с `0056` (см. `0098`).
--
-- 1. Роль оператора — перечисление `platform_role` (docs/02 «Перечисления»). Действующие операторы
--    (их единицы: владелец и первый оператор из PLATFORM_ADMIN_EMAIL) получают `owner`, новые —
--    наименьшие права `viewer`, пока роль не задана явно при приглашении.
ALTER TABLE "platform_admins" ADD COLUMN "role" text NOT NULL DEFAULT 'owner';--> statement-breakpoint
ALTER TABLE "platform_admins" ALTER COLUMN "role" SET DEFAULT 'viewer';--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_role_check" CHECK ("role" IN ('owner', 'admin', 'billing', 'support', 'viewer'));--> statement-breakpoint
-- 2. Приглашение: пароль ещё не задан, оператор задаёт его по одноразовой ссылке (хеш токена, срок).
ALTER TABLE "platform_admins" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD COLUMN "invited_by" uuid REFERENCES "platform_admins"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD COLUMN "invite_token_hash" text UNIQUE;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD COLUMN "invite_expires_at" timestamptz;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD COLUMN "deactivated_at" timestamptz;--> statement-breakpoint
-- 3. Второй фактор оператора — тот же механизм, что у пользователей тенанта (`user_totp`, PR-39):
--    секрет только шифротекстом (`crypto.ts`, AES-256-GCM), новый секрет ждёт первого кода,
--    `last_used_step` не даёт повторить принятый код. Отдельные колонки, а не `user_totp`: оператор
--    вне тенантов, а `user_totp` — тенантная таблица под RLS.
ALTER TABLE "platform_admins" ADD COLUMN "totp_secret_encrypted" bytea;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD COLUMN "totp_secret_nonce" bytea;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD COLUMN "totp_confirmed_at" timestamptz;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD COLUMN "totp_last_used_step" bigint;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD COLUMN "totp_pending_encrypted" bytea;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD COLUMN "totp_pending_nonce" bytea;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD COLUMN "totp_pending_created_at" timestamptz;--> statement-breakpoint
-- Сессия после пароля, но до второго фактора: открыт только экран 2FA и выход.
ALTER TABLE "platform_sessions" ADD COLUMN "two_factor_pending" boolean NOT NULL DEFAULT false;--> statement-breakpoint
-- Резервные коды оператора — только хешами argon2id, как `user_totp_recovery_codes`. Платформенная
-- таблица без tenant_id и без RLS; приложение (app_user) её не видит.
CREATE TABLE "platform_admin_recovery_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "admin_id" uuid NOT NULL REFERENCES "platform_admins"("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "platform_admin_recovery_codes_admin_idx" ON "platform_admin_recovery_codes" ("admin_id");--> statement-breakpoint
REVOKE ALL ON "platform_admin_recovery_codes" FROM app_user;
