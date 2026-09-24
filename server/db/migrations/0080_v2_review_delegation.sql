-- docs/v2/45-plan.md PR-19 · docs/v2/37-review-delegation.md §3.2–3.4, §4, §7.1–7.9, §7.16–7.19 ·
-- решения docs/v2/44-decisions.md В-2 (очередь — источник истины) и В-13 (два отложенных FK).
--
-- Делегирование, маршрутизация, ёмкость и отсутствия проверяющих, события SLA и суточная
-- статистика — шесть таблиц `37` §3.2–3.4 поверх `review_queue_items` (0066, PR-18).
--
-- Порядок внутри файла — `40` §5 «0022_review_queue.sql»: правила → делегирования → два
-- ключа-развязки из очереди (цикл `review_queue_items ↔ review_delegations`), затем
-- операционные таблицы «0023_review_ops.sql», которые ссылаются на очередь.
--
-- Отличия от DDL `37` — каждое с причиной, все внесены в сам `37` пометкой «исправлено»
-- и в `docs/v2/46-progress.md` (Р-19.1 … Р-19.6):
--   * у очереди пять состояний, а не три (`37` §4: `delegated`, `escalated`);
--   * захват карточки отделён от назначения (`claimed_by`, `claimed_at`) — с маршрутизацией
--     и делегированием «кто отвечает» и «у кого открыта карточка» перестали совпадать;
--   * уникальность активного делегирования — на звено цепочки (`depth`), а не на элемент:
--     при A→B→C оба звена в силе, иначе возврат C→B по сроку (`37` §7.5) некуда вернуть;
--   * `review_sla_events.details` — «пометка перегрузки» из `37` §7.17 требует места;
--   * `request_context` у двух журналов — правило 14 сильнее DDL документа (как у
--     `usage_events`, `candidate_status_history`, `content_issue_events`);
--   * полный tenant-first индекс правил рядом с частичным (`40` §7.2).

-- ── 1. review_queue_items: состояния delegated / escalated и захват карточки ─────────────────
-- Порядок значений — как в `REVIEW_QUEUE_STATUSES` (shared/enums.ts): его сверяет тест.
ALTER TABLE "review_queue_items" DROP CONSTRAINT "rqi_status_chk";--> statement-breakpoint
ALTER TABLE "review_queue_items" ADD CONSTRAINT "rqi_status_chk" CHECK ("status" IN ('waiting', 'in_review', 'delegated', 'escalated', 'done'));--> statement-breakpoint
-- Захват (кто открыл карточку и когда) — отдельно от назначения (кто отвечает). До PR-19 это
-- была одна пара `assigned_reviewer_id`/`assigned_at`: назначения не существовало, захват и
-- был назначением. С правилами и делегированием работа назначена B, а открыть её может
-- эскалированный руководитель; «Пропустити» не должно снимать назначение, а SLA считается
-- от назначения, а не от последнего открытия карточки (`37` §7.19). Зеркало
-- `workshop_submissions.reviewer_id`/`claimed_at` (В-2) теперь имеет в очереди прямой аналог.
ALTER TABLE "review_queue_items" ADD COLUMN "claimed_by" uuid;--> statement-breakpoint
ALTER TABLE "review_queue_items" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_queue_items" ADD CONSTRAINT "review_queue_items_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Перенос смысла: у открытых строк PR-18 `assigned_reviewer_id` означал захват из общего пула.
-- Захват переезжает в свои колонки, работа возвращается в пул — ровно то состояние, в которое
-- её вернул бы «Пропустити». У закрытых строк `assigned_reviewer_id` — тот, кто решил, и
-- остаётся (на нём держится статистика проверяющего).
UPDATE "review_queue_items"
   SET "claimed_by" = "assigned_reviewer_id", "claimed_at" = "assigned_at",
       "assigned_reviewer_id" = NULL, "assigned_at" = NULL
 WHERE "status" = 'in_review';--> statement-breakpoint
CREATE INDEX "idx_review_queue_items_claimed" ON "review_queue_items" USING btree ("tenant_id","claimed_by") WHERE claimed_by is not null and status <> 'done';--> statement-breakpoint
CREATE INDEX "idx_review_queue_items_escalated" ON "review_queue_items" USING btree ("tenant_id","escalated_to_id") WHERE escalated_to_id is not null and status <> 'done';--> statement-breakpoint

