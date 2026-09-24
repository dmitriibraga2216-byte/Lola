-- docs/v2/45-plan.md PR-30 · docs/v2/32-org-structure.md §3 · docs/v2/44-decisions.md В-7
-- · docs/v2/43-reconciliation.md §1.2 (org_structure_conflicts = org_conflicts).
--
-- Дерево подчинения: кто кому подчиняется. Три сущности, которые нельзя смешивать (`32` §3.1):
-- подразделение (`org_units`) отвечает на «к какому куску компании относится», должность
-- (`positions`) — «как называется работа», узел (`org_nodes`) — «кто кому подчинён». Первые две
-- уже есть и не трогаются; новое — только дерево и всё вокруг него.
--
-- Почему `ltree`, а не materialized path обычным `text`: расширение уже включено нулевой
-- миграцией (`0000_youthful_warhawk.sql:1`) и уже несёт `org_units.path`, в образе
-- `pgvector/pgvector:pg16` оно есть (`select * from pg_available_extensions where name='ltree'`
-- → installed_version 1.2). Обходной путь не понадобился.
--
-- Запрет циклов и самоподчинения стоит **в БД** (триггер `org_nodes_guard`), а не только в
-- сервисе: `manager_self` и `manager_cycle` уже перечислены среди видов конфликта, то есть
-- система их переживает и пишет строку, — но в само дерево они попасть не должны ни прямым
-- UPDATE, ни импортом, ни гонкой двух администраторов.

-- ── 1. Узел дерева (`32` §3.2, §3.4) ────────────────────────────────────────────────────
-- `type` хранится, а не вычисляется (`32` §3.2 [решение]): узел-посада со счётчиком «N з M»
-- и именной узел — разные карточки, и конвертация между ними — явное действие оператора.
CREATE TABLE "org_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"path" "ltree" NOT NULL,
	"depth" integer DEFAULT 1 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"type" text DEFAULT 'position' NOT NULL,
	"title" text NOT NULL,
	"external_key" text,
	"note" text,
	"position_id" uuid,
	"org_unit_id" uuid,
	"location_id" uuid,
	"holder_user_id" uuid,
	"headcount_planned" integer DEFAULT 1 NOT NULL,
	"is_manager_point" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'vacant' NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	CONSTRAINT "org_nodes_tenant_id_path_unique" UNIQUE("tenant_id","path"),
	CONSTRAINT "org_nodes_tenant_id_external_key_unique" UNIQUE("tenant_id","external_key"),
	CONSTRAINT "org_nodes_type_chk" CHECK ("type" IN ('position', 'employee')),
	CONSTRAINT "org_nodes_state_chk" CHECK ("state" IN ('vacant', 'occupied', 'archived')),
	CONSTRAINT "org_nodes_size_chk" CHECK ("depth" BETWEEN 1 AND 12 AND "headcount_planned" BETWEEN 1 AND 999),
	CONSTRAINT "org_nodes_named_chk" CHECK ("type" = 'employee' OR "holder_user_id" IS NULL),
	CONSTRAINT "org_nodes_one_chk" CHECK ("type" = 'position' OR "headcount_planned" = 1),
	CONSTRAINT "org_nodes_title_chk" CHECK (length("title") BETWEEN 2 AND 120 AND "title" !~ '[<>]'),
	CONSTRAINT "org_nodes_not_self_parent_chk" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);
