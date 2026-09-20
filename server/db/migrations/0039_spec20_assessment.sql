-- Spec 20 (docs/20 §14, docs/02 «Оценка и чек-листы», docs/32 Б.15): анкета оценки с типом, шкалой,
-- нормами и правилами комментирования; заморозка после первого заполнения; чек-лист с одной шкалой
-- и весами; опрос: конфиденциально/анонимно/свій варіант/по шкалі/з умовами. Долг Spec 24:
-- rating_scales → scales(kind=levels) с переносом ссылок.

-- 1. Шкалы анкет → общий справочник scales (docs/24 Г-24.4). Совпадение по имени — переиспользуем.
CREATE TEMP TABLE _rs_map AS
  SELECT rs.id AS old_id, rs.tenant_id, rs.name, rs.options, rs.pass_threshold,
         (SELECT s.id FROM scales s WHERE s.tenant_id = rs.tenant_id AND s.name = rs.name) AS existing_id
  FROM rating_scales rs;--> statement-breakpoint
INSERT INTO scales (tenant_id, name, kind, display_as)
  SELECT tenant_id, name, 'levels', 'label' FROM _rs_map WHERE existing_id IS NULL;--> statement-breakpoint
UPDATE _rs_map m SET existing_id = s.id FROM scales s WHERE m.existing_id IS NULL AND s.tenant_id = m.tenant_id AND s.name = m.name;--> statement-breakpoint
INSERT INTO scale_levels (tenant_id, scale_id, label, value, sort_order)
  SELECT m.tenant_id, m.existing_id, o->>'label', (o->>'value')::numeric, (ord - 1)::int
  FROM _rs_map m CROSS JOIN LATERAL jsonb_array_elements(m.options) WITH ORDINALITY AS x(o, ord)
  WHERE NOT EXISTS (SELECT 1 FROM scale_levels l WHERE l.scale_id = m.existing_id);--> statement-breakpoint

-- 2. Анкета оценки: тип, шкала, правила комментирования, заморозка, состав с нормой (docs/20 §14.2)
ALTER TABLE "assessment_forms" ADD COLUMN "instruction" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_forms" ADD COLUMN "kind" text DEFAULT 'by_criteria' NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_forms" ADD CONSTRAINT "assessment_forms_kind_assessment_kind" CHECK ("kind" IN ('by_criteria', 'by_competencies'));--> statement-breakpoint
ALTER TABLE "assessment_forms" ADD COLUMN "scale_id" uuid;--> statement-breakpoint
ALTER TABLE "assessment_forms" ADD COLUMN "allow_comment_groups" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_forms" ADD COLUMN "comment_groups_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_forms" ADD COLUMN "comment_when_above_norm" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_forms" ADD COLUMN "comment_when_below_norm" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_forms" ADD COLUMN "comment_when_equal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_forms" ADD COLUMN "zero_means_no_grade" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_forms" ADD COLUMN "is_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_forms" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_tasks" ADD COLUMN "group_comments" jsonb DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "criteria_groups" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE TABLE "assessment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"norm" numeric(6, 2) NOT NULL,
	"cluster" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "assessment_items_form_id_criterion_id_unique" UNIQUE("form_id","criterion_id")
);--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_form_id_assessment_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."assessment_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_items" ADD CONSTRAINT "assessment_items_criterion_id_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."criteria"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_items_tenant_id_form_id_index" ON "assessment_items" USING btree ("tenant_id","form_id");--> statement-breakpoint
ALTER TABLE assessment_items ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE assessment_items FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON assessment_items
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Состав анкеты из прежних group_ids: норма — прежний порог комментария критерия, иначе порог шкалы, иначе максимум шкалы
INSERT INTO assessment_items (tenant_id, form_id, criterion_id, norm, cluster, sort_order)
  SELECT f.tenant_id, f.id, c.id,
         coalesce(c.requires_comment_below, m.pass_threshold,
                  (SELECT max((o->>'value')::numeric) FROM jsonb_array_elements(m.options) o), 0),
         g.name, (row_number() OVER (PARTITION BY f.id ORDER BY g.sort, c.sort, c.created_at) - 1)::int
  FROM assessment_forms f
  JOIN criteria_groups g ON g.id = any(f.group_ids)
  JOIN criteria c ON c.group_id = g.id
  LEFT JOIN _rs_map m ON m.old_id = c.scale_id;--> statement-breakpoint
