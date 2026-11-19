CREATE TABLE "activity_people" (
	"activity_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_people_activity_id_person_id_pk" PRIMARY KEY("activity_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "client_people" (
	"client_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_people_client_id_person_id_pk" PRIMARY KEY("client_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "activity_people" ADD CONSTRAINT "activity_people_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_people" ADD CONSTRAINT "activity_people_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_people" ADD CONSTRAINT "client_people_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_people" ADD CONSTRAINT "client_people_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_people_person_idx" ON "activity_people" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "client_people_person_idx" ON "client_people" USING btree ("person_id");