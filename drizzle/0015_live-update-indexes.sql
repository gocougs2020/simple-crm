-- IF NOT EXISTS: an earlier version of this migration already created both indexes on the shared database through a preview build.
CREATE INDEX IF NOT EXISTS "activities_updated_idx" ON "activities" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_created_idx" ON "events" USING btree ("created_at");