--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_parent_id_org_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."org_nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_org_unit_id_org_units_id_fk" FOREIGN KEY ("org_unit_id") REFERENCES "public"."org_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_holder_user_id_users_id_fk" FOREIGN KEY ("holder_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_nodes_tenant" ON "org_nodes" USING btree ("tenant_id","path");--> statement-breakpoint
CREATE INDEX "idx_org_nodes_parent" ON "org_nodes" USING btree ("tenant_id","parent_id","sort");--> statement-breakpoint
CREATE INDEX "idx_org_nodes_path" ON "org_nodes" USING gist ("path");--> statement-breakpoint
CREATE INDEX "idx_org_nodes_holder" ON "org_nodes" USING btree ("tenant_id","holder_user_id") WHERE "holder_user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE org_nodes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE org_nodes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON org_nodes
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- Целостность дерева на уровне БД (`32` §7 п. 1–2, критерий приёмки 3).
-- Проверяются четыре вещи, каждая из которых молча ломает `resolveManager()`:
--   1. `depth` = `nlevel(path)` — глубина производная, а не второе независимое поле;
--   2. у корня путь ровно из одной метки;
--   3. родитель существует и виден в том же тенанте;
--   4. **путь ребёнка = путь родителя плюс собственная метка**, ровно на уровень глубже.
--
-- Четвёртая проверка и есть запрет циклов. Если у каждого узла путь строго длиннее
-- родительского и начинается с него, то `parent → child` — строгий порядок по длине пути,
-- а в строгом порядке петель не бывает: подчинить предка его же потомку невозможно, потому
-- что обоим пришлось бы одновременно быть длиннее другого. Отдельная проверка «новый родитель
-- не лежит в моём поддереве» остаётся в сервисе — но только затем, чтобы вернуть человеку
-- понятное `409 cycle_detected` вместо ошибки транзакции.
--
-- Триггер **отложенный** (`DEFERRABLE INITIALLY DEFERRED`), а не `BEFORE`: перемещение ветки
-- пересчитывает пути узла и всех его потомков одним `update`, порядок строк внутри оператора
-- не определён, и немедленная проверка увидела бы потомка, у которого родитель ещё не
-- переписан, — то есть краснела бы на корректном перемещении. Отложенная смотрит на
-- состояние дерева в момент коммита, когда пересчёт уже целиком закончен.
CREATE FUNCTION org_nodes_guard() RETURNS trigger AS $$
DECLARE
  parent_path ltree;
  parent_tenant uuid;
BEGIN
  IF nlevel(NEW.path) <> NEW.depth THEN
    RAISE EXCEPTION 'org_node_depth_mismatch' USING ERRCODE = '23514';
  END IF;
  -- Дети тоже обязаны лежать под новым путём. Без этой проверки петлю можно было бы
  -- собрать, переписав ОДНУ строку: сделать предка потомком его же ребёнка, не трогая
  -- строку ребёнка, — тогда сам ребёнок на проверку не попадает, а `parent_id` уже кольцо.
  IF EXISTS (
    SELECT 1 FROM org_nodes c
    WHERE c.parent_id = NEW.id
      AND (NOT (NEW.path @> c.path) OR nlevel(c.path) <> nlevel(NEW.path) + 1)
  ) THEN
    RAISE EXCEPTION 'org_node_cycle' USING ERRCODE = '23514';
  END IF;
  IF NEW.parent_id IS NULL THEN
    IF nlevel(NEW.path) <> 1 THEN
      RAISE EXCEPTION 'org_node_root_path' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  SELECT path, tenant_id INTO parent_path, parent_tenant FROM org_nodes WHERE id = NEW.parent_id;
  IF parent_path IS NULL THEN
    RAISE EXCEPTION 'org_node_parent_missing' USING ERRCODE = '23503';
  END IF;
  IF parent_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'org_node_parent_foreign_tenant' USING ERRCODE = '23514';
  END IF;
  IF NOT (parent_path @> NEW.path) OR nlevel(NEW.path) <> nlevel(parent_path) + 1 THEN
    RAISE EXCEPTION 'org_node_cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER org_nodes_guard_trg AFTER INSERT OR UPDATE ON org_nodes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION org_nodes_guard();--> statement-breakpoint

-- ── 2. Кто занимает узел (`32` §3.3) ────────────────────────────────────────────────────
-- Источник истины по держателям: у узла-посады их несколько, `org_nodes.holder_user_id` —
-- только кэш именного узла. История не удаляется: отчёт за прошлый квартал показывает
-- подчинение того времени.
CREATE TABLE "org_node_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"placement_id" uuid,
	"is_primary" boolean DEFAULT true NOT NULL,
	"role_in_node" text DEFAULT 'holder' NOT NULL,
	"started_at" date DEFAULT current_date NOT NULL,
	"ended_at" date,
	"ended_reason" text,
	"created_by" uuid,
	CONSTRAINT "org_node_assignments_role_chk" CHECK ("role_in_node" IN ('holder', 'acting', 'deputy')),
	CONSTRAINT "org_node_assignments_reason_chk" CHECK ("ended_reason" IS NULL OR "ended_reason" IN ('moved', 'dismissed', 'node_archived', 'manual')),
	CONSTRAINT "org_node_assignments_period_chk" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at"),
	CONSTRAINT "org_node_assignments_closed_chk" CHECK ("ended_at" IS NOT NULL OR "ended_reason" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "org_node_assignments" ADD CONSTRAINT "org_node_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_node_assignments" ADD CONSTRAINT "org_node_assignments_node_id_org_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."org_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_node_assignments" ADD CONSTRAINT "org_node_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_node_assignments" ADD CONSTRAINT "org_node_assignments_placement_id_user_placements_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."user_placements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_node_assignments" ADD CONSTRAINT "org_node_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_node_assignments_tenant" ON "org_node_assignments" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_org_node_assignments_node" ON "org_node_assignments" USING btree ("tenant_id","node_id") WHERE "ended_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_org_node_assignments_active" ON "org_node_assignments" USING btree ("tenant_id","node_id","user_id") WHERE "ended_at" IS NULL;--> statement-breakpoint
-- Ровно одно активное основное подчинение на человека (`32` §7 п. 4): на нём держится
-- шаг 1 `resolveManager()`. Совместительство — те же строки без `is_primary`.
CREATE UNIQUE INDEX "uq_org_node_assignments_primary" ON "org_node_assignments" USING btree ("tenant_id","user_id") WHERE "ended_at" IS NULL AND "is_primary";--> statement-breakpoint
ALTER TABLE org_node_assignments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE org_node_assignments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON org_node_assignments
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 3. Проекция «человек → руководитель» (`32` §3.3, §7.8) ──────────────────────────────
-- Материализованный результат `resolveManager()`. Таблица — **не** второй источник истины:
-- её пишет только `rebuildManagerMap()`, а читают обратные вопросы («кто мои подчинённые»)
-- и отчёт «Підпорядкування людей». Прямой вопрос «кто руководитель X» идёт через функцию.
-- `org_manager_map_self_chk` запрещает самоподчинение на уровне БД даже в проекции.
CREATE TABLE "org_manager_map" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"manager_user_id" uuid,
	"source" text DEFAULT 'none' NOT NULL,
	"node_id" uuid,
	"chain" uuid[] DEFAULT '{}' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_manager_map_pkey" PRIMARY KEY ("tenant_id","user_id"),
	CONSTRAINT "org_manager_map_source_chk" CHECK ("source" IN ('org_tree', 'location', 'functional', 'role_scope', 'none')),
	CONSTRAINT "org_manager_map_self_chk" CHECK ("manager_user_id" IS NULL OR "manager_user_id" <> "user_id"),
	CONSTRAINT "org_manager_map_chain_chk" CHECK (array_length("chain", 1) IS NULL OR array_length("chain", 1) <= 12)
);
--> statement-breakpoint
ALTER TABLE "org_manager_map" ADD CONSTRAINT "org_manager_map_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_manager_map" ADD CONSTRAINT "org_manager_map_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_manager_map" ADD CONSTRAINT "org_manager_map_manager_user_id_users_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_manager_map" ADD CONSTRAINT "org_manager_map_node_id_org_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."org_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_manager_map_manager" ON "org_manager_map" USING btree ("tenant_id","manager_user_id");--> statement-breakpoint
ALTER TABLE org_manager_map ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE org_manager_map FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON org_manager_map
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 4. Снимки дерева (`32` §3.3) ────────────────────────────────────────────────────────
-- Таблица заводится здесь, чтобы снимок можно было сделать с первого дня существования
-- дерева; **импорт, откат и сравнение снимков — PR-31** (`45-plan.md`), в этом PR их нет.
CREATE TABLE "org_structure_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"kind" text DEFAULT 'manual' NOT NULL,
	"tree" jsonb NOT NULL,
	"node_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	CONSTRAINT "org_structure_snapshots_kind_chk" CHECK ("kind" IN ('manual', 'auto_daily', 'pre_import', 'pre_bulk_move'))
);
--> statement-breakpoint
ALTER TABLE "org_structure_snapshots" ADD CONSTRAINT "org_structure_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_structure_snapshots" ADD CONSTRAINT "org_structure_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_structure_snapshots_tenant" ON "org_structure_snapshots" USING btree ("tenant_id","created_at" DESC);--> statement-breakpoint
ALTER TABLE org_structure_snapshots ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE org_structure_snapshots FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON org_structure_snapshots
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ── 5. `alter org_conflicts` вместо новой таблицы (решение В-7) ─────────────────────────
-- `docs/v2/32` §3.3 вводил `org_structure_conflicts`, но таблица уже существует под именем
-- `org_conflicts` (миграция 0033, перечень расширен в 0038) и уже наполняется импортом людей.
-- Заводить вторую значило бы показывать один конфликт в отчёте двумя строками.
--
-- Из четырёх колонок пакета добавляются две:
--   `severity` — по образцу существующего `security_severity` (`info | warning | critical`);
--   `node_id`  — появляется вместе с `org_nodes`, раньше её некуда было ссылать.
-- `detected_at` не добавляется: это `created_at` из `baseColumns`, второе имя того же момента.
-- `status` не добавляется: состояние уже выражено парой `resolved_at` / `resolved_by`.
--
-- Перечень `kind` — **один список из десяти**: пять существующих сохранены без изменений
-- (они уже лежат в данных, уже переведены и уже проверяются `schema-parity.spec.ts`), пять
-- пакетных добавлены. Три имени пакета отброшены как переименования существующих:
--   `self_manager`  → `manager_self`   (то же самое, другое написание);
--   `multi_primary` → `double_unit`    (писатель `importPeople.ts` ставит `double_unit`
--                                       именно на «второе активное размещение»);
--   `orphan_user`   → `unit_missing`   (человек без узла = узла нет — одно с разных сторон).
ALTER TABLE "org_conflicts" ADD COLUMN "severity" text DEFAULT 'warning' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_conflicts" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "org_conflicts" ADD CONSTRAINT "org_conflicts_node_id_org_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."org_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_conflicts" ADD CONSTRAINT "org_conflicts_severity_check" CHECK ("severity" IN ('info', 'warning', 'critical'));--> statement-breakpoint
ALTER TABLE "org_conflicts" DROP CONSTRAINT "org_conflicts_kind_check";--> statement-breakpoint
ALTER TABLE "org_conflicts" ADD CONSTRAINT "org_conflicts_kind_check" CHECK ("kind" IN ('double_unit', 'placement_replaced', 'manager_self', 'manager_cycle', 'unit_missing', 'no_manager', 'manager_mismatch', 'depth_exceeded', 'dismissed_holder', 'position_mismatch'));--> statement-breakpoint
-- Экран «Конфлікти структури» (`32` §9) фильтрует по важности и по открытости.
CREATE INDEX "idx_org_conflicts_open" ON "org_conflicts" USING btree ("tenant_id","severity","created_at" DESC) WHERE "resolved_at" IS NULL;