-- ── 2. review_routing_rules — правила распределения (`37` §3.3, §7.16–7.17) ─────────────────
CREATE TABLE "review_routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name_uk" text NOT NULL,
	-- Меньше — раньше: выигрывает первое подошедшее правило (`37` §3.3).
	"priority" integer DEFAULT 100 NOT NULL,
	-- {"location_ids":[…],"org_node_ids":[…],"position_ids":[…],"course_ids":[…]}; {} — весь тенант.
	"match_scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"match_subject_kind" text,
	"match_task_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"strategy" text DEFAULT 'round_robin' NOT NULL,
	"reviewer_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"fallback_user_id" uuid,
	"sla_hours_override" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	CONSTRAINT "rrr_strategy_chk" CHECK ("strategy" IN ('location_mentor', 'course_author', 'specific_list', 'round_robin', 'least_loaded', 'manual')),
	CONSTRAINT "rrr_sla_chk" CHECK ("sla_hours_override" IS NULL OR "sla_hours_override" BETWEEN 1 AND 720),
	CONSTRAINT "rrr_subject_chk" CHECK ("match_subject_kind" IS NULL OR "match_subject_kind" IN ('employee', 'candidate')),
	CONSTRAINT "rrr_task_types_chk" CHECK ("match_task_types" <@ ARRAY['quiz_open_answer', 'workshop', 'offline_confirm', 'survey_open', 'ai_interview_review']::text[]),
	CONSTRAINT "rrr_name_chk" CHECK (length("name_uk") BETWEEN 1 AND 200)
);--> statement-breakpoint
ALTER TABLE "review_routing_rules" ADD CONSTRAINT "review_routing_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_routing_rules" ADD CONSTRAINT "review_routing_rules_fallback_user_id_users_id_fk" FOREIGN KEY ("fallback_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_routing_rules" ADD CONSTRAINT "review_routing_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Горячий путь (распределение читает только включённые) — частичный индекс `37` §3.3;
-- экран правил показывает и выключенные — полный индекс рядом (`40` §7.2, контрактный тест 2).
CREATE INDEX "idx_review_routing_rules_tenant" ON "review_routing_rules" USING btree ("tenant_id","priority") WHERE is_active;--> statement-breakpoint
CREATE INDEX "idx_review_routing_rules_tenant_all" ON "review_routing_rules" USING btree ("tenant_id","priority");--> statement-breakpoint

-- ── 3. review_delegations — журнал передач (`37` §3.2, §7.1–7.6, §9.4) ──────────────────────
CREATE TABLE "review_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"queue_item_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	-- Срок делегата, не срок проверки: ≤ `review_queue_items.sla_due_at` (`37` §6.1).
	"due_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"accepted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"request_context" jsonb,
	CONSTRAINT "rd_reason_chk" CHECK ("reason_code" IN ('absence', 'workload', 'expertise', 'conflict_of_interest', 'location_change', 'other')),
	CONSTRAINT "rd_state_chk" CHECK ("state" IN ('active', 'resolved', 'revoked_by_author', 'revoked_by_manager', 'revoked_sla', 'cancelled')),
	CONSTRAINT "rd_self_chk" CHECK ("from_user_id" <> "to_user_id"),
	CONSTRAINT "rd_depth_chk" CHECK ("depth" BETWEEN 1 AND 2),
	CONSTRAINT "rd_text_chk" CHECK ("reason_code" <> 'other' OR length(coalesce("reason_text", '')) BETWEEN 10 AND 500),
	CONSTRAINT "rd_revoke_reason_chk" CHECK ("revoke_reason" IS NULL OR length("revoke_reason") <= 500)
);--> statement-breakpoint
ALTER TABLE "review_delegations" ADD CONSTRAINT "review_delegations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_delegations" ADD CONSTRAINT "review_delegations_queue_item_id_review_queue_items_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."review_queue_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_delegations" ADD CONSTRAINT "review_delegations_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_delegations" ADD CONSTRAINT "review_delegations_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_delegations" ADD CONSTRAINT "review_delegations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_review_delegations_tenant" ON "review_delegations" USING btree ("tenant_id","from_user_id","state");--> statement-breakpoint
CREATE INDEX "idx_review_delegations_to" ON "review_delegations" USING btree ("tenant_id","to_user_id","state");--> statement-breakpoint
CREATE INDEX "idx_review_delegations_item" ON "review_delegations" USING btree ("tenant_id","queue_item_id","created_at" DESC);--> statement-breakpoint
-- Одно активное звено на уровень цепочки. `37` §3.2 ставил уникальность на элемент целиком,
-- но при A→B→C звено A→B обязано оставаться в силе: истечение B→C возвращает работу B
-- с глубиной 1 (`37` §7.5), и звену A→B продолжает идти свой срок. Двух одновременных
-- передач с одного уровня (A→B и A→D) индекс по-прежнему не допускает.
CREATE UNIQUE INDEX "uq_review_delegations_active" ON "review_delegations" USING btree ("tenant_id","queue_item_id","depth") WHERE state = 'active';--> statement-breakpoint

