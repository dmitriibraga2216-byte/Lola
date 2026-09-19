ALTER TABLE "automation_rules" ALTER COLUMN "actions" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD COLUMN "assign_delay_days" integer DEFAULT 0 NOT NULL;