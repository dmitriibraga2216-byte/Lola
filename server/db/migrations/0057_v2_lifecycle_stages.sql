-- docs/v2/45-plan.md PR-05 · docs/v2/33-lifecycle.md §3.2, §3.4 · docs/v2/40-data-model-delta.md 0005
-- Справочник этапов жизненного цикла и привязка курса к этапу.
-- Восемь этапов НОВОГО тенанта сеются не здесь, а в server/db/tenantDefaults.ts
-- (ensureTenantDefaults): на чистой БД тенантов ещё нет, и вставка из миграции была бы пустой.
-- Для уже заведённых тенантов те же восемь строк вставляет догоняющий INSERT в конце файла.
CREATE TABLE "lifecycle_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_uk" text NOT NULL,
	"name_en" text,
	"icon" text,
	"color" text DEFAULT 'ink' NOT NULL,
	"sort" integer NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"expected_days" integer,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	-- Зеркало ключа capabilities.applies_to_candidate (docs/v2/33 §3.3, §7.9): генерируемая
	-- колонка, а не вторая копия правды — флаг и карта возможностей не могут разъехаться.
	"applies_to_candidate" boolean GENERATED ALWAYS AS (coalesce(("capabilities" ->> 'applies_to_candidate')::boolean, false)) STORED NOT NULL,
	CONSTRAINT "lifecycle_stages_tenant_id_code_unique" UNIQUE("tenant_id","code"),
	-- Код неизменяем и закрыт констрейнтом: восемь платформенных значений (docs/v2/33 §3.2,
	-- docs/v2/44 В-3). Девятый этап тенант не заводит — иначе отчётность перестаёт
	-- сравниваться между тенантами (docs/v2/33 §12.8, В-10).
	CONSTRAINT "lifecycle_stages_code_check" CHECK ("code" IN ('recruiting', 'onboarding', 'integration', 'training', 'attestation', 'psychological', 'knowledge', 'offboarding')),
	CONSTRAINT "lifecycle_stages_color_check" CHECK ("color" IN ('ink', 'sun', 'teal', 'coral')),
	-- capabilities — фиксированный перечень ключей (docs/v2/44 В-3), а не свободный jsonb:
	-- после удаления всех известных ключей должен остаться пустой объект. Неизвестный ключ
	-- отвергается и на входе (zod, 422 validation_failed), и здесь — на случай записи мимо API.
	CONSTRAINT "lifecycle_stages_capabilities_keys_check" CHECK (
		"capabilities" - ARRAY['progress', 'deadline', 'grading', 'attempts', 'review', 'certificate', 'graph', 'ai_generate', 'applies_to_candidate', 'applies_to_employee', 'counts_in_rating']::text[] = '{}'::jsonb
	)
);
--> statement-breakpoint
ALTER TABLE "lifecycle_stages" ADD CONSTRAINT "lifecycle_stages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lifecycle_stages_tenant_id_sort_index" ON "lifecycle_stages" USING btree ("tenant_id","sort");--> statement-breakpoint
-- Таблица тенанта — RLS обязателен (CLAUDE.md п. 1, контрактный тест v2-contract-01)
ALTER TABLE lifecycle_stages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE lifecycle_stages FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON lifecycle_stages
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- docs/v2/33 §3.4: этап курса — необязательная ссылка; stage_locked запрещает смену этапа
-- у курса, по которому уже есть завершённые прохождения (правило §7.4).
ALTER TABLE "courses" ADD COLUMN "lifecycle_stage_id" uuid;--> statement-breakpoint
ALTER TABLE "courses" ADD COLUMN "stage_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_lifecycle_stage_id_lifecycle_stages_id_fk" FOREIGN KEY ("lifecycle_stage_id") REFERENCES "public"."lifecycle_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "courses_tenant_id_lifecycle_stage_id_index" ON "courses" USING btree ("tenant_id","lifecycle_stage_id");--> statement-breakpoint

