-- Safe to run again: the first previews of this branch applied an earlier version of these changes (as 0013 and
-- 0014) to a database that preview and production share, so each step skips what's already there.
CREATE TABLE IF NOT EXISTS "inbox_sends" (
	"resend_email_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "text_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_number_id" uuid,
	"remote" text NOT NULL,
	"remote_key" text NOT NULL,
	"person_id" uuid,
	"organization_id" uuid,
	"client_id" uuid,
	"read" boolean DEFAULT true NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "text_messages" ADD COLUMN IF NOT EXISTS "thread_id" uuid;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "inbox_sends" ADD CONSTRAINT "inbox_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "text_threads" ADD CONSTRAINT "text_threads_phone_number_id_phone_numbers_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "text_threads" ADD CONSTRAINT "text_threads_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "text_threads" ADD CONSTRAINT "text_threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "text_threads" ADD CONSTRAINT "text_threads_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "text_threads_number_remote_idx" ON "text_threads" USING btree ("phone_number_id","remote_key") WHERE "text_threads"."phone_number_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "text_threads_last_idx" ON "text_threads" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "text_threads_person_idx" ON "text_threads" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "text_threads_org_idx" ON "text_threads" USING btree ("organization_id");--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "text_messages" ADD CONSTRAINT "text_messages_thread_id_text_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."text_threads"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "text_messages_thread_idx" ON "text_messages" USING btree ("thread_id","created_at");
--> statement-breakpoint
-- Existing texts become conversations: one per (our number, their number). Links come from the latest text linked to a
-- person (else the latest text); one whose latest one-to-one text is an unanswered reply from the last week starts unread.
WITH m AS (
  SELECT "id", "phone_number_id", "direction", "campaign_id", "created_at", "person_id", "organization_id", "client_id",
    CASE WHEN "direction" = 'inbound' THEN "from" ELSE "to" END AS "remote",
    right(regexp_replace(CASE WHEN "direction" = 'inbound' THEN "from" ELSE "to" END, '[^0-9]', '', 'g'), 10) AS "remote_key"
  FROM "text_messages" WHERE "phone_number_id" IS NOT NULL
), latest AS (
  SELECT DISTINCT ON ("phone_number_id", "remote_key") "phone_number_id", "remote_key", "direction", "created_at"
  FROM m WHERE "campaign_id" IS NULL ORDER BY "phone_number_id", "remote_key", "created_at" DESC
), links AS (
  SELECT DISTINCT ON ("phone_number_id", "remote_key") "phone_number_id", "remote_key", "remote", "person_id", "organization_id", "client_id"
  FROM m ORDER BY "phone_number_id", "remote_key", ("person_id" IS NULL), ("organization_id" IS NULL), "created_at" DESC
)
INSERT INTO "text_threads" ("phone_number_id", "remote", "remote_key", "person_id", "organization_id", "client_id", "read", "last_message_at")
SELECT l."phone_number_id", l."remote", l."remote_key", l."person_id", l."organization_id", l."client_id",
  NOT coalesce(x."direction" = 'inbound' AND x."created_at" > now() - interval '7 days', false),
  x."created_at"
FROM links l LEFT JOIN latest x ON x."phone_number_id" = l."phone_number_id" AND x."remote_key" = l."remote_key"
WHERE length(l."remote_key") >= 7
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "text_messages" t SET "thread_id" = th."id"
FROM "text_threads" th
WHERE th."phone_number_id" = t."phone_number_id"
  AND th."remote_key" = right(regexp_replace(CASE WHEN t."direction" = 'inbound' THEN t."from" ELSE t."to" END, '[^0-9]', '', 'g'), 10)
  AND t."thread_id" IS NULL;
