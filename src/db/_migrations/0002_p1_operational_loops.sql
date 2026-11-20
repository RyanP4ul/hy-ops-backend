-- Phase 2 (P1): Customer return disposition, vehicle payload capacity,
-- and delivery expense settlement fields.

ALTER TABLE "customer_returns" ADD COLUMN IF NOT EXISTS "disposition" text;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD COLUMN IF NOT EXISTS "disposition_notes" text;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD COLUMN IF NOT EXISTS "disposition_by" integer REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD COLUMN IF NOT EXISTS "disposition_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD COLUMN IF NOT EXISTS "disposition_key" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_returns_disposition_key_unique" ON "customer_returns" USING btree ("disposition_key");--> statement-breakpoint
ALTER TABLE "customer_returns" DROP CONSTRAINT IF EXISTS "customer_return_disposition_valid";--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_return_disposition_valid" CHECK ("customer_returns"."disposition" is null or "customer_returns"."disposition" in ('restocked','damaged','partial'));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "customer_return_disposition_items" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "return_id" integer NOT NULL REFERENCES "public"."customer_returns"("id") ON DELETE cascade,
  "inventory_id" integer NOT NULL REFERENCES "public"."inventory"("id") ON DELETE restrict,
  "restocked_qty" integer NOT NULL DEFAULT 0,
  "damaged_qty" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "customer_return_disposition_item_unique" UNIQUE("return_id","inventory_id"),
  CONSTRAINT "customer_return_disposition_qty_nonneg" CHECK ("restocked_qty" >= 0 and "damaged_qty" >= 0 and ("restocked_qty" + "damaged_qty") > 0)
);--> statement-breakpoint

ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "max_weight_kg" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "max_volume_cbm" numeric(10, 3);--> statement-breakpoint

ALTER TABLE "deliveries_expenses" ADD COLUMN IF NOT EXISTS "actual_delivery_allowance" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "deliveries_expenses" ADD COLUMN IF NOT EXISTS "actual_fuel" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "deliveries_expenses" ADD COLUMN IF NOT EXISTS "actual_toll" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "deliveries_expenses" ADD COLUMN IF NOT EXISTS "settlement_notes" text;--> statement-breakpoint
ALTER TABLE "deliveries_expenses" ADD COLUMN IF NOT EXISTS "settled_by" integer REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries_expenses" ADD COLUMN IF NOT EXISTS "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries_expenses" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
