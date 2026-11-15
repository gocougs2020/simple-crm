ALTER TABLE "outbound_emails" ADD COLUMN "first_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "open_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "first_clicked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "click_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "last_campaign_at" timestamp with time zone;--> statement-breakpoint
-- Campaigns already sent count toward each person's last campaign date.
UPDATE "people" SET "last_campaign_at" = sent."at" FROM (SELECT "person_id", max("created_at") AS "at" FROM "outbound_emails" WHERE "campaign_id" IS NOT NULL AND "person_id" IS NOT NULL GROUP BY "person_id") AS sent WHERE sent."person_id" = "people"."id";
