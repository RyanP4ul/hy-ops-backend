import { Elysia } from "elysia";
import { FiltersQuery } from "../reports.model";
import { parseFilters } from "../domain/filters";
import { getDeliveries } from "../services/deliveries.service";

export const deliveriesRoutes = new Elysia({ name: "reports.deliveries" }).get("/deliveries", ({ query }) => getDeliveries(parseFilters(query)), {
  query: FiltersQuery,
  detail: {
    tags: ["Reports"],
    summary: "Get deliveries report",
    description: "Retrieve delivery KPIs, breakdowns, and delivery issues.",
  },
});
