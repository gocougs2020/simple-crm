-- Deals become clients: prospective, current or past. Renamed in place so every
-- record, activity, file and history entry keeps its id and links.
ALTER TABLE "deals" RENAME TO "clients";--> statement-breakpoint
ALTER TABLE "clients" RENAME COLUMN "title" TO "name";--> statement-breakpoint
ALTER TABLE "clients" RENAME COLUMN "lost_reason" TO "churn_reason";--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "category" text DEFAULT 'prospective' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "started_on" date;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "ended_on" date;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "open_to_return" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "health" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "category_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "deals_pkey" TO "clients_pkey";--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "deals_pipeline_id_pipelines_id_fk" TO "clients_pipeline_id_pipelines_id_fk";--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "deals_stage_id_stages_id_fk" TO "clients_stage_id_stages_id_fk";--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "deals_person_id_people_id_fk" TO "clients_person_id_people_id_fk";--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "deals_organization_id_organizations_id_fk" TO "clients_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "deals_owner_id_users_id_fk" TO "clients_owner_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "clients" RENAME CONSTRAINT "deals_created_by_users_id_fk" TO "clients_created_by_users_id_fk";--> statement-breakpoint
ALTER INDEX "deals_stage_idx" RENAME TO "clients_stage_idx";--> statement-breakpoint
ALTER INDEX "deals_person_idx" RENAME TO "clients_person_idx";--> statement-breakpoint
ALTER INDEX "deals_org_idx" RENAME TO "clients_org_idx";--> statement-breakpoint
ALTER INDEX "deals_owner_idx" RENAME TO "clients_owner_idx";--> statement-breakpoint
DROP INDEX "deals_pipeline_idx";--> statement-breakpoint
-- Each category gets its own pipelines. Existing pipelines held prospects.
ALTER TABLE "pipelines" ADD COLUMN "category" text DEFAULT 'prospective' NOT NULL;--> statement-breakpoint
-- Lost deals stay prospects, parked in a "Not now" stage at the end of their pipeline.
-- Their reason is already in their history ("lost" event); churn_reason is for clients who left.
INSERT INTO "stages" ("pipeline_id", "name", "position", "probability")
SELECT p."id", 'Not now', coalesce((SELECT max(s."position") + 1 FROM "stages" s WHERE s."pipeline_id" = p."id"), 0), 0
FROM "pipelines" p
WHERE EXISTS (SELECT 1 FROM "clients" c WHERE c."pipeline_id" = p."id" AND c."status" = 'lost');--> statement-breakpoint
UPDATE "clients" c SET "stage_id" = s."id", "churn_reason" = NULL, "stage_changed_at" = coalesce(c."closed_at", c."stage_changed_at"), "category_changed_at" = coalesce(c."closed_at", c."created_at")
FROM "stages" s
WHERE c."status" = 'lost' AND s."pipeline_id" = c."pipeline_id" AND s."name" = 'Not now';--> statement-breakpoint
-- Workspaces that already exist get a pipeline for current and past clients. New
-- workspaces get theirs at setup (seedDefaults).
WITH p AS (
  INSERT INTO "pipelines" ("name", "category", "position")
  SELECT 'Accounts', 'current', 0 WHERE EXISTS (SELECT 1 FROM "pipelines")
  RETURNING "id"
)
INSERT INTO "stages" ("pipeline_id", "name", "position", "probability", "rotting_days")
SELECT p."id", v."name", v."position", 0, v."rotting_days"
FROM p, (VALUES ('Onboarding', 0, 30), ('Active', 1, NULL), ('Renewal due', 2, 14), ('At risk', 3, 7)) AS v("name", "position", "rotting_days");--> statement-breakpoint
WITH p AS (
  INSERT INTO "pipelines" ("name", "category", "position")
  SELECT 'Former clients', 'past', 0 WHERE EXISTS (SELECT 1 FROM "pipelines")
  RETURNING "id"
)
INSERT INTO "stages" ("pipeline_id", "name", "position", "probability", "rotting_days")
SELECT p."id", v."name", v."position", 0, NULL
FROM p, (VALUES ('Recently left', 0), ('Win-back candidate', 1), ('In win-back campaign', 2), ('Do not contact', 3)) AS v("name", "position");--> statement-breakpoint
-- Won deals are current clients, in the Active stage, client since the day they closed.
UPDATE "clients" c SET
  "category" = 'current',
  "pipeline_id" = s."pipeline_id",
  "stage_id" = s."id",
  "started_on" = c."closed_at"::date,
  "stage_changed_at" = coalesce(c."closed_at", c."stage_changed_at"),
  "category_changed_at" = coalesce(c."closed_at", c."created_at"),
  "rank" = 'm'
