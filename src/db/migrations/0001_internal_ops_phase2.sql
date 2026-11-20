-- Internal Operations Phase 2:
-- 1) Partial unique index for unread notifications (replaces rigid unique user+title constraint)
-- 2) Order Pick -> Pack -> Stage checklist + Split Shipments across multiple trucks
-- 3) Vehicle Odometer & Maintenance / Service History Log
-- 4) Customer Return Pickup Proof-of-Collection (Photo & Signature)

ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_user_title_unique_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_user_title_unread_idx"
  ON "notifications" ("user_id", "title")
  WHERE "is_read" = false;
--> statement-breakpoint

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "staging_bay" varchar(64),
  ADD COLUMN IF NOT EXISTS "staged_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "staged_by" integer REFERENCES "users"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "parent_order_id" integer REFERENCES "orders"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "split_sequence" integer,
  ADD COLUMN IF NOT EXISTS "split_reason" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_parent_order_idx" ON "orders" ("parent_order_id");
--> statement-breakpoint

ALTER TABLE "order_items"
  ADD COLUMN IF NOT EXISTS "picked_qty" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "packed_qty" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "order_items_picked_qty_valid";
--> statement-breakpoint
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_picked_qty_valid"
  CHECK ("picked_qty" >= 0 AND "picked_qty" <= "quantity");
--> statement-breakpoint
ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "order_items_packed_qty_valid";
--> statement-breakpoint
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_packed_qty_valid"
  CHECK ("packed_qty" >= 0 AND "packed_qty" <= "picked_qty");
--> statement-breakpoint

ALTER TABLE "vehicles"
  ADD COLUMN IF NOT EXISTS "current_odometer_km" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "next_service_odometer_km" integer;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "vehicle_maintenance_logs" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "vehicle_id" integer NOT NULL REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "reported_by" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "completed_by" integer REFERENCES "users"("id") ON DELETE RESTRICT,
  "maintenance_type" varchar(32) NOT NULL DEFAULT 'repair',
  "status" varchar(24) NOT NULL DEFAULT 'open',
  "title" varchar(160) NOT NULL,
  "description" text,
  "workshop_name" varchar(160),
  "odometer_km" integer,
  "estimated_cost" numeric(12, 2),
  "actual_cost" numeric(12, 2),
  "put_in_maintenance" boolean NOT NULL DEFAULT true,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expected_return_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "vehicle_maint_type_check" CHECK ("maintenance_type" IN ('preventive', 'repair', 'tire_battery', 'inspection', 'breakdown')),
  CONSTRAINT "vehicle_maint_status_check" CHECK ("status" IN ('open', 'in_progress', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vehicle_maintenance_logs_vehicle_idx"
  ON "vehicle_maintenance_logs" ("vehicle_id", "status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "driver_return_proofs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "return_id" integer NOT NULL REFERENCES "customer_returns"("id") ON DELETE RESTRICT,
  "actor_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "operation_key" uuid NOT NULL UNIQUE,
  "kind" text NOT NULL,
  "storage_key" text NOT NULL UNIQUE,
  "content_type" text NOT NULL,
  "sha256" text NOT NULL,
  "byte_size" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "driver_return_proof_operation" UNIQUE ("return_id", "operation_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "driver_return_proofs_return_idx"
  ON "driver_return_proofs" ("return_id");