-- ── 4. Развязка цикла: два отложенных ключа очереди (В-13, имена зафиксированы заранее) ──────
-- Ни одного cascade: удаление правила маршрутизации не уносит работу из очереди.
ALTER TABLE "review_queue_items" ADD CONSTRAINT "rqi_delegation_id_fk" FOREIGN KEY ("delegation_id") REFERENCES "public"."review_delegations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_queue_items" ADD CONSTRAINT "rqi_assigned_by_rule_id_fk" FOREIGN KEY ("assigned_by_rule_id") REFERENCES "public"."review_routing_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ── 5. reviewer_capacity — ёмкость проверяющего (`37` §3.4, §7.17, Г-37.8) ─────────────────
CREATE TABLE "reviewer_capacity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"max_open_items" integer DEFAULT 20 NOT NULL,
	"daily_target" integer DEFAULT 10 NOT NULL,
	"accepts_delegation" boolean DEFAULT true NOT NULL,
	-- Пусто — любые виды работ.
	"task_types" text[] DEFAULT '{}'::text[] NOT NULL,
	-- Счётчик кругового распределения: сколько работ человек получил по кругу (`37` §7.17).
	"rr_cursor" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rc_max_chk" CHECK ("max_open_items" BETWEEN 1 AND 200),
	CONSTRAINT "rc_daily_chk" CHECK ("daily_target" BETWEEN 1 AND 200),
	CONSTRAINT "rc_task_types_chk" CHECK ("task_types" <@ ARRAY['quiz_open_answer', 'workshop', 'offline_confirm', 'survey_open', 'ai_interview_review']::text[]),
	CONSTRAINT "reviewer_capacity_tenant_id_user_id_unique" UNIQUE("tenant_id","user_id")
);--> statement-breakpoint
ALTER TABLE "reviewer_capacity" ADD CONSTRAINT "reviewer_capacity_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_capacity" ADD CONSTRAINT "reviewer_capacity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reviewer_capacity_tenant" ON "reviewer_capacity" USING btree ("tenant_id","user_id");--> statement-breakpoint

-- ── 6. reviewer_absences — отсутствия и замещение (`37` §3.4, §6.2, §7.18) ──────────────────
CREATE TABLE "reviewer_absences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"substitute_id" uuid,
	"move_open_items" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	CONSTRAINT "ra_kind_chk" CHECK ("kind" IN ('vacation', 'sick', 'training', 'dismissal', 'other')),
	CONSTRAINT "ra_range_chk" CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on"),
	CONSTRAINT "ra_dismissal_chk" CHECK ("kind" <> 'dismissal' OR "ends_on" IS NULL),
	CONSTRAINT "ra_sub_chk" CHECK ("substitute_id" IS NULL OR "substitute_id" <> "user_id")
);--> statement-breakpoint
ALTER TABLE "reviewer_absences" ADD CONSTRAINT "reviewer_absences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_absences" ADD CONSTRAINT "reviewer_absences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_absences" ADD CONSTRAINT "reviewer_absences_substitute_id_users_id_fk" FOREIGN KEY ("substitute_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_absences" ADD CONSTRAINT "reviewer_absences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reviewer_absences_tenant" ON "reviewer_absences" USING btree ("tenant_id","user_id","starts_on");--> statement-breakpoint

-- ── 7. review_sla_events — журнал событий SLA (`37` §3.4, §7.17, §7.19) ─────────────────────
CREATE TABLE "review_sla_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"queue_item_id" uuid NOT NULL,
	"reviewer_id" uuid,
	"event" text NOT NULL,
	-- Срок проверки на момент события — снимок `review_queue_items.sla_due_at`.
	"due_at" timestamp with time zone,
	"overdue_hours" numeric(8, 2),
	"target_id" uuid,
	-- «assigned с пометкой перегрузки» (`37` §7.17), стратегия и правило назначения.
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_context" jsonb,
	CONSTRAINT "rse_event_chk" CHECK ("event" IN ('assigned', 'warned', 'breached', 'escalated', 'reassigned', 'resolved', 'delegation_expired'))
);--> statement-breakpoint
ALTER TABLE "review_sla_events" ADD CONSTRAINT "review_sla_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_sla_events" ADD CONSTRAINT "review_sla_events_queue_item_id_review_queue_items_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."review_queue_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_sla_events" ADD CONSTRAINT "review_sla_events_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_sla_events" ADD CONSTRAINT "review_sla_events_target_id_users_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_review_sla_events_tenant" ON "review_sla_events" USING btree ("tenant_id","queue_item_id","created_at" DESC);--> statement-breakpoint

