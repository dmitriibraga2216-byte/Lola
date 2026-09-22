ALTER TABLE "development_goals" ALTER COLUMN "due_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "development_goals" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "development_goals" ADD COLUMN "is_strategic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "development_goals" ADD CONSTRAINT "development_goals_parent_id_development_goals_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."development_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "development_goals_tenant_id_is_strategic_parent_id_index" ON "development_goals" USING btree ("tenant_id","is_strategic","parent_id");