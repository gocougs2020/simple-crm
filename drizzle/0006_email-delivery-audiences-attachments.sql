CREATE TABLE "audiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "audience_id" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "reply_to" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "email_templates" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "reply_to" text;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "delivery_status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "delivery_detail" text;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "first_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "open_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "first_clicked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "click_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "status_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "email_bounced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audiences" ADD CONSTRAINT "audiences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_audience_id_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."audiences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbound_emails_resend_idx" ON "outbound_emails" USING btree ("resend_id");--> statement-breakpoint
CREATE INDEX "outbound_emails_campaign_status_idx" ON "outbound_emails" USING btree ("campaign_id","delivery_status");