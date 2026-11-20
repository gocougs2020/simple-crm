-- An earlier draft of 0031 dropped this column, which broke the version still running while the migration was applied.
-- Where that ran, this puts the column and its values back; everywhere else it's already there.
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;--> statement-breakpoint
UPDATE "clients" c SET "stripe_customer_id" = l."customer_id" FROM "client_stripe_links" l WHERE l."client_id" = c."id" AND l."account" = 'default' AND l."kind" = 'linked' AND c."stripe_customer_id" IS NULL;
