ALTER TABLE "order_items"
ADD COLUMN "unit_price_snapshot" numeric(10, 2);
--> statement-breakpoint
ALTER TABLE "order_items"
ADD COLUMN "price_source" varchar(32) NOT NULL DEFAULT 'legacy_unknown';
