CREATE TABLE "stripe_activity" (
	"account" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"customer_id" text,
	"status" text NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"refunded" bigint DEFAULT 0 NOT NULL,
	"remaining" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"number" text,
	"description" text,
	"method" text,
	"failure" text,
	"url" text,
	"pdf" text,
	"invoice_id" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_activity_account_id_pk" PRIMARY KEY("account","id")
);
--> statement-breakpoint
CREATE INDEX "stripe_activity_created_idx" ON "stripe_activity" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "stripe_activity_customer_idx" ON "stripe_activity" USING btree ("account","customer_id");