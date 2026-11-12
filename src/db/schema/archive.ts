import { integer, pgTable, text, varchar, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
  deletion_requested_at: integer(),
  delete_after: integer(),
  deletion_error: text(),
  deletion_last_attempt_at: integer(),
}, (t) => [
  index("archives_delete_after_idx").on(t.delete_after),
  check("archives_retention_valid", sql`(${t.deletion_requested_at} is null and ${t.delete_after} is null) or (${t.deletion_requested_at} is not null and ${t.delete_after} is not null and ${t.deletion_requested_at} >= ${t.archived_at} and ${t.delete_after} >= ${t.deletion_requested_at} + 2592000)`),
]);

export type archivesInsert = typeof archives.$inferInsert;
export type archivesSelect = typeof archives.$inferSelect;
