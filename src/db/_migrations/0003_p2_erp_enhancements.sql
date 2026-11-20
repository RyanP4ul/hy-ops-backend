-- Phase 3 (P2): Variant COGS & order cost snapshots, per-SKU reorder points,
-- inter-warehouse stock transfers, per-warehouse operating rules, and order tracking tokens.

ALTER TABLE "product_variants" ADD COLUMN IF NOT EXISTS "cost_price" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "unit_cost_snapshot" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tracking_token" uuid DEFAULT gen_random_uuid();--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_tracking_token_unique" ON "orders" USING btree ("tracking_token");--> statement-breakpoint

ALTER TABLE "inventory" ADD COLUMN IF NOT EXISTS "reorder_point" integer;--> statement-breakpoint

ALTER TABLE "warehouses" ADD COLUMN IF NOT EXISTS "daily_order_limit" integer;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN IF NOT EXISTS "operating_days" jsonb;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN IF NOT EXISTS "arrival_radius_m" integer;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stock_transfers" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "transfer_number" varchar(32) NOT NULL UNIQUE,
  "from_warehouse_id" integer NOT NULL REFERENCES "public"."warehouses"("id") ON DELETE restrict,
  "to_warehouse_id" integer NOT NULL REFERENCES "public"."warehouses"("id") ON DELETE restrict,
  "status" varchar(24) NOT NULL DEFAULT 'draft',
  "notes" text,
  "requested_by" integer NOT NULL REFERENCES "public"."users"("id") ON DELETE restrict,
  "dispatched_by" integer REFERENCES "public"."users"("id") ON DELETE restrict,
  "dispatched_at" timestamp with time zone,
  "received_by" integer REFERENCES "public"."users"("id") ON DELETE restrict,
  "received_at" timestamp with time zone,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "stock_transfers_distinct_warehouses" CHECK ("from_warehouse_id" <> "to_warehouse_id"),
  CONSTRAINT "stock_transfers_status_valid" CHECK ("status" in ('draft', 'in_transit', 'received', 'cancelled'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfers_from_warehouse_idx" ON "stock_transfers" USING btree ("from_warehouse_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfers_to_warehouse_idx" ON "stock_transfers" USING btree ("to_warehouse_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "stock_transfer_items" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "transfer_id" integer NOT NULL REFERENCES "public"."stock_transfers"("id") ON DELETE cascade,
  "product_variant_id" integer NOT NULL REFERENCES "public"."product_variants"("id") ON DELETE restrict,
  "quantity_sent" integer NOT NULL,
  "quantity_received" integer,
  CONSTRAINT "stock_transfer_item_unique" UNIQUE("transfer_id", "product_variant_id"),
  CONSTRAINT "stock_transfer_qty_positive" CHECK ("quantity_sent" > 0),
  CONSTRAINT "stock_transfer_received_nonneg" CHECK ("quantity_received" is null or "quantity_received" >= 0)
);
