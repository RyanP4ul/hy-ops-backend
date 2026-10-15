import { integer, pgTable, text, varchar, jsonb } from "drizzle-orm/pg-core";
import { users } from "./users";

export const archives = pgTable("archives", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  entity_id: varchar({ length: 255 }).notNull(),
  entity_type: varchar({ length: 255 }).notNull(),
  archived_by: integer()
    .notNull()
    .references(() => users.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  archived_at: integer().notNull(),
});

export type archivesInsert = typeof archives.$inferInsert;
export type archivesSelect = typeof archives.$inferSelect;
