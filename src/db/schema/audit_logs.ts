import { integer, pgTable, text, varchar } from "drizzle-orm/pg-core";
import { users } from "./users";

export const audit_logs = pgTable("audit_logs", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  user_id: integer()
    .notNull()
    .references(() => users.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  action: varchar({ length: 255 }).notNull(),
  entity_id: varchar({ length: 255 }).notNull(),
  entity_type: varchar({ length: 255 }).notNull(),
  description: text().notNull(),
  old_value: text().notNull(),
  new_value: text().notNull(),
  metadata: text().notNull(),
  ip_address: varchar({ length: 255 }).notNull(),
  user_agent: varchar({ length: 255 }).notNull(),
  created_at: integer().notNull(),
});

export type auditLogsInsert = typeof audit_logs.$inferInsert;
export type auditLogsSelect = typeof audit_logs.$inferSelect;
