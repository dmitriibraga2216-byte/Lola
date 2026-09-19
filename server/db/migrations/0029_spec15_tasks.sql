CREATE TABLE "assignment_competencies" (
	"tenant_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"competency_id" uuid NOT NULL,
	CONSTRAINT "assignment_competencies_assignment_id_competency_id_pk" PRIMARY KEY("assignment_id","competency_id")
);
--> statement-breakpoint
CREATE TABLE "task_parameter_values" (
	"tenant_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"parameter_id" uuid NOT NULL,
	"value" jsonb,
	CONSTRAINT "task_parameter_values_task_id_parameter_id_pk" PRIMARY KEY("task_id","parameter_id")
);
--> statement-breakpoint
CREATE TABLE "task_parameters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	CONSTRAINT "task_parameters_tenant_id_name_unique" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "via_catalog" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "automation_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "use_in_dev_plans" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "on_leave_condition" text DEFAULT 'keep' NOT NULL;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "content_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "content_change_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "on_leave_condition" text DEFAULT 'keep' NOT NULL;--> statement-breakpoint
ALTER TABLE "assignment_competencies" ADD CONSTRAINT "assignment_competencies_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_competencies" ADD CONSTRAINT "assignment_competencies_competency_id_competencies_id_fk" FOREIGN KEY ("competency_id") REFERENCES "public"."competencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_parameter_values" ADD CONSTRAINT "task_parameter_values_task_id_assignments_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_parameter_values" ADD CONSTRAINT "task_parameter_values_parameter_id_task_parameters_id_fk" FOREIGN KEY ("parameter_id") REFERENCES "public"."task_parameters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assignment_competencies_tenant_id_index" ON "assignment_competencies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "task_parameter_values_tenant_id_index" ON "task_parameter_values" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "task_parameters_tenant_id_index" ON "task_parameters" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_automation_rule_id_automation_rules_id_fk" FOREIGN KEY ("automation_rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Таблицы тенанта — RLS обязателен (CLAUDE.md п. 1)
ALTER TABLE assignment_competencies ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE assignment_competencies FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON assignment_competencies
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE task_parameters ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE task_parameters FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON task_parameters
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE task_parameter_values ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE task_parameter_values FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON task_parameter_values
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Значения, снятые с эталона и docs/15 Г-15.2 / docs/02: не выдумывать свои (CLAUDE.md п. 13)
ALTER TABLE "task_parameters" ADD CONSTRAINT "task_parameters_kind_check" CHECK ("kind" IN ('text', 'select', 'number'));--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_on_leave_condition_check" CHECK ("on_leave_condition" IN ('keep', 'cancel_unstarted', 'cancel_all'));--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_on_leave_condition_check" CHECK ("on_leave_condition" IN ('keep', 'cancel_unstarted', 'cancel_all'));--> statement-breakpoint
-- Напоминания по Г-15.1: ключи reminders jsonb приводятся к модели docs/15
--   beforeDays → beforeDueDays, onDueDay → onDueDate, afterDays → afterDueEveryDays (шаг) + afterDueMaxCount,
--   notifyManagerAfterDays → escalateToManagerAfterDays, channels[] → channel (null = канал человека)
UPDATE assignments SET reminders = (
  (reminders - 'beforeDays' - 'onDueDay' - 'afterDays' - 'notifyManagerAfterDays' - 'channels')
  || jsonb_build_object(
    'beforeDueDays', coalesce(reminders->'beforeDays', '[7, 3, 1]'::jsonb),
    'onDueDate', coalesce(reminders->'onDueDay', 'true'::jsonb),
    'afterDueEveryDays', coalesce((reminders->'afterDays'->>0)::int, 3),
    'afterDueMaxCount', 5,
    'escalateToManagerAfterDays', coalesce(reminders->'notifyManagerAfterDays', '7'::jsonb),
    'channel', coalesce(reminders->'channels'->0, 'null'::jsonb)
  )
) WHERE reminders ? 'beforeDays' OR reminders ? 'afterDays' OR reminders ? 'channels' OR reminders ? 'notifyManagerAfterDays' OR reminders ? 'onDueDay';
