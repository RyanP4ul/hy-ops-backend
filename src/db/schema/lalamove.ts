import { users } from "./users";
import { integer, pgTable, text, jsonb, numeric } from "drizzle-orm/pg-core";

// export const pod_enum = pgEnum("pod_enum", ["PENDING", "DELIVERED", "SIGNED", "FAILED"]);

export const delivery_orders = pgTable("delivery_orders", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  lalamove_order_id: text("lalamove_order_id").unique(),
  quotation_id: text("quotation_id").notNull(),

  booked_by: integer("booked_by")
    .notNull()
    .references(() => users.id),

  recipient_name: text("recipient_name").notNull(),
  recipient_phone: text("recipient_phone").notNull(),

  pickup_address: text("pickup_address").notNull(),
  dropoff_address: text("dropoff_address").notNull(),

  delivery_fee: numeric("delivery_fee", {
    precision: 12,
    scale: 2,
  }),

  currency: text("currency"),
  // status: pgEnum("status", ["PENDING", "DELIVERED", "SIGNED", "FAILED"]).notNull().default("PENDING"),
  status: text("status").notNull().default("PENDING"),

  lalamove_response: jsonb("lalamove_response"),

  created_at: integer()
    .notNull()
    .default(Math.floor(Date.now() / 1000)),
  updated_at: integer()
    .notNull()
    .default(Math.floor(Date.now() / 1000)),
});

export type DeliveryOrderInsert = typeof delivery_orders.$inferInsert;
export type DeliveryOrderSelect = typeof delivery_orders.$inferSelect;
