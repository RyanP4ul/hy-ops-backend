CREATE TYPE "public"."calendar_event_enum" AS ENUM('DELIVERY', 'ORDER_FULFILLMENT', 'INVENTORY_WAREHOUSE', 'VEHICLE_MAINTENANCE', 'STAFF_SCHEDULE', 'MEETING_APPOINTMENT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."deliveries_event_type" AS ENUM('CANCELLED', 'RESCHEDULED', 'DELAYED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."deliveries_orders_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."deliveries_status" AS ENUM('scheduled', 'in_transit', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."delivery_type" AS ENUM('LALAMOVE', 'PICKUP', 'INTERNAL');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('PENDING', 'PROCESSING', 'SCHEDULING', 'READY_FOR_DELIVERY', 'SCHEDULED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_arrangement" AS ENUM('FULLY_PAID', 'PARTIALLY_PAID', 'PAY_ON_DELIVERY', 'NET_30');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'BANK_TRANSFER', 'CARD');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE');--> statement-breakpoint
CREATE TYPE "public"."driver_status" AS ENUM('available', 'unavailable', 'day_off', 'on_delivery', 'on_break', 'on_leave', 'on_accident', 'on_personal_leave', 'on_sick_leave');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'staff', 'customer', 'driver');--> statement-breakpoint
CREATE TYPE "public"."vehicle_status_enum" AS ENUM('available', 'unavailable', 'maintenance', 'on_delivery');--> statement-breakpoint
CREATE TYPE "public"."vehicle_type_enum" AS ENUM('truck', 'van', 'other');--> statement-breakpoint
CREATE TABLE "archives" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "archives_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"entity_id" varchar(255) NOT NULL,
	"entity_type" varchar(255) NOT NULL,
	"archived_by" integer NOT NULL,
	"archived_at" integer NOT NULL
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
CREATE TABLE "deliveries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"driver_id" integer NOT NULL,
	"vehicle_id" integer NOT NULL,
	"scheduled_date" date NOT NULL,
	"departure_time" time NOT NULL,
	"delivery_type" "delivery_type" DEFAULT 'INTERNAL' NOT NULL,
	"status" "deliveries_status" DEFAULT 'scheduled' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unique_delivery" UNIQUE("driver_id","scheduled_date","departure_time")
);
--> statement-breakpoint
CREATE TABLE "deliveries_event" (
	"delivery_id" integer NOT NULL,
	"event_type" "deliveries_event_type" NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries_orders" (
	"delivery_id" integer NOT NULL,
	"order_id" integer NOT NULL,
	"status" "deliveries_orders_status" DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
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
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	CONSTRAINT "inventory_warehouse_product_id_product_variant_id_unique_idx" UNIQUE("warehouse_id","product_id","product_variant_id")
);
--> statement-breakpoint
CREATE TABLE "delivery_orders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "delivery_orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
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
	"created_at" integer DEFAULT 1792245359 NOT NULL,
	"updated_at" integer DEFAULT 1792245359 NOT NULL,
	CONSTRAINT "delivery_orders_lalamove_order_id_unique" UNIQUE("lalamove_order_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"type" varchar(50) NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" integer DEFAULT 1792245359 NOT NULL,
	CONSTRAINT "notifications_user_title_unique_idx" UNIQUE("user_id","title")
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"inventory_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_inventory_unique" UNIQUE("order_id","inventory_id"),
	CONSTRAINT "quantity_check" CHECK (quantity > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_number" varchar(32) NOT NULL,
	"customer_id" integer NOT NULL,
	"payment_arrangement" "payment_arrangement" DEFAULT 'NET_30',
	"notes" text,
	"status" "order_status" DEFAULT 'PENDING' NOT NULL,
	"shipping_recipient" text,
	"shipping_phone" text,
	"shipping_address" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"payment_number" varchar(32) NOT NULL,
	"order_id" integer NOT NULL,
	"customer_id" integer NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"payment_status" "payment_status" DEFAULT 'UNPAID' NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"reference_number" varchar(100),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_payment_number_unique" UNIQUE("payment_number"),
	CONSTRAINT "unique_payment_number" UNIQUE("payment_number"),
	CONSTRAINT "payment_amount_check" CHECK ("payments"."amount" >= 0)
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
CREATE TABLE "customers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"company_name" varchar DEFAULT 'none' NOT NULL,
	"address" varchar NOT NULL,
	"phone_number" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "drivers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"status" "driver_status" DEFAULT 'available' NOT NULL,
	"phone_number" varchar NOT NULL
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
	"plate_number" varchar(255) NOT NULL,
	"status" "vehicle_status_enum" DEFAULT 'available' NOT NULL,
	"type" "vehicle_type_enum" DEFAULT 'truck' NOT NULL,
	"image" varchar(255) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" integer NOT NULL,
	CONSTRAINT "vehicles_plate_number_unique" UNIQUE("plate_number")
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "warehouses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar NOT NULL,
	"street_address" varchar NOT NULL,
	"city" varchar NOT NULL,
	"state" varchar NOT NULL,
	"zip_code" varchar NOT NULL,
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
ALTER TABLE "archives" ADD CONSTRAINT "archives_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_driver_id_users_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deliveries_event" ADD CONSTRAINT "deliveries_event_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deliveries_orders" ADD CONSTRAINT "deliveries_orders_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deliveries_orders" ADD CONSTRAINT "deliveries_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_booked_by_users_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_inventory_id_inventory_id_fk" FOREIGN KEY ("inventory_id") REFERENCES "public"."inventory"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ws_logs" ADD CONSTRAINT "ws_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "notifications_id_idx" ON "notifications" USING btree ("id");--> statement-breakpoint
CREATE INDEX "notifications_user_id_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_title_idx" ON "notifications" USING btree ("title");--> statement-breakpoint
CREATE INDEX "order_id_index" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "inventory_id_index" ON "order_items" USING btree ("inventory_id");--> statement-breakpoint
CREATE INDEX "idx_payment_order_id" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_payment_customer_id" ON "payments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "product_variants_id_idx" ON "product_variants" USING btree ("id");--> statement-breakpoint
CREATE INDEX "products_id_idx" ON "products" USING btree ("id");--> statement-breakpoint
CREATE INDEX "products_name_idx" ON "products" USING btree ("name");