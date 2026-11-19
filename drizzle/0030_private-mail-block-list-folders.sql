ALTER TABLE "connected_accounts" ADD COLUMN "mail_folders" jsonb;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "blocked" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "synced_emails" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "synced_emails" ADD COLUMN "body" text;