CREATE TYPE "public"."automation_status" AS ENUM('ENABLED', 'DISABLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."calendar_event_enum" AS ENUM('DELIVERY', 'ORDER_FULFILLMENT', 'INVENTORY_WAREHOUSE', 'VEHICLE_MAINTENANCE', 'STAFF_SCHEDULE', 'MEETING_APPOINTMENT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."deliveries_event_type" AS ENUM('CANCELLED', 'RESCHEDULED', 'DELAYED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."deliveries_expenses_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."deliveries_status" AS ENUM('scheduled', 'in_transit', 'completed', 'returning', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."deliveries_stops_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."delivery_type" AS ENUM('LALAMOVE', 'PICKUP', 'INTERNAL');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('PENDING', 'PROCESSING', 'SCHEDULING', 'SCHEDULED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_arrangement" AS ENUM('FULLY_PAID', 'PARTIALLY_PAID', 'PAY_ON_DELIVERY', 'NET_30');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'BANK_TRANSFER', 'CARD');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE');--> statement-breakpoint
CREATE TYPE "public"."driver_status" AS ENUM('available', 'unavailable', 'day_off', 'on_delivery', 'on_break', 'on_leave', 'on_accident', 'on_personal_leave', 'on_sick_leave');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'staff', 'customer', 'driver');--> statement-breakpoint
CREATE TYPE "public"."vehicle_status_enum" AS ENUM('available', 'unavailable', 'maintenance', 'on_delivery');--> statement-breakpoint
CREATE TYPE "public"."vehicle_type_enum" AS ENUM('truck', 'van', 'other');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'ISSUED', 'VOID');--> statement-breakpoint
CREATE TABLE "archives" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "archives_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"entity_id" varchar(255) NOT NULL,
	"entity_type" varchar(255) NOT NULL,
	"archived_by" integer NOT NULL,
	"archived_at" integer NOT NULL,
	"deletion_requested_at" integer,
	"delete_after" integer,
	"deletion_error" text,
	"deletion_last_attempt_at" integer,
	CONSTRAINT "archives_retention_valid" CHECK (("archives"."deletion_requested_at" is null and "archives"."delete_after" is null) or ("archives"."deletion_requested_at" is not null and "archives"."delete_after" is not null and "archives"."deletion_requested_at" >= "archives"."archived_at" and "archives"."delete_after" >= "archives"."deletion_requested_at" + 2592000))
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"action" varchar(255) NOT NULL,
	"entity_id" varchar(255) NOT NULL,
	"entity_type" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"old_value" text NOT NULL,
	"new_value" text NOT NULL,
	"metadata" text NOT NULL,
	"ip_address" varchar(255) NOT NULL,
	"user_agent" varchar(255) NOT NULL,
	"created_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "automations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(100) NOT NULL,
	"description" text NOT NULL,
	"schedule" varchar(100) NOT NULL,
	"interval_ms" integer,
	"daily_time" varchar(5),
	"status" "automation_status" DEFAULT 'DISABLED' NOT NULL,
	"notes" text,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "calendar_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"title" varchar(50) NOT NULL,
	"category" "calendar_event_enum" DEFAULT 'OTHER' NOT NULL,
	"date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
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
CREATE TABLE "deliveries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"driver_id" integer NOT NULL,
	"vehicle_id" integer NOT NULL,
	"scheduled_date" date NOT NULL,
	"departure_time" time NOT NULL,
	"delivery_type" "delivery_type" DEFAULT 'INTERNAL' NOT NULL,
	"status" "deliveries_status" DEFAULT 'scheduled' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"driver_stop_plan" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unique_delivery" UNIQUE("driver_id","scheduled_date","departure_time")
);
--> statement-breakpoint
CREATE TABLE "deliveries_event" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deliveries_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"delivery_id" integer NOT NULL,
	"event_type" "deliveries_event_type" NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries_expenses" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deliveries_expenses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"delivery_id" integer NOT NULL,
	"delivery_allowance" numeric(12, 2) NOT NULL,
	"fuel" numeric(12, 2) NOT NULL,
	"toll" numeric(12, 2) NOT NULL,
	"status" "deliveries_expenses_status" DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries_proof" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deliveries_proof_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"delivery_id" integer NOT NULL,
	"storage_key" varchar(512) NOT NULL,
	"content_type" varchar(128) DEFAULT 'image/webp' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_proof_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "deliveries_stops" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deliveries_stops_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"delivery_id" integer NOT NULL,
	"order_id" integer NOT NULL,
	"leg_index" integer DEFAULT 0 NOT NULL,
	"status" "deliveries_stops_status" DEFAULT 'pending' NOT NULL,
	"latitude" numeric(10, 6) NOT NULL,
	"longitude" numeric(10, 6) NOT NULL,
	"delivered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_notifications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "delivery_notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"stop_id" integer,
	"booking_id" integer,
	"channel" text NOT NULL,
	"event_key" text DEFAULT 'delivered' NOT NULL,
	"event_type" text DEFAULT 'delivered' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"reason" text,
	"recipient" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_notification_stop_event_channel" UNIQUE("stop_id","event_key","channel"),
	CONSTRAINT "delivery_notification_booking_event_channel" UNIQUE("booking_id","event_key","channel"),
	CONSTRAINT "delivery_notification_owner_valid" CHECK (("delivery_notifications"."stop_id" is not null)::integer + ("delivery_notifications"."booking_id" is not null)::integer = 1),
	CONSTRAINT "delivery_notification_channel_valid" CHECK ("delivery_notifications"."channel" in ('sms', 'email')),
	CONSTRAINT "delivery_notification_event_valid" CHECK ("delivery_notifications"."event_type" in ('delivered', 'cancelled', 'rescheduled')),
	CONSTRAINT "delivery_notification_status_valid" CHECK ("delivery_notifications"."status" in ('pending', 'sending', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
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
CREATE TABLE "driver_sync_receipts" (
	"operation_key" uuid PRIMARY KEY NOT NULL,
	"actor_id" integer NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"warehouse_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	CONSTRAINT "inventory_warehouse_product_id_product_variant_id_unique_idx" UNIQUE("warehouse_id","product_id","product_variant_id")
);
--> statement-breakpoint
CREATE TABLE "delivery_orders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "delivery_orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer,
	"environment" text DEFAULT 'sandbox' NOT NULL,
	"market" text DEFAULT 'PH' NOT NULL,
	"booking_state" text DEFAULT 'CONFIRMED' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"idempotency_key" uuid,
	"request_fingerprint" text,
	"service_type" text,
	"route_snapshot" jsonb,
	"share_link" text,
	"driver_id" text,
	"driver_details" jsonb,
	"failure_message" text,
	"resolution_note" text,
	"last_synced_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"lalamove_order_id" text,
	"quotation_id" text NOT NULL,
	"booked_by" integer NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_phone" text NOT NULL,
	"pickup_address" text NOT NULL,
	"dropoff_address" text NOT NULL,
	"delivery_fee" numeric(12, 2),
	"currency" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"lalamove_response" jsonb,
	"created_at" integer DEFAULT extract(epoch from now())::integer NOT NULL,
	"updated_at" integer DEFAULT extract(epoch from now())::integer NOT NULL,
	CONSTRAINT "delivery_orders_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "lalamove_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedupe_key" text NOT NULL,
	"environment" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_order_id" text,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lalamove_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "lalamove_provider_ids" (
	"identity" text PRIMARY KEY NOT NULL,
	"booking_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lalamove_quotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" integer NOT NULL,
	"booked_by" integer NOT NULL,
	"order_version" integer NOT NULL,
	"environment" text NOT NULL,
	"market" text NOT NULL,
	"fingerprint" text NOT NULL,
	"route" jsonb NOT NULL,
	"provider_quote" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"type" varchar(50) NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" integer DEFAULT 1794398274 NOT NULL,
	CONSTRAINT "notifications_user_title_unique_idx" UNIQUE("user_id","title")
);
--> statement-breakpoint
CREATE TABLE "order_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_number" varchar(32) NOT NULL,
	"customer_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_groups_group_number_unique" UNIQUE("group_number")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"inventory_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_snapshot" numeric(10, 2),
	"price_source" varchar(32) DEFAULT 'legacy_unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_inventory_unique" UNIQUE("order_id","inventory_id"),
	CONSTRAINT "quantity_check" CHECK (quantity > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_number" varchar(32) NOT NULL,
	"warehouse_id" integer NOT NULL,
	"customer_id" integer NOT NULL,
	"payment_arrangement" "payment_arrangement" DEFAULT 'NET_30',
	"order_group_id" uuid,
	"order_group_position" integer,
	"notes" text,
	"stock_reserved" boolean DEFAULT false NOT NULL,
	"sales_channel" varchar(16) DEFAULT 'STANDARD' NOT NULL,
	"walk_in_checkout_key" varchar(36),
	"walk_in_checkout_fingerprint" text,
	"walk_in_amount_tendered" numeric(20, 2),
	"delivery_method" varchar(16),
	"lalamove_pickup_warehouse_id" integer,
	"status" "order_status" DEFAULT 'PENDING' NOT NULL,
	"shipping_recipient" text,
	"shipping_phone" text,
	"shipping_address" text,
	"shipping_latitude" numeric(10, 6),
	"shipping_longitude" numeric(10, 6),
	"shipping_address_source_id" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number"),
	CONSTRAINT "orders_walk_in_checkout_key_unique" UNIQUE("walk_in_checkout_key"),
	CONSTRAINT "orders_group_position_unique" UNIQUE("order_group_id","order_group_position"),
	CONSTRAINT "orders_sales_channel_valid" CHECK ("orders"."sales_channel" in ('STANDARD', 'WALK_IN')),
	CONSTRAINT "orders_delivery_method_valid" CHECK ("orders"."delivery_method" in ('INTERNAL', 'LALAMOVE', 'PICKUP', 'WALK_IN'))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"payment_number" varchar(32) NOT NULL,
	"order_id" integer NOT NULL,
	"customer_id" integer NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"payment_type" varchar(100),
	"payment_status" "payment_status" DEFAULT 'UNPAID' NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"refunded_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"reference_number" varchar(100),
	"version" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_payment_number_unique" UNIQUE("payment_number"),
	CONSTRAINT "unique_payment_number" UNIQUE("payment_number"),
	CONSTRAINT "payment_amount_check" CHECK ("payments"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_group_allocations" (
	"group_id" uuid NOT NULL,
	"payment_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	CONSTRAINT "payment_group_allocations_group_id_payment_id_pk" PRIMARY KEY("group_id","payment_id"),
	CONSTRAINT "payment_group_allocation_payment_unique" UNIQUE("payment_id"),
	CONSTRAINT "payment_group_allocation_nonnegative" CHECK ("payment_group_allocations"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_number" varchar(32) NOT NULL,
	"customer_id" integer NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"payment_type" varchar(100),
	"reference_number" varchar(100),
	"amount" numeric(12, 2) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_groups_payment_number_unique" UNIQUE("payment_number"),
	CONSTRAINT "payment_group_amount_positive" CHECK ("payment_groups"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_variants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"product_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"sku" varchar(255) NOT NULL,
	"description" varchar(255),
	"price" numeric(10, 2) NOT NULL,
	"unit" varchar(50) NOT NULL,
	"weight_kg" numeric(10, 2),
	"width_value" numeric(10, 2),
	"width_unit" varchar(10),
	"length_value" numeric(10, 2),
	"length_unit" varchar(10),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_product_id_sku_unique_idx" UNIQUE("product_id","sku")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "products_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(255) NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_name_unique_idx" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(255) NOT NULL,
	"value" varchar(255) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	CONSTRAINT "settings_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "customer_addresses" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customer_addresses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"customer_id" integer NOT NULL,
	"address_line" varchar NOT NULL,
	"barangay" varchar NOT NULL,
	"city_municipality" varchar NOT NULL,
	"province" varchar NOT NULL,
	"postal_code" varchar,
	"latitude" varchar,
	"longitude" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"company_name" varchar DEFAULT 'none' NOT NULL,
	"phone_number" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "drivers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"status" "driver_status" DEFAULT 'available' NOT NULL,
	"phone_number" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staffs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "staffs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"email" varchar NOT NULL,
	"name" varchar NOT NULL,
	"password_hash" varchar NOT NULL,
	"role" "role" NOT NULL,
	"refresh_token" varchar,
	"token_version" integer DEFAULT 0 NOT NULL,
	"last_login" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vehicles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"warehouse_id" integer NOT NULL,
	"plate_number" varchar(255) NOT NULL,
	"status" "vehicle_status_enum" DEFAULT 'available' NOT NULL,
	"type" "vehicle_type_enum" DEFAULT 'truck' NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	CONSTRAINT "vehicles_plate_number_unique" UNIQUE("plate_number")
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "warehouses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar NOT NULL,
	"phone_number" varchar(20),
	"street_address" varchar NOT NULL,
	"city" varchar NOT NULL,
	"state" varchar NOT NULL,
	"zip_code" varchar NOT NULL,
	"latitude" numeric,
	"longitude" numeric,
	"pickup_contact_name" varchar,
	"pickup_contact_phone" varchar,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archived_at" integer,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ws_logs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ws_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"session_id" varchar(255) NOT NULL,
	"user_id" integer NOT NULL,
	"action" varchar(255) NOT NULL,
	"payload" text NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ws_tickets" (
	"ticket_hash" text PRIMARY KEY NOT NULL,
	"claims" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_payments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "invoice_payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"invoice_id" integer NOT NULL,
	"payment_method" text NOT NULL,
	"payment_details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "invoices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"invoice_number" text NOT NULL,
	"order_id" integer NOT NULL,
	"customer_id" integer NOT NULL,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"issue_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "stock_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"inventory_id" integer NOT NULL,
	"order_id" integer,
	"actor_id" integer,
	"kind" text NOT NULL,
	"quantity_delta" integer NOT NULL,
	"reserved_delta" integer NOT NULL,
	"quantity_after" integer NOT NULL,
	"reserved_after" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_refunds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"payment_id" integer NOT NULL,
	"actor_id" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refunds_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "payment_refunds_amount_check" CHECK ("payment_refunds"."amount" > 0),
	CONSTRAINT "payment_refunds_reason_check" CHECK (length(trim("payment_refunds"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "vehicle_positions" (
	"vehicle_id" integer PRIMARY KEY NOT NULL,
	"longitude" double precision NOT NULL,
	"latitude" double precision NOT NULL,
	"speed_kph" double precision,
	"heading" double precision,
	"accuracy_m" double precision,
	"sample_interval_seconds" double precision,
	"recorded_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_receipts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_receipts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"payment_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"kind" text DEFAULT 'receipt' NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archives" ADD CONSTRAINT "archives_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_source_stop_id_deliveries_stops_id_fk" FOREIGN KEY ("source_stop_id") REFERENCES "public"."deliveries_stops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_assigned_delivery_id_deliveries_id_fk" FOREIGN KEY ("assigned_delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_collected_by_users_id_fk" FOREIGN KEY ("collected_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_driver_id_users_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deliveries_event" ADD CONSTRAINT "deliveries_event_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deliveries_expenses" ADD CONSTRAINT "deliveries_expenses_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deliveries_proof" ADD CONSTRAINT "deliveries_proof_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deliveries_stops" ADD CONSTRAINT "deliveries_stops_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deliveries_stops" ADD CONSTRAINT "deliveries_stops_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "delivery_notifications" ADD CONSTRAINT "delivery_notifications_stop_id_deliveries_stops_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."deliveries_stops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_notifications" ADD CONSTRAINT "delivery_notifications_booking_id_delivery_orders_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."delivery_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_stop_proofs" ADD CONSTRAINT "driver_stop_proofs_stop_id_deliveries_stops_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."deliveries_stops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_stop_proofs" ADD CONSTRAINT "driver_stop_proofs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_stop_outcomes" ADD CONSTRAINT "driver_stop_outcomes_stop_id_deliveries_stops_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."deliveries_stops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_stop_outcomes" ADD CONSTRAINT "driver_stop_outcomes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_sync_receipts" ADD CONSTRAINT "driver_sync_receipts_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_booked_by_users_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lalamove_provider_ids" ADD CONSTRAINT "lalamove_provider_ids_booking_id_delivery_orders_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."delivery_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lalamove_quotations" ADD CONSTRAINT "lalamove_quotations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lalamove_quotations" ADD CONSTRAINT "lalamove_quotations_booked_by_users_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_groups" ADD CONSTRAINT "order_groups_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_inventory_id_inventory_id_fk" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_order_group_id_order_groups_id_fk" FOREIGN KEY ("order_group_id") REFERENCES "public"."order_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_lalamove_pickup_warehouse_id_warehouses_id_fk" FOREIGN KEY ("lalamove_pickup_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payment_group_allocations" ADD CONSTRAINT "payment_group_allocations_group_id_payment_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."payment_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_group_allocations" ADD CONSTRAINT "payment_group_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_groups" ADD CONSTRAINT "payment_groups_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staffs" ADD CONSTRAINT "staffs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staffs" ADD CONSTRAINT "staffs_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ws_logs" ADD CONSTRAINT "ws_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_inventory_id_inventory_id_fk" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_positions" ADD CONSTRAINT "vehicle_positions_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "archives_delete_after_idx" ON "archives" USING btree ("delete_after");--> statement-breakpoint
CREATE INDEX "customer_return_warehouse_status" ON "customer_returns" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE INDEX "customer_return_delivery" ON "customer_returns" USING btree ("assigned_delivery_id");--> statement-breakpoint
CREATE INDEX "delivery_notification_status_idx" ON "delivery_notifications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "driver_proofs_stop_idx" ON "driver_stop_proofs" USING btree ("stop_id");--> statement-breakpoint
CREATE INDEX "driver_sync_receipts_actor_idx" ON "driver_sync_receipts" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lalamove_active_order_unique" ON "delivery_orders" USING btree ("order_id") WHERE "delivery_orders"."active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "lalamove_provider_order_unique" ON "delivery_orders" USING btree ("environment","market","lalamove_order_id");--> statement-breakpoint
CREATE INDEX "notifications_id_idx" ON "notifications" USING btree ("id");--> statement-breakpoint
CREATE INDEX "notifications_user_id_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_title_idx" ON "notifications" USING btree ("title");--> statement-breakpoint
CREATE INDEX "order_id_index" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "inventory_id_index" ON "order_items" USING btree ("inventory_id");--> statement-breakpoint
CREATE INDEX "orders_group_index" ON "orders" USING btree ("order_group_id");--> statement-breakpoint
CREATE INDEX "idx_payment_order_id" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_payment_customer_id" ON "payments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "product_variants_id_idx" ON "product_variants" USING btree ("id");--> statement-breakpoint
CREATE INDEX "products_id_idx" ON "products" USING btree ("id");--> statement-breakpoint
CREATE INDEX "products_name_idx" ON "products" USING btree ("name");--> statement-breakpoint
CREATE INDEX "ws_ticket_expiry_idx" ON "ws_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "stock_movements_inventory_created_idx" ON "stock_movements" USING btree ("inventory_id","id");