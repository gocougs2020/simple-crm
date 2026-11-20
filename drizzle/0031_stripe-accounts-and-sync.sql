CREATE TABLE "client_stripe_links" (
	"client_id" uuid NOT NULL,
	"account" text NOT NULL,
	"customer_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_stripe_links_client_id_account_customer_id_pk" PRIMARY KEY("client_id","account","customer_id")
);
--> statement-breakpoint
CREATE TABLE "stripe_customers" (
	"account" text NOT NULL,
	"customer_id" text NOT NULL,
	"email" text,
	"name" text,
	"balance" bigint DEFAULT 0 NOT NULL,
	"currency" text,
	"delinquent" boolean DEFAULT false NOT NULL,
	"customer_since" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_customers_account_customer_id_pk" PRIMARY KEY("account","customer_id")
);
--> statement-breakpoint
CREATE TABLE "stripe_subscriptions" (
	"account" text NOT NULL,
	"subscription_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"status" text NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"monthly" bigint DEFAULT 0 NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"period_end" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_subscriptions_account_subscription_id_pk" PRIMARY KEY("account","subscription_id")
);
--> statement-breakpoint
DROP INDEX "clients_stripe_idx";--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "stripe_status" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "stripe_mrr" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "stripe_products" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "stripe_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "client_stripe_links" ADD CONSTRAINT "client_stripe_links_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_stripe_links" ADD CONSTRAINT "client_stripe_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stripe_customers_email_idx" ON "stripe_customers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "stripe_subscriptions_customer_idx" ON "stripe_subscriptions" USING btree ("account","customer_id");--> statement-breakpoint
CREATE INDEX "clients_stripe_status_idx" ON "clients" USING btree ("stripe_status");--> statement-breakpoint
-- Customers linked by hand before accounts had names stay linked, in the account STRIPE_SECRET_KEY names ("default").
INSERT INTO "client_stripe_links" ("client_id", "account", "customer_id", "kind") SELECT "id", 'default', "stripe_customer_id", 'linked' FROM "clients" WHERE "stripe_customer_id" IS NOT NULL;
-- The column itself stays (see 0032): a deployment still running the previous version selects it while this migration runs.