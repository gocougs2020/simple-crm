-- Files used to roll down from where they were added: a client's file was also put on its contact and
-- organization, a person's on their organization. A file is now only on the record it was added on (a
-- client still shows its people's and organization's files), so drop the rolled-down copies.
UPDATE "files" SET "person_id" = NULL, "organization_id" = NULL WHERE "client_id" IS NOT NULL;--> statement-breakpoint
UPDATE "files" SET "organization_id" = NULL WHERE "client_id" IS NULL AND "person_id" IS NOT NULL;
