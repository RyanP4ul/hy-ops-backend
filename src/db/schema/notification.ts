import {
  integer,
  pgTable,
  text,
  varchar,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

export const notifications = pgTable(
  "notifications",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    user_id: integer()
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    title: varchar({ length: 255 }).notNull(),
    message: text().notNull(),
    type: varchar({ length: 50 }).notNull(),
    is_read: boolean().notNull().default(false),
    created_at: integer()
      .notNull()
      .default(Math.floor(Date.now() / 1000)),
  },
  (t) => [
    index("notifications_id_idx").on(t.id),
    index("notifications_user_id_idx").on(t.user_id),
    index("notifications_title_idx").on(t.title),
    uniqueIndex("notifications_user_title_unread_idx")
      .on(t.user_id, t.title)
      .where(sql`${t.is_read} = false`),
  ],
);

export type NotificationInsert = typeof notifications.$inferInsert;
export type NotificationSelect = typeof notifications.$inferSelect;
