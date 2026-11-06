CREATE TABLE "order_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "group_number" varchar(32) NOT NULL UNIQUE,
  "customer_id" integer NOT NULL REFERENCES "customers"("id") ON DELETE restrict,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_group_id" uuid REFERENCES "order_groups"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_group_position" integer;
--> statement-breakpoint
CREATE INDEX "orders_group_index" ON "orders" ("order_group_id");
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_group_position_unique" UNIQUE ("order_group_id", "order_group_position");
