import Elysia, { t } from "elysia";
import { ProductVariantService } from "./service";

export const productVariantRoutes = new Elysia({
  prefix: "/product_variants",
}).get("/", async ({ query }) => {
  const page = query.page ? parseInt(query.page) : 1;
  const limit = query.limit ? parseInt(query.limit) : 10;
  const search = query.search ? query.search.trim() : "";

  return await ProductVariantService.getProductVariants(page, limit, search, query.exclude_inventory_warehouse_id);
}, { query: t.Object({
  page: t.Optional(t.String({ pattern: "^[0-9]+$" })),
  limit: t.Optional(t.String({ pattern: "^[1-9][0-9]*$" })),
  search: t.Optional(t.String()),
  exclude_inventory_warehouse_id: t.Optional(t.Numeric({ minimum: 1, multipleOf: 1 })),
}) });
