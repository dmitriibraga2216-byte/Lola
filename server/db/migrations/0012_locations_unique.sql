-- Точки: дубликаты по имени (импорт без уникальности плодил их) сливаем в самую раннюю, затем уникальность
WITH d AS (
  SELECT id, first_value(id) OVER (PARTITION BY tenant_id, name ORDER BY created_at, id) AS keep FROM locations
)
UPDATE user_placements up SET location_id = d.keep FROM d WHERE up.location_id = d.id AND d.id <> d.keep;
--> statement-breakpoint
WITH d AS (
  SELECT id, first_value(id) OVER (PARTITION BY tenant_id, name ORDER BY created_at, id) AS keep FROM locations
)
UPDATE checklist_runs r SET location_id = d.keep FROM d WHERE r.location_id = d.id AND d.id <> d.keep;
--> statement-breakpoint
DELETE FROM locations l USING (
  SELECT id, first_value(id) OVER (PARTITION BY tenant_id, name ORDER BY created_at, id) AS keep FROM locations
) d WHERE l.id = d.id AND d.id <> d.keep;
--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenant_id_name_unique" UNIQUE("tenant_id","name");