-- Шкала анкеты: самая частая шкала её критериев; без критериев — первая шкала уровней тенанта
UPDATE assessment_forms f SET scale_id = (
  SELECT m.existing_id FROM criteria c JOIN _rs_map m ON m.old_id = c.scale_id
  WHERE c.group_id = any(f.group_ids) GROUP BY m.existing_id ORDER BY count(*) DESC LIMIT 1);--> statement-breakpoint
UPDATE assessment_forms f SET scale_id = (SELECT s.id FROM scales s WHERE s.tenant_id = f.tenant_id AND s.kind = 'levels' ORDER BY s.created_at LIMIT 1) WHERE scale_id IS NULL;--> statement-breakpoint
DELETE FROM assessment_forms WHERE scale_id IS NULL;--> statement-breakpoint
ALTER TABLE "assessment_forms" ALTER COLUMN "scale_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assessment_forms" ADD CONSTRAINT "assessment_forms_scale_id_scales_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."scales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Заморозка: анкеты, по которым уже есть ответы (docs/20 §14.4)
UPDATE assessment_forms f SET is_locked = true WHERE EXISTS (
  SELECT 1 FROM assessment_cycles cy JOIN assessment_tasks t ON t.cycle_id = cy.id JOIN assessment_answers a ON a.task_id = t.id WHERE cy.form_id = f.id);--> statement-breakpoint
ALTER TABLE "assessment_forms" DROP COLUMN "group_ids";--> statement-breakpoint

-- 3. Чек-лист: одна шкала, параметры карточки, заморозка (docs/20 §14.3)
ALTER TABLE "checklists" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "checklists" ADD COLUMN "instruction" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "checklists" ADD COLUMN "scale_id" uuid;--> statement-breakpoint
ALTER TABLE "checklists" ADD COLUMN "allow_skip" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checklists" ADD COLUMN "allow_item_comment" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "checklists" ADD COLUMN "item_comment_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checklists" ADD COLUMN "is_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checklists" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE checklists c SET scale_id = (
  SELECT m.existing_id FROM jsonb_array_elements(c.items) i JOIN _rs_map m ON m.old_id = (i->>'scaleId')::uuid
  GROUP BY m.existing_id ORDER BY count(*) DESC LIMIT 1);--> statement-breakpoint
UPDATE checklists c SET scale_id = (SELECT s.id FROM scales s WHERE s.tenant_id = c.tenant_id AND s.kind = 'levels' ORDER BY s.created_at LIMIT 1) WHERE scale_id IS NULL;--> statement-breakpoint
DELETE FROM checklists WHERE scale_id IS NULL;--> statement-breakpoint
ALTER TABLE "checklists" ALTER COLUMN "scale_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "checklists" ADD CONSTRAINT "checklists_scale_id_scales_id_fk" FOREIGN KEY ("scale_id") REFERENCES "public"."scales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE checklists SET items = (SELECT coalesce(jsonb_agg(i - 'scaleId'), '[]'::jsonb) FROM jsonb_array_elements(items) i);--> statement-breakpoint
UPDATE checklists c SET is_locked = true WHERE EXISTS (SELECT 1 FROM checklist_runs r WHERE r.checklist_id = c.id);--> statement-breakpoint

-- 4. Критерий — только название и описание (docs/20 §14.6): шкала и порог комментария ушли в анкету
ALTER TABLE "criteria" DROP CONSTRAINT "criteria_scale_id_rating_scales_id_fk";--> statement-breakpoint
ALTER TABLE "criteria" DROP COLUMN "scale_id";--> statement-breakpoint
ALTER TABLE "criteria" DROP COLUMN "requires_comment_below";--> statement-breakpoint
DROP TABLE "rating_scales" CASCADE;--> statement-breakpoint
DROP TABLE _rs_map;--> statement-breakpoint

