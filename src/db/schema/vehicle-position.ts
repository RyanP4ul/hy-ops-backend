import { doublePrecision, integer, pgTable, timestamp } from "drizzle-orm/pg-core";
import { vehicles } from "./vehicles";
export const vehicle_positions = pgTable("vehicle_positions", {
  vehicle_id: integer().primaryKey().references(() => vehicles.id, { onDelete: "cascade" }),
  longitude: doublePrecision().notNull(), latitude: doublePrecision().notNull(),
  speed_kph: doublePrecision(), heading: doublePrecision(), accuracy_m: doublePrecision(),
  sample_interval_seconds: doublePrecision(),
  recorded_at: timestamp({ withTimezone: true }).notNull(),
  received_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
