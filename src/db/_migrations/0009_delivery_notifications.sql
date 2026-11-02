CREATE TABLE "delivery_notifications" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "stop_id" integer NOT NULL REFERENCES "deliveries_stops"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "recipient" text,
  "status" text NOT NULL DEFAULT 'pending',
  "provider_id" text,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "delivery_notification_stop_channel" UNIQUE ("stop_id", "channel"),
  CONSTRAINT "delivery_notification_channel_valid" CHECK ("channel" IN ('sms', 'email')),
  CONSTRAINT "delivery_notification_status_valid" CHECK ("status" IN ('pending', 'sending', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX "delivery_notification_status_idx" ON "delivery_notifications" ("status");
