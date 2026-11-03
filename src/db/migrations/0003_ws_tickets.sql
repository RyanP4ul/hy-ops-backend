CREATE TABLE "ws_tickets" (
	"ticket_hash" text PRIMARY KEY NOT NULL,
	"claims" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ws_ticket_expiry_idx" ON "ws_tickets" USING btree ("expires_at");
