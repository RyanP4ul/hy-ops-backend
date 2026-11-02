-- Existing orders have no proven reservation; reserve them when dispatching.
ALTER TABLE "orders" ADD COLUMN "stock_reserved" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- The previous schema incorrectly referenced users for warehouse_id.
-- NOT VALID preserves legacy rows pending an orphan review, while enforcing new writes.
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_warehouse_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_warehouse_id_warehouses_id_fk"
  FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT NOT VALID;
