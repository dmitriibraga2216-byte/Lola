ALTER TABLE "resources" ADD COLUMN "is_catalog_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "assign_mode" text DEFAULT 'catalog_free' NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_assign_mode_check" CHECK ("assign_mode" IN ('catalog_free', 'catalog_request'));