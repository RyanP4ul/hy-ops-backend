import { Elysia } from "elysia";
import { CustomerParams, FiltersQuery } from "../reports.model";
import { parseFilters } from "../domain/filters";
import { getCustomerOrders, getCustomers } from "../services/customers.service";

export const customersRoutes = new Elysia({ name: "reports.customers" })
  .get("/customers", ({ query }) => getCustomers(parseFilters(query)), {
    query: FiltersQuery,
    detail: { tags: ["Reports"], summary: "Customer performance table" },
  })
  .get("/customers/:id/orders", ({ params, query }) => getCustomerOrders(parseFilters(query), params.id), {
    params: CustomerParams,
    query: FiltersQuery,
    detail: { tags: ["Reports"], summary: "One customer's orders for the current period and filters" },
  });