-- 5. Опрос (docs/20 §14.5, §14.7): режим, конфиденциальность, четыре типа вопроса, анонимность на уровне данных
ALTER TABLE "surveys" ADD COLUMN "mode" text DEFAULT 'linear' NOT NULL;--> statement-breakpoint
ALTER TABLE "surveys" ADD CONSTRAINT "surveys_mode_poll_mode" CHECK ("mode" IN ('linear', 'conditional'));--> statement-breakpoint
ALTER TABLE "surveys" ADD COLUMN "is_confidential" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "surveys" ADD COLUMN "show_results" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "surveys" ADD COLUMN "is_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "surveys" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- Прежние типы choice|text|yesno → single|free|single(Так/Ні); варианты — объекты {id, text}
UPDATE surveys SET questions = (
  SELECT coalesce(jsonb_agg(
    CASE
      WHEN q->>'type' = 'yesno' THEN (q - 'type') || jsonb_build_object('type', 'single', 'options', jsonb_build_array(jsonb_build_object('id', 'yes', 'text', 'Так'), jsonb_build_object('id', 'no', 'text', 'Ні')))
      WHEN q->>'type' = 'choice' THEN (q - 'type' - 'options') || jsonb_build_object('type', 'single', 'options',
        coalesce((SELECT jsonb_agg(jsonb_build_object('id', 'o' || ord, 'text', o)) FROM jsonb_array_elements_text(coalesce(q->'options', '[]'::jsonb)) WITH ORDINALITY AS x(o, ord)), '[]'::jsonb))
      WHEN q->>'type' = 'text' THEN (q - 'type') || '{"type":"free"}'::jsonb
      ELSE q
    END ORDER BY ord), '[]'::jsonb)
  FROM jsonb_array_elements(questions) WITH ORDINALITY AS y(q, ord));--> statement-breakpoint
-- Ответы в новом виде: single → {optionId} (текст варианта → id), scale → {value}, free → {text}
UPDATE survey_responses r SET answers = (
  SELECT coalesce(jsonb_object_agg(k, CASE
    WHEN jsonb_typeof(v) = 'object' THEN v
    WHEN q.q->>'type' = 'single' THEN jsonb_build_object('optionId', coalesce((SELECT o->>'id' FROM jsonb_array_elements(q.q->'options') o WHERE o->>'text' = (v #>> '{}') OR o->>'id' = (v #>> '{}') LIMIT 1), v #>> '{}'))
    WHEN q.q->>'type' = 'scale' AND jsonb_typeof(v) = 'number' THEN jsonb_build_object('value', v)
    WHEN q.q->>'type' = 'free' THEN jsonb_build_object('text', v #>> '{}')
    ELSE v END), '{}'::jsonb)
  FROM jsonb_each(r.answers) AS a(k, v)
  LEFT JOIN LATERAL (SELECT q FROM surveys s, jsonb_array_elements(s.questions) q WHERE s.id = r.survey_id AND q->>'id' = a.k LIMIT 1) q ON true);--> statement-breakpoint
ALTER TABLE "survey_responses" ADD COLUMN "path" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE TABLE "survey_participations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"survey_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"draft" jsonb DEFAULT '{}' NOT NULL,
	"enrollment_id" uuid,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "survey_participations_tenant_id_survey_id_user_id_unique" UNIQUE("tenant_id","survey_id","user_id")
);--> statement-breakpoint
ALTER TABLE "survey_participations" ADD CONSTRAINT "survey_participations_survey_id_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_participations" ADD CONSTRAINT "survey_participations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "survey_participations_tenant_id_user_id_index" ON "survey_participations" USING btree ("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE survey_participations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE survey_participations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON survey_participations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Участие именных ответов — из самих ответов; анонимные хеши стираются: связь с человеком не хранится
INSERT INTO survey_participations (tenant_id, survey_id, user_id, status, submitted_at)
  SELECT tenant_id, survey_id, user_id, 'submitted', submitted_at FROM survey_responses WHERE user_id IS NOT NULL
  ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "survey_responses" DROP CONSTRAINT "survey_responses_tenant_id_survey_id_respondent_hash_unique";--> statement-breakpoint
ALTER TABLE "survey_responses" DROP COLUMN "respondent_hash";--> statement-breakpoint
CREATE INDEX "survey_responses_tenant_id_survey_id_index" ON "survey_responses" USING btree ("tenant_id","survey_id");--> statement-breakpoint
UPDATE surveys s SET is_locked = true WHERE EXISTS (SELECT 1 FROM survey_responses r WHERE r.survey_id = s.id);
