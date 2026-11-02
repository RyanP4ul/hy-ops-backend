CREATE TABLE "driver_stop_proofs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"stop_id" integer NOT NULL,
	"actor_id" integer NOT NULL,
	"operation_key" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_stop_proofs_operation_key_unique" UNIQUE("operation_key"),
	CONSTRAINT "driver_stop_proofs_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "driver_proof_stop_operation" UNIQUE("stop_id","operation_key")
);
--> statement-breakpoint
ALTER TABLE "driver_stop_proofs" ADD CONSTRAINT "driver_stop_proofs_stop_id_deliveries_stops_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."deliveries_stops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_stop_proofs" ADD CONSTRAINT "driver_stop_proofs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "driver_proofs_stop_idx" ON "driver_stop_proofs" USING btree ("stop_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION hyops_driver_assignment_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target integer; event_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(OLD.driver_id,OLD.vehicle_id,OLD.status,OLD.scheduled_date,OLD.departure_time)
    IS NOT DISTINCT FROM ROW(NEW.driver_id,NEW.vehicle_id,NEW.status,NEW.scheduled_date,NEW.departure_time) THEN RETURN NEW; END IF;
  FOR target IN SELECT DISTINCT value FROM unnest(CASE WHEN TG_OP = 'UPDATE' THEN ARRAY[OLD.driver_id,NEW.driver_id] ELSE ARRAY[NEW.driver_id] END) AS value LOOP
    event_id := gen_random_uuid();
    PERFORM pg_notify('hyops_driver_changed', json_build_object('eventId',event_id,'driverId',target,'deliveryId',NEW.id,'kind',CASE WHEN target <> NEW.driver_id THEN 'removed' ELSE 'updated' END)::text);
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER hyops_driver_assignment_changed AFTER INSERT OR UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION hyops_driver_assignment_event();
