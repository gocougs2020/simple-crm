CREATE TABLE "client_organizations" (
	"client_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_organizations_client_id_organization_id_pk" PRIMARY KEY("client_id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "client_organizations" ADD CONSTRAINT "client_organizations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_organizations" ADD CONSTRAINT "client_organizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_organizations_org_idx" ON "client_organizations" USING btree ("organization_id");