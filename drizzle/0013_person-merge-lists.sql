CREATE TABLE "person_organizations" (
	"person_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_organizations_person_id_organization_id_pk" PRIMARY KEY("person_id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "other_emails" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "other_phones" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "person_organizations" ADD CONSTRAINT "person_organizations_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_organizations" ADD CONSTRAINT "person_organizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_organizations_org_idx" ON "person_organizations" USING btree ("organization_id");