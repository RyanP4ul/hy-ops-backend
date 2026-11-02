import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set.");
}

const client = postgres(connectionString, { prepare: false });

export const db = drizzle({
  client: client,
  schema,
  logger: process.env.NODE_ENV === "development" && process.env.DEBUG_SQL === "true",
});
