CREATE TABLE "driver_stop_outcomes" (
	"stop_id" integer PRIMARY KEY NOT NULL,
	"actor_id" integer NOT NULL,
	"operation_key" uuid NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_stop_outcomes_operation_key_unique" UNIQUE("operation_key"),
	CONSTRAINT "driver_outcome_valid" CHECK ("driver_stop_outcomes"."outcome" in ('delivered', 'failed')),
	CONSTRAINT "driver_failure_reason_required" CHECK ("driver_stop_outcomes"."outcome" <> 'failed' OR length(trim("driver_stop_outcomes"."reason")) > 0 AND "driver_stop_outcomes"."reason" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "driver_stop_outcomes" ADD CONSTRAINT "driver_stop_outcomes_stop_id_deliveries_stops_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."deliveries_stops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_stop_outcomes" ADD CONSTRAINT "driver_stop_outcomes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;