FROM "stages" s JOIN "pipelines" p ON p."id" = s."pipeline_id"
WHERE c."status" = 'won' AND p."category" = 'current' AND p."name" = 'Accounts' AND s."name" = 'Active';--> statement-breakpoint
UPDATE "clients" SET "category_changed_at" = "created_at" WHERE "status" = 'open';--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "closed_at";--> statement-breakpoint
CREATE INDEX "clients_pipeline_idx" ON "clients" USING btree ("pipeline_id","category");--> statement-breakpoint
CREATE INDEX "clients_category_idx" ON "clients" USING btree ("category");--> statement-breakpoint
CREATE INDEX "clients_stripe_idx" ON "clients" USING btree ("stripe_customer_id");--> statement-breakpoint
-- Links from activities and files.
ALTER TABLE "activities" RENAME COLUMN "deal_id" TO "client_id";--> statement-breakpoint
ALTER TABLE "activities" RENAME CONSTRAINT "activities_deal_id_deals_id_fk" TO "activities_client_id_clients_id_fk";--> statement-breakpoint
ALTER INDEX "activities_deal_idx" RENAME TO "activities_client_idx";--> statement-breakpoint
ALTER TABLE "activities" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "inbox_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "files" RENAME COLUMN "deal_id" TO "client_id";--> statement-breakpoint
ALTER TABLE "files" RENAME CONSTRAINT "files_deal_id_deals_id_fk" TO "files_client_id_clients_id_fk";--> statement-breakpoint
ALTER INDEX "files_deal_idx" RENAME TO "files_client_idx";--> statement-breakpoint
UPDATE "events" SET "entity_type" = 'client' WHERE "entity_type" = 'deal';--> statement-breakpoint
UPDATE "custom_fields" SET "entity_type" = 'client' WHERE "entity_type" = 'deal';--> statement-breakpoint
UPDATE "users" SET "prefs" = ("prefs" - 'dealsView' - 'dealsSort' - 'pipelineId') || jsonb_strip_nulls(jsonb_build_object('clientsView', "prefs"->'dealsView', 'clientsSort', "prefs"->'dealsSort'));--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "email" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Services, subscriptions, performance, and the inbox mirror.
CREATE TABLE "client_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"label" text NOT NULL,
	"value" double precision NOT NULL,
	"period" date NOT NULL,
	"note" text,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"price" bigint DEFAULT 0 NOT NULL,
	"interval" text DEFAULT 'month' NOT NULL,
	"started_on" date,
	"ended_on" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price" bigint DEFAULT 0 NOT NULL,
	"interval" text DEFAULT 'month' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resend_thread_id" text NOT NULL,
	"resend_inbox_id" text NOT NULL,
	"inbox_address" text NOT NULL,
	"subject" text,
	"snippet" text,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"folder" text DEFAULT 'inbox' NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"person_id" uuid,
	"organization_id" uuid,
	"client_id" uuid,
	"linked_by_hand" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"resend_email_id" text NOT NULL,
	"direction" text NOT NULL,
	"from" text NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text,
	"html" text,
	"text" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"activity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_inbox_thread_id_inbox_threads_id_fk" FOREIGN KEY ("inbox_thread_id") REFERENCES "public"."inbox_threads"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_metrics" ADD CONSTRAINT "client_metrics_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_metrics" ADD CONSTRAINT "client_metrics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_services" ADD CONSTRAINT "client_services_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "client_services" ADD CONSTRAINT "client_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_thread_id_inbox_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."inbox_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD CONSTRAINT "inbox_threads_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD CONSTRAINT "inbox_threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD CONSTRAINT "inbox_threads_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "client_metrics_client_idx" ON "client_metrics" USING btree ("client_id","label","period");
--> statement-breakpoint
CREATE INDEX "client_services_client_idx" ON "client_services" USING btree ("client_id");
--> statement-breakpoint
CREATE INDEX "client_services_service_idx" ON "client_services" USING btree ("service_id","ended_on");
--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_messages_resend_idx" ON "inbox_messages" USING btree ("resend_email_id");
--> statement-breakpoint
CREATE INDEX "inbox_messages_thread_idx" ON "inbox_messages" USING btree ("thread_id","sent_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_threads_resend_idx" ON "inbox_threads" USING btree ("resend_thread_id");
--> statement-breakpoint
CREATE INDEX "inbox_threads_inbox_idx" ON "inbox_threads" USING btree ("resend_inbox_id","folder","last_message_at");
--> statement-breakpoint
CREATE INDEX "inbox_threads_person_idx" ON "inbox_threads" USING btree ("person_id");
--> statement-breakpoint
CREATE INDEX "inbox_threads_org_idx" ON "inbox_threads" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX "inbox_threads_client_idx" ON "inbox_threads" USING btree ("client_id");

