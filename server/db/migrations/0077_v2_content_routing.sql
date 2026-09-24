-- docs/v2/45-plan.md PR-24 · docs/v2/36-content-feedback.md §3.2 (DDL), §4 (переходы), §7.5
-- (маршрутизация), §7.8 (пересчёт), §7.9 (закрытие) · docs/v2/39-patches.md П-12.4 (второй
-- вход в «Перерахувати»).
--
-- Разбор жалобы. Журнал карточки (`content_issue_events`) уже создан PR-23 миграцией
-- `0069_v2_content_issues`: событие `merged` рождается при подаче. Здесь — то, без чего
-- разбор не работает: кому карточка уходит, у кого есть права её разбирать и куда пишется
-- пересчитанный результат.

-- ── 1. Правила адресации (`36` §3.2, §6.3, §7.5 а/г) ────────────────────────────────────
-- Фильтр по типу элемента, типу проблемы и категории курса → человек или роль. Пустой
-- фильтр значит «Будь-який». Выигрывает правило с наименьшим `sort`; запасное правило
-- (`fallback`) в первом шаге не участвует — оно шаг (г), после авторов и владельца
-- категории. Запасное правило одно на тенант: частичный уникальный индекс держит «не больше
-- одного», сервис — «не меньше одного, если правила вообще есть» (§6.3, 400
-- `content_issue.fallback_rule_required`).
CREATE TABLE "content_issue_routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sort" integer DEFAULT 100 NOT NULL,
	"target_type" text,
	"issue_type" text,
	"category_id" uuid,
	"assignee_user_id" uuid,
	"assignee_role_id" uuid,
	"fallback" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "content_issue_routing_rules_assignee_chk" CHECK ("assignee_user_id" IS NOT NULL OR "assignee_role_id" IS NOT NULL),
	CONSTRAINT "content_issue_routing_rules_sort_chk" CHECK ("sort" BETWEEN 0 AND 10000),
	CONSTRAINT "content_issue_routing_rules_target_type_chk" CHECK ("target_type" IS NULL OR "target_type" IN ('resource', 'lesson', 'block', 'quiz', 'question', 'workshop', 'survey', 'knowledge_article', 'media')),
	CONSTRAINT "content_issue_routing_rules_issue_type_chk" CHECK ("issue_type" IS NULL OR "issue_type" IN ('typo', 'wrong_fact', 'outdated', 'unclear', 'broken_media', 'broken_link', 'broken_file', 'bad_question', 'wrong_key', 'tech', 'other'))
);
--> statement-breakpoint
ALTER TABLE "content_issue_routing_rules" ADD CONSTRAINT "content_issue_routing_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_issue_routing_rules" ADD CONSTRAINT "content_issue_routing_rules_category_id_course_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."course_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_issue_routing_rules" ADD CONSTRAINT "content_issue_routing_rules_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_issue_routing_rules" ADD CONSTRAINT "content_issue_routing_rules_assignee_role_id_roles_id_fk" FOREIGN KEY ("assignee_role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_content_issue_routing_rules_tenant" ON "content_issue_routing_rules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_content_issue_routing_rules_order" ON "content_issue_routing_rules" USING btree ("tenant_id","is_active","sort");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_content_issue_routing_rules_fallback" ON "content_issue_routing_rules" USING btree ("tenant_id") WHERE fallback;--> statement-breakpoint
ALTER TABLE content_issue_routing_rules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE content_issue_routing_rules FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON content_issue_routing_rules
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 2. Владелец категории курса (`36` §7.5 в, критерий приёмки 8) ───────────────────────
-- Маршрутизация называет «владельца категории курса» шагом (в): ему уходит жалоба, когда
-- все авторы материала неактивны. В модели данных такого поля не было — ни в `36` §3.2,
-- ни в `40`, ни в базовом `course_categories` (`docs/24` §3.7.1: свободный справочник).
-- Без колонки критерий 8 невыполним, поэтому `[решение]` она заводится здесь, необязательной:
-- категория без владельца просто пропускает шаг (в). Удаление человека не удаляет категорию.
ALTER TABLE "course_categories" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "course_categories" ADD CONSTRAINT "course_categories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
COMMENT ON COLUMN "course_categories"."owner_id" IS 'Владелец категории — адресат жалобы, когда все авторы материала неактивны (docs/v2/36 §7.5 в).';--> statement-breakpoint

-- ── 3. Пересчитанный результат ссылается на карточку (`36` §7.8, П-12.4) ─────────────────
-- «Снапшот попытки не переписывается никогда: создаётся новая запись результата со ссылкой
-- issue_id и причиной». Запись — та же `attempt_results` с `reason = 'recalculate'`, что пишет
-- «Перерахувати» отчёта по тесту: логика пересчёта одна, точек входа две. Ссылка на карточку
-- различает вход и делает повторный пересчёт по той же карточке идемпотентным.
ALTER TABLE "attempt_results" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "attempt_results" ADD CONSTRAINT "attempt_results_issue_id_content_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."content_issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_attempt_results_issue" ON "attempt_results" USING btree ("tenant_id","issue_id") WHERE issue_id IS NOT NULL;--> statement-breakpoint

-- ── 4. Скоупы разбора системным ролям (`36` §2) ──────────────────────────────────────────
-- PR-23 выдал всем `content_issue.report`, методисту — `content_issue.view`, администратору —
-- весь набор. Разбор добавляет: методисту — `triage` (брать в работу, менять статус,
-- отклонять), керівнику точки — `view` (очередь и отчёт качества по своим точкам).
-- Переназначение, пересчёт и mute остаются только у администратора: автор правит вопрос,
-- но менять уже выставленные людям результаты может только администратор (§2).
UPDATE roles SET scopes = array_cat(scopes, ARRAY['content_issue.triage'])
	WHERE is_system AND code = 'author' AND NOT scopes @> ARRAY['content_issue.triage'];--> statement-breakpoint
UPDATE roles SET scopes = array_cat(scopes, ARRAY['content_issue.view'])
	WHERE is_system AND code = 'manager' AND NOT scopes @> ARRAY['content_issue.view'];
