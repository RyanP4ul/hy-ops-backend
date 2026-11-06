-- Idempotent for installations that previously applied the legacy migration.
CREATE OR REPLACE FUNCTION hyops_driver_assignment_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target integer; event_kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(OLD.driver_id,OLD.vehicle_id,OLD.status,OLD.scheduled_date,OLD.departure_time)
    IS NOT DISTINCT FROM ROW(NEW.driver_id,NEW.vehicle_id,NEW.status,NEW.scheduled_date,NEW.departure_time) THEN
    RETURN NEW;
  END IF;
  FOR target IN SELECT DISTINCT value FROM unnest(
    CASE WHEN TG_OP = 'UPDATE' THEN ARRAY[OLD.driver_id,NEW.driver_id] ELSE ARRAY[NEW.driver_id] END
  ) AS value WHERE value IS NOT NULL LOOP
    event_kind := CASE
      WHEN target <> NEW.driver_id THEN 'removed'
      WHEN TG_OP = 'INSERT' THEN 'assigned'
      WHEN OLD.driver_id IS DISTINCT FROM NEW.driver_id THEN 'assigned'
      WHEN NEW.status = 'cancelled' THEN 'cancelled'
      ELSE 'updated'
    END;
    PERFORM pg_notify('hyops_driver_changed', json_build_object(
      'eventId',gen_random_uuid(),'driverId',target,'deliveryId',NEW.id,'kind',event_kind
    )::text);
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS hyops_driver_assignment_changed ON deliveries;
--> statement-breakpoint
CREATE TRIGGER hyops_driver_assignment_changed AFTER INSERT OR UPDATE ON deliveries
FOR EACH ROW EXECUTE FUNCTION hyops_driver_assignment_event();
