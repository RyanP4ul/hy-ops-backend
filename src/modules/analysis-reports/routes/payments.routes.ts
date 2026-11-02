import { Elysia } from "elysia";
import { FiltersQuery } from "../reports.model";
import { parseFilters } from "../domain/filters";
import { getPayments } from "../services/payments.service";

export const paymentsRoutes = new Elysia({ name: "reports.payments" }).get("/payments", ({ query }) => getPayments(parseFilters(query)), {
  query: FiltersQuery,
  detail: { tags: ["Reports"], summary: "Receipt/refund cashflow, balances and receivables aging" },
});
