ALTER TABLE "user_placements" ADD COLUMN "manager_id" uuid;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "icon_key" text;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "workload" text;--> statement-breakpoint
ALTER TABLE "user_placements" ADD CONSTRAINT "user_placements_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;