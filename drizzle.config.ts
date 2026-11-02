import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is not set.");
}

export default defineConfig({
  dialect: "postgresql",
  strict: true,
  verbose: true,
  schema: "./src/db/schema",
  out: "./src/db/migrations",
  dbCredentials: {
    url: connectionString,
    ssl: "require",
  },
});
