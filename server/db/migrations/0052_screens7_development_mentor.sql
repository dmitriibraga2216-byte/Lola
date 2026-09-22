-- screens-7: наставник плану розвитку (docs/19 §3.4, мокап DevelopmentPlanMobile) —
-- за аналогією з mentor_id цілі (docs/19 §3.5), тільки на рівні всього плану.
ALTER TABLE "development_plans" ADD COLUMN "mentor_id" uuid;--> statement-breakpoint
ALTER TABLE "development_plans" ADD CONSTRAINT "development_plans_mentor_id_users_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
