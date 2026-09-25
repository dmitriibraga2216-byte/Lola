-- fix-resource-node · docs/11 Г-11.5 («Пройдено» для файла и ссылки), docs/17 §14.3 (блок
-- «Завдання» ссылается на любой назначаемый тип) · docs/28 «fix-resource-node».
--
-- Снимок drizzle не пересобирается начиная с `0056`: миграция написана руками и меняет только
-- `_journal.json`.
--
-- Прохождение ресурса **как задания** — вне курса: узел траектории, элемент программы, прямое
-- назначение. До этой миграции у такого ресурса не было ни записи прохождения, ни места для
-- фактов Г-11.5 (докуда дочитал, сколько секунд, «Я ознайомився», скачал ли), поэтому зачесть
-- его по правилу было нечем: узел траектории с материалом так и стоял «доступен». Факты —
-- те же, что у `lesson_progress`, ключ другой: человек × ресурс × назначение (у элемента
-- программы назначения нет — `assignment_id` пуст, `nulls not distinct`). Правил прохождения
-- здесь нет (CLAUDE.md п. 11): правило зачёта — свойство типа материала (`lessonRules.ts`).

CREATE TABLE "resource_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"assignment_id" uuid,
	"resource_version_id" uuid,
	"status" text DEFAULT 'opened' NOT NULL,
	"seconds_spent" integer DEFAULT 0 NOT NULL,
	"blocks_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"video_pct" integer DEFAULT 0 NOT NULL,
	"scroll_pct" integer DEFAULT 0 NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"downloaded_at" timestamp with time zone,
	"last_tick_at" timestamp with time zone,
	"first_opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"device" text,
	CONSTRAINT "resource_progress_status_chk" CHECK ("status" IN ('opened', 'completed')),
	CONSTRAINT "resource_progress_facts_chk" CHECK ("seconds_spent" >= 0 AND "video_pct" BETWEEN 0 AND 100 AND "scroll_pct" BETWEEN 0 AND 100),
	CONSTRAINT "resource_progress_device_chk" CHECK ("device" IS NULL OR "device" IN ('mobile', 'desktop')),
	CONSTRAINT "resource_progress_completed_chk" CHECK (("status" = 'completed') = ("completed_at" IS NOT NULL)),
	-- Одна запись на «человек × ресурс × назначение»; без назначения (элемент программы) — одна на пару
	CONSTRAINT "uq_resource_progress_key" UNIQUE NULLS NOT DISTINCT ("tenant_id", "user_id", "resource_id", "assignment_id")
);
--> statement-breakpoint
ALTER TABLE "resource_progress" ADD CONSTRAINT "resource_progress_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_progress" ADD CONSTRAINT "resource_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_progress" ADD CONSTRAINT "resource_progress_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Снятое назначение уносит и прохождение по нему: иначе пустой assignment_id столкнулся бы
-- с записью «без назначения» по тому же ключу
ALTER TABLE "resource_progress" ADD CONSTRAINT "resource_progress_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_progress" ADD CONSTRAINT "resource_progress_resource_version_id_resource_versions_id_fk" FOREIGN KEY ("resource_version_id") REFERENCES "public"."resource_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Полный индекс с tenant_id первым: отчёт по материалу и каскад при удалении ресурса
CREATE INDEX "idx_resource_progress_resource" ON "resource_progress" USING btree ("tenant_id", "resource_id", "status");--> statement-breakpoint
CREATE INDEX "idx_resource_progress_assignment" ON "resource_progress" USING btree ("tenant_id", "assignment_id") WHERE "assignment_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE resource_progress ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE resource_progress FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON resource_progress
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
COMMENT ON TABLE "resource_progress" IS 'Прохождение ресурса как задания вне курса (docs/11 Г-11.5): факты клиента (время тиками, прокрутка, видео, «Я ознайомився», скачивание), решение о зачёте — сервер (server/services/resourcePass.ts). Пишет только этот модуль.';--> statement-breakpoint
COMMENT ON COLUMN "resource_progress"."assignment_id" IS 'Назначение, по которому человек проходит ресурс (узел траектории, прямое назначение); пусто — элемент программы. Закреплённую версию берёт из assignments.subject_version_id.';--> statement-breakpoint
COMMENT ON COLUMN "resource_progress"."resource_version_id" IS 'Снимок, который человек видел при открытии: по нему считается время чтения (объём текста) и число страниц документа.';
