-- Phase 1 (P0): Schedule conflict indexes, return pickup fail/unassign/cancel columns,
-- global variant SKU uniqueness, and orders delivery_method constraint.

ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "estimated_duration_minutes" integer;--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT IF EXISTS "unique_delivery";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "unique_active_driver_slot" ON "deliveries" USING btree ("driver_id","scheduled_date","departure_time") WHERE ("deliveries"."status" <> 'cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "unique_active_vehicle_slot" ON "deliveries" USING btree ("vehicle_id","scheduled_date","departure_time") WHERE ("deliveries"."status" <> 'cancelled');--> statement-breakpoint

ALTER TABLE "customer_returns" ADD COLUMN IF NOT EXISTS "failure_reason" text;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD COLUMN IF NOT EXISTS "failed_by" integer REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD COLUMN IF NOT EXISTS "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD COLUMN IF NOT EXISTS "failure_key" uuid;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD COLUMN IF NOT EXISTS "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD COLUMN IF NOT EXISTS "cancelled_by" integer REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_returns_failure_key_unique" ON "customer_returns" USING btree ("failure_key");--> statement-breakpoint
ALTER TABLE "customer_returns" DROP CONSTRAINT IF EXISTS "customer_return_status";--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_return_status" CHECK ("customer_returns"."status" in ('requested','assigned','collected','received','failed','cancelled'));--> statement-breakpoint
ALTER TABLE "customer_returns" DROP CONSTRAINT IF EXISTS "customer_return_assignment";--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_return_assignment" CHECK (("customer_returns"."status" in ('requested','cancelled') and "customer_returns"."assigned_delivery_id" is null) or ("customer_returns"."status" in ('assigned','collected','received','failed') and "customer_returns"."assigned_delivery_id" is not null));--> statement-breakpoint
ALTER TABLE "customer_returns" DROP CONSTRAINT IF EXISTS "customer_return_failure_reason";--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_return_failure_reason" CHECK ("customer_returns"."status" <> 'failed' or ("customer_returns"."failure_reason" is not null and length(trim("customer_returns"."failure_reason")) > 0));--> statement-breakpoint

ALTER TABLE "product_variants" DROP CONSTRAINT IF EXISTS "product_variants_product_id_sku_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_variants_sku_unique_idx" ON "product_variants" USING btree ("sku");--> statement-breakpoint

ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_delivery_method_valid";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_method_valid" CHECK ("orders"."delivery_method" in ('INTERNAL', 'LALAMOVE', 'PICKUP', 'WALK_IN'));
