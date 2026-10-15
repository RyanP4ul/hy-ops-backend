import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index";

const pool = new Pool({
  connectionString:
    process.env.DB_URL || "postgresql://postgres:123@localhost:9519/hyops",
});

export const db = drizzle({
  client: pool,
  schema,
  // logger: process.env.NODE_ENV === "development",
});
