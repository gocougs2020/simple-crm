ALTER TABLE "clients" ADD COLUMN "stripe_discount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "stripe_collected" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "stripe_owed" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "stripe_credit" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_customers" ADD COLUMN "collected_month" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_customers" ADD COLUMN "collected_year" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_customers" ADD COLUMN "last_paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stripe_customers" ADD COLUMN "owed" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_customers" ADD COLUMN "overdue" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stripe_subscriptions" ADD COLUMN "net" bigint DEFAULT 0 NOT NULL;