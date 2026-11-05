CREATE TABLE "external_ids" (
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"local_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_ids_source_kind_external_id_pk" PRIMARY KEY("source","kind","external_id")
);
--> statement-breakpoint
CREATE INDEX "external_ids_local_idx" ON "external_ids" USING btree ("local_id");