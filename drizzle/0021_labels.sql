CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labels_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Labels already on people and clients get a definition (no description yet), so they show in Settings and in the pickers.
INSERT INTO "labels" ("name")
SELECT DISTINCT t FROM (
  SELECT jsonb_array_elements_text("tags") AS t FROM "people"
  UNION SELECT jsonb_array_elements_text("tags") FROM "clients"
) x WHERE t <> ''
ON CONFLICT ("name") DO NOTHING;
