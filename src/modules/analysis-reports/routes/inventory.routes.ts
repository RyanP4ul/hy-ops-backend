import { Elysia } from "elysia";
import { FiltersQuery } from "../reports.model";
import { parseFilters } from "../domain/filters";
import { getInventory } from "../services/inventory.service";

export const inventoryRoutes = new Elysia({ name: "reports.inventory" }).get("/inventory", ({ query }) => getInventory(parseFilters(query)), {
  query: FiltersQuery,
  detail: { tags: ["Reports"], summary: "Stock levels, units sold and last-sold date" },
});
