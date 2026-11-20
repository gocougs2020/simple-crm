DROP INDEX "users_forward_token_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "email_forwards_message_idx" ON "email_forwards" USING btree ("user_id","message_id");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "forward_token";