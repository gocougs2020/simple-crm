CREATE TABLE "email_forwards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resend_email_id" text NOT NULL,
	"user_id" uuid,
	"conversation_id" uuid,
	"conversation_key" text,
	"round" integer DEFAULT 1 NOT NULL,
	"message_id" text,
	"from_address" text,
	"subject" text,
	"text" text,
	"status" text DEFAULT 'received' NOT NULL,
	"reason" text,
	"verified_by" text,
	"run_id" uuid,
	"reply_id" text,
	"replied_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "forward_token" text;--> statement-breakpoint
ALTER TABLE "email_forwards" ADD CONSTRAINT "email_forwards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_forwards" ADD CONSTRAINT "email_forwards_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_forwards_resend_idx" ON "email_forwards" USING btree ("resend_email_id");--> statement-breakpoint
CREATE INDEX "email_forwards_user_idx" ON "email_forwards" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "email_forwards_run_idx" ON "email_forwards" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "email_forwards_conversation_idx" ON "email_forwards" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "email_forwards_key_idx" ON "email_forwards" USING btree ("conversation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "users_forward_token_idx" ON "users" USING btree ("forward_token");