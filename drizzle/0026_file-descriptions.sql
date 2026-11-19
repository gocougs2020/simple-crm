ALTER TABLE "files" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "content_notes" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "description_by" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "describe_status" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "described_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "describe_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_description_by_users_id_fk" FOREIGN KEY ("description_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;