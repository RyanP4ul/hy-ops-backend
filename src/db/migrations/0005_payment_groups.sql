CREATE TABLE "payment_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payment_number" varchar(32) NOT NULL UNIQUE,
  "customer_id" integer NOT NULL REFERENCES "customers"("id") ON DELETE RESTRICT,
  "payment_method" "payment_method" NOT NULL,
  "payment_type" varchar(100),
  "reference_number" varchar(100),
  "amount" numeric(12, 2) NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_group_amount_positive" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_group_allocations" (
  "group_id" uuid NOT NULL REFERENCES "payment_groups"("id") ON DELETE RESTRICT,
  "payment_id" integer NOT NULL REFERENCES "payments"("id") ON DELETE RESTRICT,
  "amount" numeric(12, 2) NOT NULL,
  PRIMARY KEY ("group_id", "payment_id"),
  CONSTRAINT "payment_group_allocation_payment_unique" UNIQUE ("payment_id"),
  CONSTRAINT "payment_group_allocation_nonnegative" CHECK ("amount" >= 0)
);
