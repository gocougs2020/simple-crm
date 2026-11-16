ALTER TABLE "clients" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "summary_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "summary_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "summary_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "summary_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "summary_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "summary_started_at" timestamp with time zone;