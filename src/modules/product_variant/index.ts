import Elysia from "elysia";
import { ProductVariantService } from "./service";

export const productVariantRoutes = new Elysia({
  prefix: "/product_variants",
}).get("/", async ({ query }) => {
  const page = query.page ? parseInt(query.page) : 1;
  const limit = query.limit ? parseInt(query.limit) : 10;
  const search = query.search ? query.search.trim() : "";

  return await ProductVariantService.getProductVariants(page, limit, search);
});
