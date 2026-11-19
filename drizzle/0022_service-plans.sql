CREATE TABLE "service_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price" bigint DEFAULT 0 NOT NULL,
	"interval" text DEFAULT 'month' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_services" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_plans_service_idx" ON "service_plans" USING btree ("service_id");--> statement-breakpoint
ALTER TABLE "client_services" ADD CONSTRAINT "client_services_plan_id_service_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."service_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The "Products" client field the Pipedrive import made is replaced by services and their plans.
-- Archived, not deleted: the values stay on the records, and Settings → Fields can restore it.
UPDATE "custom_fields" SET "archived_at" = now() WHERE "entity_type" = 'client' AND "key" = 'pd_products' AND "archived_at" IS NULL;
