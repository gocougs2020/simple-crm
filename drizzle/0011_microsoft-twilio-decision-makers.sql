CREATE TABLE "connected_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"send_mail" boolean DEFAULT true NOT NULL,
	"sync_mail" boolean DEFAULT true NOT NULL,
	"sync_calendar" boolean DEFAULT true NOT NULL,
	"calendar_sharing" text DEFAULT 'busy' NOT NULL,
	"mail_cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_sid" text,
	"phone_number_id" uuid,
	"user_id" uuid,
	"direction" text NOT NULL,
	"from" text NOT NULL,
	"to" text NOT NULL,
	"status" text DEFAULT 'initiated' NOT NULL,
	"forwarded_to" text,
	"duration_seconds" integer,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"person_id" uuid,
	"organization_id" uuid,
	"client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_number_users" (
	"phone_number_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "phone_number_users_phone_number_id_user_id_pk" PRIMARY KEY("phone_number_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "phone_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twilio_sid" text NOT NULL,
	"number" text NOT NULL,
	"label" text NOT NULL,
	"forward_to" text,
	"forward_user_id" uuid,
	"access" text DEFAULT 'everyone' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "synced_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"external_id" text NOT NULL,
	"internet_message_id" text,
	"conversation_id" text,
	"direction" text NOT NULL,
	"from" text,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"person_id" uuid,
	"organization_id" uuid,
	"client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "text_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_sid" text,
	"phone_number_id" uuid,
	"direction" text NOT NULL,
	"from" text NOT NULL,
	"to" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"user_id" uuid,
	"person_id" uuid,
	"organization_id" uuid,
	"client_id" uuid,
	"campaign_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "synced_email_id" uuid;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "call_id" uuid;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "text_message_id" uuid;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "calendar_event_id" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "calendar_account_id" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "channel" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "text_body" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "phone_number_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "provider" text DEFAULT 'resend' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "message_id" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "decision_maker" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "text_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "text_opt_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "phone" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_phone_number_id_phone_numbers_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_calls" ADD CONSTRAINT "phone_calls_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_number_users" ADD CONSTRAINT "phone_number_users_phone_number_id_phone_numbers_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_number_users" ADD CONSTRAINT "phone_number_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_forward_user_id_users_id_fk" FOREIGN KEY ("forward_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synced_emails" ADD CONSTRAINT "synced_emails_account_id_connected_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synced_emails" ADD CONSTRAINT "synced_emails_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synced_emails" ADD CONSTRAINT "synced_emails_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "synced_emails" ADD CONSTRAINT "synced_emails_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_messages" ADD CONSTRAINT "text_messages_phone_number_id_phone_numbers_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_messages" ADD CONSTRAINT "text_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_messages" ADD CONSTRAINT "text_messages_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_messages" ADD CONSTRAINT "text_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_messages" ADD CONSTRAINT "text_messages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "text_messages" ADD CONSTRAINT "text_messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connected_accounts_user_idx" ON "connected_accounts" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_calls_sid_idx" ON "phone_calls" USING btree ("call_sid");--> statement-breakpoint
CREATE INDEX "phone_calls_person_idx" ON "phone_calls" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_sid_idx" ON "phone_numbers" USING btree ("twilio_sid");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_number_idx" ON "phone_numbers" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "synced_emails_account_msg_idx" ON "synced_emails" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "synced_emails_internet_idx" ON "synced_emails" USING btree ("internet_message_id");--> statement-breakpoint
CREATE INDEX "synced_emails_status_idx" ON "synced_emails" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "text_messages_sid_idx" ON "text_messages" USING btree ("message_sid");--> statement-breakpoint
CREATE UNIQUE INDEX "text_messages_campaign_person_idx" ON "text_messages" USING btree ("campaign_id","person_id");--> statement-breakpoint
CREATE INDEX "text_messages_person_idx" ON "text_messages" USING btree ("person_id","created_at");--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_synced_email_id_synced_emails_id_fk" FOREIGN KEY ("synced_email_id") REFERENCES "public"."synced_emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_call_id_phone_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."phone_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_text_message_id_text_messages_id_fk" FOREIGN KEY ("text_message_id") REFERENCES "public"."text_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_calendar_account_id_connected_accounts_id_fk" FOREIGN KEY ("calendar_account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_phone_number_id_phone_numbers_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_call_idx" ON "activities" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "activities_text_idx" ON "activities" USING btree ("text_message_id");--> statement-breakpoint
CREATE INDEX "organizations_phone_digits_idx" ON "organizations" USING btree (right(regexp_replace(regexp_replace("phone", '\s*(x|ext\.?|extension|#)\s*[0-9]+\s*$', '', 'i'), '[^0-9]', '', 'g'), 10));--> statement-breakpoint
CREATE INDEX "outbound_emails_message_idx" ON "outbound_emails" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "people_phone_digits_idx" ON "people" USING btree (right(regexp_replace(regexp_replace("phone", '\s*(x|ext\.?|extension|#)\s*[0-9]+\s*$', '', 'i'), '[^0-9]', '', 'g'), 10));