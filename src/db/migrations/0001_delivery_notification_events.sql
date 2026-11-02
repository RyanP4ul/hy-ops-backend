ALTER TABLE "delivery_notifications" ADD COLUMN "event_key" text DEFAULT 'delivered' NOT NULL;
--> statement-breakpoint
ALTER TABLE "delivery_notifications" ADD COLUMN "event_type" text DEFAULT 'delivered' NOT NULL;
--> statement-breakpoint
ALTER TABLE "delivery_notifications" ADD COLUMN "scheduled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "delivery_notifications" ADD COLUMN "reason" text;
--> statement-breakpoint
ALTER TABLE "delivery_notifications" DROP CONSTRAINT "delivery_notification_stop_channel";
--> statement-breakpoint
ALTER TABLE "delivery_notifications" ADD CONSTRAINT "delivery_notification_stop_event_channel" UNIQUE ("stop_id", "event_key", "channel");
--> statement-breakpoint
ALTER TABLE "delivery_notifications" ADD CONSTRAINT "delivery_notification_event_valid" CHECK ("event_type" IN ('delivered', 'cancelled', 'rescheduled'));
