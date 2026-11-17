CREATE INDEX "activities_updated_idx" ON "activities" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "events_created_idx" ON "events" USING btree ("created_at");