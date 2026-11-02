import { Elysia } from "elysia";
import { FiltersQuery } from "../reports.model";
import { parseFilters } from "../domain/filters";
import { getSales } from "../services/sales.service";

export const salesRoutes = new Elysia({ name: "reports.sales" }).get("/sales", ({ query }) => getSales(parseFilters(query)), {
  query: FiltersQuery,
  detail: { tags: ["Reports"], summary: "Sales KPIs, breakdowns and the orders table" },
});
