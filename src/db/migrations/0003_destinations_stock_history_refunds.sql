ALTER TABLE orders ADD COLUMN shipping_latitude numeric(10,6), ADD COLUMN shipping_longitude numeric(10,6), ADD COLUMN shipping_address_source_id integer;
--> statement-breakpoint
ALTER TABLE payments ADD COLUMN refunded_amount numeric(12,2) NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE stock_movements (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 inventory_id integer NOT NULL REFERENCES inventory(id) ON DELETE RESTRICT,
 order_id integer, actor_id integer REFERENCES users(id) ON DELETE RESTRICT,
 kind text NOT NULL, quantity_delta integer NOT NULL, reserved_delta integer NOT NULL,
 quantity_after integer NOT NULL, reserved_after integer NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX stock_movements_inventory_created_idx ON stock_movements(inventory_id, id);
--> statement-breakpoint
CREATE TABLE payment_refunds (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 payment_id integer NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
 actor_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL UNIQUE, amount numeric(12,2) NOT NULL CHECK (amount > 0),
 reason text NOT NULL CHECK (length(trim(reason)) > 0), created_at timestamptz NOT NULL DEFAULT now()
);
