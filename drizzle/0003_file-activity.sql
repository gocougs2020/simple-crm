ALTER TABLE "files" ADD COLUMN "activity_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_activity_idx" ON "files" USING btree ("activity_id");