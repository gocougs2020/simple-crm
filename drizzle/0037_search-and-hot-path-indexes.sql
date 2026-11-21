CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "activities_feed_idx" ON "activities" USING btree (coalesce("occurred_at", "completed_at", "created_at") desc) WHERE "activities"."completed_at" is not null or "activities"."due_at" is null;--> statement-breakpoint
CREATE INDEX "activities_client_planned_idx" ON "activities" USING btree ("client_id","due_at") WHERE "activities"."completed_at" is null and "activities"."due_at" is not null;--> statement-breakpoint
CREATE INDEX "activities_person_planned_idx" ON "activities" USING btree ("person_id","due_at") WHERE "activities"."completed_at" is null and "activities"."due_at" is not null;--> statement-breakpoint
CREATE INDEX "activities_org_planned_idx" ON "activities" USING btree ("organization_id","due_at") WHERE "activities"."completed_at" is null and "activities"."due_at" is not null;--> statement-breakpoint
CREATE INDEX "activities_email_idx" ON "activities" USING btree ("email_id");--> statement-breakpoint
CREATE INDEX "activities_inbox_thread_idx" ON "activities" USING btree ("inbox_thread_id");--> statement-breakpoint
CREATE INDEX "activities_synced_email_idx" ON "activities" USING btree ("synced_email_id");--> statement-breakpoint
CREATE INDEX "activities_agent_run_idx" ON "activities" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "clients_name_trgm_idx" ON "clients" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clients_tags_idx" ON "clients" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "inbox_messages_activity_idx" ON "inbox_messages" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "inbox_threads_unread_idx" ON "inbox_threads" USING btree ("folder","last_message_at") WHERE not "inbox_threads"."read";--> statement-breakpoint
CREATE INDEX "organizations_name_trgm_idx" ON "organizations" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "organizations_domain_trgm_idx" ON "organizations" USING gin ("domain" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "organizations_tags_idx" ON "organizations" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "outbound_emails_awaiting_idx" ON "outbound_emails" USING btree ("created_at") WHERE "outbound_emails"."resend_id" is not null and ("outbound_emails"."delivery_status" is null or "outbound_emails"."delivery_status" in ('sent', 'delayed'));--> statement-breakpoint
CREATE INDEX "people_name_sort_idx" ON "people" USING btree (lower("first_name" || ' ' || coalesce("last_name", '')),"id");--> statement-breakpoint
CREATE INDEX "people_name_trgm_idx" ON "people" USING gin (("first_name" || ' ' || coalesce("last_name", '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "people_email_trgm_idx" ON "people" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "people_tags_idx" ON "people" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "rate_limits_window_idx" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "text_threads_unread_idx" ON "text_threads" USING btree ("last_message_at") WHERE not "text_threads"."read";