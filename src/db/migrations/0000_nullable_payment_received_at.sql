ALTER TABLE "payments" ALTER COLUMN "received_at" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "received_at" DROP DEFAULT;
