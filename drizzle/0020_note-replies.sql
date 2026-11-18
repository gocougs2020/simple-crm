CREATE TABLE "note_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activity_id" uuid NOT NULL,
	"body" text NOT NULL,
	"user_id" uuid,
	"api_key_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_replies" ADD CONSTRAINT "note_replies_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_replies" ADD CONSTRAINT "note_replies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_replies" ADD CONSTRAINT "note_replies_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_replies_activity_idx" ON "note_replies" USING btree ("activity_id","created_at");--> statement-breakpoint
-- Devices already getting push alerts get the new "Mentions and replies" one too; it can be turned off per device.
UPDATE "push_subscriptions" SET "alerts" = "alerts" || '["mention"]'::jsonb WHERE jsonb_array_length("alerts") > 0 AND NOT "alerts" @> '["mention"]'::jsonb;