-- ── 8. reviewer_stats_daily — суточная статистика (`37` §3.4, §9.2, задача review.stats_rollup) ─
CREATE TABLE "reviewer_stats_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"day" date NOT NULL,
	"reviewed_count" integer DEFAULT 0 NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"rework_count" integer DEFAULT 0 NOT NULL,
	"delegated_out" integer DEFAULT 0 NOT NULL,
	"delegated_in" integer DEFAULT 0 NOT NULL,
	"breached_count" integer DEFAULT 0 NOT NULL,
	"own_content_count" integer DEFAULT 0 NOT NULL,
	"median_react_sec" integer,
	"median_review_sec" integer,
	CONSTRAINT "reviewer_stats_daily_tenant_id_reviewer_id_day_unique" UNIQUE("tenant_id","reviewer_id","day")
);--> statement-breakpoint
ALTER TABLE "reviewer_stats_daily" ADD CONSTRAINT "reviewer_stats_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewer_stats_daily" ADD CONSTRAINT "reviewer_stats_daily_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_reviewer_stats_daily_tenant" ON "reviewer_stats_daily" USING btree ("tenant_id","day" DESC);--> statement-breakpoint

-- ── 9. RLS: шесть тенантных таблиц (CLAUDE.md п. 1, контрактный тест v2-contract-01) ───────
ALTER TABLE review_routing_rules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review_routing_rules FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON review_routing_rules
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE review_delegations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review_delegations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON review_delegations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE reviewer_capacity ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE reviewer_capacity FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON reviewer_capacity
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE reviewer_absences ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE reviewer_absences FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON reviewer_absences
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE review_sla_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review_sla_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON review_sla_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE reviewer_stats_daily ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE reviewer_stats_daily FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON reviewer_stats_daily
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 10. Скоупы модуля уже заведённым тенантам (`37` §2) ──────────────────────────────────
-- Новые тенанты получают их из SYSTEM_ROLES (`shared/domain/roles.ts`), здесь — догоняющая
-- выдача тем же составом. Наставник делегирует свою работу и отмечает своё отсутствие;
-- керівник точки сверх того отзывает и переназначает чужое, правит правила и видит нагрузку.
-- `time.metrics.view` уже выдан миграцией 0078 (PR-21) и здесь не трогается. Добавляется
-- только недостающее — повторная выдача не плодит дублей в массиве скоупов.
UPDATE roles SET scopes = scopes || ARRAY(
		SELECT s FROM unnest(ARRAY['review.delegate', 'review.absence.manage']::text[]) AS s WHERE s <> ALL (scopes))
	WHERE is_system AND code = 'mentor' AND NOT scopes @> ARRAY['review.delegate', 'review.absence.manage'];--> statement-breakpoint
UPDATE roles SET scopes = scopes || ARRAY(
		SELECT s FROM unnest(ARRAY['review.delegate', 'review.delegate.any', 'review.routing.manage', 'review.workload.view', 'review.absence.manage']::text[]) AS s WHERE s <> ALL (scopes))
	WHERE is_system AND code IN ('manager', 'admin')
	  AND NOT scopes @> ARRAY['review.delegate', 'review.delegate.any', 'review.routing.manage', 'review.workload.view', 'review.absence.manage'];
