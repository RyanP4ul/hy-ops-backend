import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  strict: true,
  verbose: true,
  schema: "./src/db/schema",
  out: "./src/db/migrations",
  dbCredentials: {
    url: "postgresql://postgres:123@localhost:9519/hyops",
    ssl: false,
  },
});
