import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const ws_tickets = pgTable("ws_tickets", {
  ticket_hash: text().primaryKey(),
  claims: jsonb().$type<Record<string, unknown>>().notNull(),
  expires_at: timestamp({ withTimezone: true }).notNull(),
}, table => [index("ws_ticket_expiry_idx").on(table.expires_at)]);
