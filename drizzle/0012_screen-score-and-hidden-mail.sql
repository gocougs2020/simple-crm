-- Written to be safe on any database that ran an earlier draft of 0011 (as a preview of the PR did): every change checks first.
ALTER TABLE "synced_emails" DROP COLUMN IF EXISTS "attempts";--> statement-breakpoint
ALTER TABLE "synced_emails" ADD COLUMN IF NOT EXISTS "screen_score" double precision;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "hidden_at" timestamp with time zone;
