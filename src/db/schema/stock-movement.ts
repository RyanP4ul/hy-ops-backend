import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { inventory } from "./inventory";
import { users } from "./users";

export const stock_movements = pgTable("stock_movements", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  inventory_id: integer().notNull().references(() => inventory.id, { onDelete: "restrict" }),
  order_id: integer(),
  actor_id: integer().references(() => users.id, { onDelete: "restrict" }),
  kind: text().notNull(),
  quantity_delta: integer().notNull(),
  reserved_delta: integer().notNull(),
  quantity_after: integer().notNull(),
  reserved_after: integer().notNull(),
  reason: text().notNull(),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("stock_movements_inventory_created_idx").on(table.inventory_id, table.id)]);
