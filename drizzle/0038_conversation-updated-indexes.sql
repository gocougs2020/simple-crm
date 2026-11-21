CREATE INDEX "inbox_threads_updated_idx" ON "inbox_threads" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "text_threads_updated_idx" ON "text_threads" USING btree ("updated_at");