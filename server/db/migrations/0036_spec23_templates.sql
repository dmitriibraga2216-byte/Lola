-- Spec 23 (docs/23 §13.1, §13.4; docs/32 §Б.12): вёрстка письма (безопасное подмножество MJML,
-- без mjml-компилятора — docs/28 «Spec 23»), картинка шаблона и отдельная для Telegram.
ALTER TABLE "notification_template_versions" ADD COLUMN "body_mjml" text;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD COLUMN "body_mjml" text;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD COLUMN "image_key" text;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD COLUMN "telegram_image_key" text;