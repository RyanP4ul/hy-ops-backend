import { Elysia } from "elysia";
import { FiltersQuery } from "../reports.model";
import { parseFilters } from "../domain/filters";
import { getOverview } from "../services/overview.service";

export const overviewRoutes = new Elysia({ name: "reports.overview" }).get("/overview", ({ query }) => getOverview(parseFilters(query)), {
  query: FiltersQuery,
  detail: {
    tags: ["Reports"],
    summary: "Get overview report",
    description: "Retrieve overview KPIs, revenue trends, and status breakdowns.",
  },
});
