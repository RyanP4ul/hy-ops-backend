import { Elysia } from "elysia";
import { CustomerParams, FiltersQuery } from "../reports.model";
import { parseFilters } from "../domain/filters";
import { getCustomerOrders, getCustomers } from "../services/customers.service";

export const customersRoutes = new Elysia({ name: "reports.customers" })
  .get("/customers", ({ query }) => getCustomers(parseFilters(query)), {
    query: FiltersQuery,
    detail: {
      tags: ["Reports"],
      summary: "Get customer report",
      description: "Retrieve customer performance for the selected filters.",
    },
  })
  .get("/customers/:id/orders", ({ params, query }) => getCustomerOrders(parseFilters(query), params.id), {
    params: CustomerParams,
    query: FiltersQuery,
    detail: {
      tags: ["Reports"],
      summary: "Get customer orders",
      description: "Retrieve one customer's orders for the selected period and filters.",
    },
  });
