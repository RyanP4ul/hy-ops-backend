CREATE TABLE "customer_returns" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customer_returns_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"source_stop_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"requested_by" integer NOT NULL,
	"request_key" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"address" text NOT NULL,
	"recipient" text NOT NULL,
	"phone" text,
	"latitude" text,
	"longitude" text,
	"assigned_delivery_id" integer,
	"assignment_key" uuid,
	"assigned_by" integer,
	"collected_by" integer,
	"collection_key" uuid,
	"collected_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"received_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_returns_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "customer_returns_source_stop_id_unique" UNIQUE("source_stop_id"),
	CONSTRAINT "customer_returns_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "customer_returns_assignment_key_unique" UNIQUE("assignment_key"),
	CONSTRAINT "customer_returns_collection_key_unique" UNIQUE("collection_key"),
	CONSTRAINT "customer_return_status" CHECK ("customer_returns"."status" in ('requested','assigned','collected','received')),
	CONSTRAINT "customer_return_reason" CHECK (length(trim("customer_returns"."reason")) > 0),
	CONSTRAINT "customer_return_assignment" CHECK (("customer_returns"."status" = 'requested' and "customer_returns"."assigned_delivery_id" is null) or ("customer_returns"."status" <> 'requested' and "customer_returns"."assigned_delivery_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_source_stop_id_deliveries_stops_id_fk" FOREIGN KEY ("source_stop_id") REFERENCES "public"."deliveries_stops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_assigned_delivery_id_deliveries_id_fk" FOREIGN KEY ("assigned_delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_collected_by_users_id_fk" FOREIGN KEY ("collected_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_return_warehouse_status" ON "customer_returns" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE INDEX "customer_return_delivery" ON "customer_returns" USING btree ("assigned_delivery_id");

--> statement-breakpoint
CREATE FUNCTION hyops_customer_return_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_id integer; owner_id integer;
BEGIN
  FOR run_id IN SELECT DISTINCT value FROM unnest(CASE WHEN TG_OP = 'UPDATE' THEN ARRAY[OLD.assigned_delivery_id, NEW.assigned_delivery_id] ELSE ARRAY[NEW.assigned_delivery_id] END) AS value WHERE value IS NOT NULL LOOP
    SELECT driver_id INTO owner_id FROM deliveries WHERE id=run_id;
    IF owner_id IS NOT NULL THEN
      PERFORM pg_notify('hyops_driver_changed', json_build_object('eventId',gen_random_uuid(),'driverId',owner_id,'deliveryId',run_id,'kind','updated')::text);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER hyops_customer_return_changed AFTER INSERT OR UPDATE ON customer_returns FOR EACH ROW EXECUTE FUNCTION hyops_customer_return_event();
