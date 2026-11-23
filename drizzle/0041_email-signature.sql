ALTER TABLE "users" ADD COLUMN "email_signature" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signature_auto" boolean DEFAULT true NOT NULL;