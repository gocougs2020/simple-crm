-- An earlier preview of this change made a plain index under the same name; replace it with the unique one.
DROP INDEX IF EXISTS "files_url_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "files_url_idx" ON "files" USING btree ("url");
