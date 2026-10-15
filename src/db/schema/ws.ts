import { integer, pgTable, text, varchar } from "drizzle-orm/pg-core";
import { users } from "./users";

export const ws_logs = pgTable("ws_logs", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  session_id: varchar({ length: 255 }).notNull(),
  user_id: integer()
    .notNull()
    .references(() => users.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  action: varchar({ length: 255 }).notNull(),
  payload: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
});

export type wsLogsInsert = typeof ws_logs.$inferInsert;
export type wsLogsSelect = typeof ws_logs.$inferSelect;

// type WebSocketLog = {
//   id: string;
//   sessionId: string;
//   userId: number | null;
//   action: string;
//   payload: unknown;
//   createdAt: number;
// };
