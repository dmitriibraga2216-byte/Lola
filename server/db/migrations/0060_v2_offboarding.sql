-- docs/v2/45-plan.md PR-07 · docs/v2/33-lifecycle.md §3.5, §3.6 · docs/v2/40-data-model-delta.md 0021
-- Состояние человека в жизненном цикле и процесс увольнения.
--
-- Номер 0060, а не 0059: 0059 занята параллельной веткой PR-08 (docs/v2/45-plan.md §5 —
-- точный номер назначается при rebase). Обе таблицы тенантные: RLS, политика, FK на tenants
-- с on delete cascade и непартиальный индекс с tenant_id первым — контрактные тесты 1–3 PR-01.

CREATE TABLE "employee_lifecycle_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"entered_by" uuid,
	"reason_code" text,
	"is_current" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_lifecycle_state" ADD CONSTRAINT "employee_lifecycle_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_lifecycle_state" ADD CONSTRAINT "employee_lifecycle_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_lifecycle_state" ADD CONSTRAINT "employee_lifecycle_state_stage_id_lifecycle_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."lifecycle_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_lifecycle_state" ADD CONSTRAINT "employee_lifecycle_state_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_lifecycle_state_tenant_id_user_id_entered_at_index" ON "employee_lifecycle_state" USING btree ("tenant_id","user_id","entered_at" DESC);--> statement-breakpoint
-- «Текущий этап ровно один» — инвариант §3.5, критерий §13 п. 7. Частичный уникальный индекс,
-- а не проверка в коде: две параллельные записи состояния иначе разъедутся молча.
CREATE UNIQUE INDEX "uq_employee_lifecycle_current" ON "employee_lifecycle_state" USING btree ("tenant_id","user_id") WHERE "is_current";--> statement-breakpoint
ALTER TABLE "employee_lifecycle_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employee_lifecycle_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON employee_lifecycle_state
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE "offboarding_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state" text DEFAULT 'started' NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"last_working_day" date NOT NULL,
	"initiated_by" uuid,
	-- «Відповідальний» формы §6.2 и колонка списка §5.4: инициатор (HR) и ответственный
	-- (керівник точки) — разные люди, DDL §3.6 колонку не называет. Решение — docs/28 §28.13.
	"responsible_id" uuid,
	"exit_interview_enrollment_id" uuid,
	"handover_done_at" timestamp with time zone,
	"access_revoked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	-- Отмена (§4.2, §10 `POST /offboarding/:id/cancel {reason_text}`): причина отмены — не
	-- причина увольнения, класть её в reason_text нельзя. Имена как у enrollments.
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "offboarding_cases_state_check" CHECK ("state" IN ('started', 'handover', 'interview', 'done', 'cancelled')),
	CONSTRAINT "offboarding_cases_reason_check" CHECK ("reason_code" IN ('own_wish', 'probation_failed', 'performance', 'redundancy', 'no_show', 'end_of_contract', 'transfer_out', 'other'))
);
--> statement-breakpoint
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_responsible_id_users_id_fk" FOREIGN KEY ("responsible_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offboarding_cases" ADD CONSTRAINT "offboarding_cases_exit_interview_enrollment_id_enrollments_id_fk" FOREIGN KEY ("exit_interview_enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offboarding_cases_tenant_id_state_index" ON "offboarding_cases" USING btree ("tenant_id","state");--> statement-breakpoint
-- Один активный случай на человека (§3.6): повторный запуск увольнения — 409 offboarding.active_exists.
CREATE UNIQUE INDEX "uq_offboarding_case_active" ON "offboarding_cases" USING btree ("tenant_id","user_id") WHERE "state" NOT IN ('done', 'cancelled');--> statement-breakpoint
ALTER TABLE "offboarding_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "offboarding_cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON offboarding_cases
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- Догоняющее состояние для уже работающих сотрудников (docs/v2/33 §4.1: `training` — рабочее
-- состояние по умолчанию). Без него счётчик людей в этапе на /admin/settings/lifecycle всегда
-- ноль, а правило §5.2 «этап с людьми не выключается» не срабатывает ни разу. Кандидаты
-- (kind = 'candidate') состояния не получают: `recruiting` ведёт рекрутинговый модуль (PR-13).
INSERT INTO employee_lifecycle_state (tenant_id, user_id, stage_id, entered_at, reason_code)
SELECT u.tenant_id, u.id, s.id, coalesce(u.hired_at::timestamptz, u.created_at), 'backfill'
FROM users u
JOIN lifecycle_stages s ON s.tenant_id = u.tenant_id AND s.code = 'training'
WHERE u.kind = 'employee' AND u.status IN ('invited', 'active') AND u.archived_at IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Скоупы офбординга (docs/v2/33 §2) для уже заведённых тенантов; новые получают их из SYSTEM_ROLES.
-- «Запустить офбординг» — керівник точки своей точки и адміністратор; «Завершить» — только адміністратор.
UPDATE roles SET scopes = array_cat(scopes, ARRAY['offboarding.start']) WHERE is_system AND code = 'manager' AND NOT scopes @> ARRAY['offboarding.start'];--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['offboarding.start', 'offboarding.complete']) WHERE is_system AND code = 'admin' AND NOT scopes @> ARRAY['offboarding.complete'];