-- Восемь этапов для УЖЕ заведённых тенантов (docs/v2/33 §3.3, критерий §13 п. 12). Новые тенанты
-- получают их из ensureTenantDefaults; здесь — только догоняющая вставка для существующих, ровно
-- теми же значениями. Идемпотентно: on conflict (tenant_id, code) do nothing.
INSERT INTO lifecycle_stages (tenant_id, code, name_uk, name_en, sort, expected_days, capabilities)
SELECT t.id, s.code, s.name_uk, s.name_en, s.sort, s.expected_days, s.capabilities
FROM tenants t
CROSS JOIN (VALUES
	('recruiting',    'Рекрутинг',                'Recruiting',               0, NULL::int, '{"progress":true,"deadline":true,"grading":true,"attempts":true,"review":true,"certificate":false,"graph":true,"ai_generate":true,"applies_to_candidate":true,"applies_to_employee":false,"counts_in_rating":false}'::jsonb),
	('onboarding',    'Онбординг',                'Onboarding',               1, 14,        '{"progress":true,"deadline":true,"grading":true,"attempts":true,"review":true,"certificate":true,"graph":true,"ai_generate":true,"applies_to_candidate":false,"applies_to_employee":true,"counts_in_rating":true}'::jsonb),
	('integration',   'Інтеграція',               'Integration',              2, 30,        '{"progress":true,"deadline":true,"grading":true,"attempts":true,"review":true,"certificate":false,"graph":true,"ai_generate":true,"applies_to_candidate":false,"applies_to_employee":true,"counts_in_rating":true}'::jsonb),
	('training',      'Підвищення кваліфікації',  'Professional development', 3, NULL,      '{"progress":true,"deadline":true,"grading":true,"attempts":true,"review":true,"certificate":true,"graph":true,"ai_generate":true,"applies_to_candidate":false,"applies_to_employee":true,"counts_in_rating":true}'::jsonb),
	('attestation',   'Атестація',                'Attestation',              4, 7,         '{"progress":true,"deadline":true,"grading":true,"attempts":true,"review":true,"certificate":true,"graph":true,"ai_generate":false,"applies_to_candidate":false,"applies_to_employee":true,"counts_in_rating":true}'::jsonb),
	('psychological', 'Психологічні тести',       'Psychological tests',      5, NULL,      '{"progress":true,"deadline":true,"grading":false,"attempts":false,"review":false,"certificate":false,"graph":false,"ai_generate":false,"applies_to_candidate":true,"applies_to_employee":true,"counts_in_rating":false}'::jsonb),
	('knowledge',     'База знань',               'Knowledge base',           6, NULL,      '{"progress":false,"deadline":false,"grading":false,"attempts":false,"review":false,"certificate":false,"graph":false,"ai_generate":true,"applies_to_candidate":false,"applies_to_employee":true,"counts_in_rating":false}'::jsonb),
	('offboarding',   'Офбординг',                'Offboarding',              7, 14,        '{"progress":true,"deadline":true,"grading":false,"attempts":false,"review":true,"certificate":false,"graph":true,"ai_generate":false,"applies_to_candidate":false,"applies_to_employee":true,"counts_in_rating":false}'::jsonb)
) AS s(code, name_uk, name_en, sort, expected_days, capabilities)
ON CONFLICT (tenant_id, code) DO NOTHING;--> statement-breakpoint

-- Скоупы этапов (docs/v2/33 §2) для уже заведённых тенантов: новые создаются из SYSTEM_ROLES.
-- lifecycle.view — видеть этап человека (наставник, керівник точки, методист, адміністратор);
-- lifecycle.manage — править перечень этапов тенанта (только адміністратор, «HR / Админ» §2).
UPDATE roles SET scopes = array_cat(scopes, ARRAY['lifecycle.view']) WHERE is_system AND code IN ('mentor', 'manager', 'author') AND NOT scopes @> ARRAY['lifecycle.view'];--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['lifecycle.view', 'lifecycle.manage']) WHERE is_system AND code = 'admin' AND NOT scopes @> ARRAY['lifecycle.manage'];
