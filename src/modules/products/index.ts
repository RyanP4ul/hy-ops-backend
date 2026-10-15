import { Elysia, t } from "elysia";
import { ProductService } from "./service";
import { authPlugin } from "../../plugins/auth";
import { productModel } from "./model";
import { logger } from "../../utils/logger";
import { AuthUser } from "../auth/schema";
import { NotificationService } from "../notifications/service";

export const productRoutes = new Elysia({ prefix: "/products" })
  .decorate("user", AuthUser)
  .use(authPlugin)
  .use(productModel)
  .get("/", async ({ query, set }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 2;
    const search = query.search ? query.search.trim() : "";

    if (limit >= 50) limit = 50;

    const products = await ProductService.getProductByOffset(
      page,
      limit,
      search,
    );

    set.headers["X-Total-Count"] = products.total;

    return products.rows;
  })
  .get(
    "/:id",
    async ({ params, set }) => {
      const productId = Number(params.id);

      const product = await ProductService.getProductById(productId);

      if (!product) {
        set.status = 404;
        return {
          error: "Product not found",
        };
      }

      return product;
    },
    {
      params: t.Object({
        id: t.Number({ minimum: 1, max: 10 }),
      }),
    },
  )
  .get(
    "/variant/:variant_id",
    async ({ params, set, query }) => {
      const productId = Number(query.product_id);
      const variantId = Number(params.variant_id);

      const variant = await ProductService.getProductVariant(
        variantId,
        productId,
      );

      if (!variant) {
        set.status = 404;
        return {
          error: "Variant not found",
        };
      }

      return variant;
    },
    {
      params: t.Object({
        variant_id: t.Number({ minimum: 1, max: 10 }),
      }),
      query: t.Object({
        product_id: t.Number({ minimum: 1, max: 10 }),
      }),
    },
  )
  .post(
    "/",
    async ({ body, set, user }) => {
      const errors: Record<string, string> = {};

      const existingProduct = await ProductService.doesProductExistByName(
        body.name,
      );

      if (existingProduct) errors.name = "Name is already taken.";

      if (Object.keys(errors).length > 0) {
        set.status = 400;
        return {
          errors,
        };
      }

      const result = await ProductService.createProduct(body);

      if (!result) throw new Error("Failed to create product");

      // await NotificationService.createNotification(
      //   user.sub,
      //   "Product Created",
      //   `Product ${body.name} has been created.`,
      //   JSON.stringify(body),
      // );

      return result;
    },
    {
      body: "product.create",
    },
  )
  .put(
    "/:id",
    async ({ params, body, set }) => {
      const productId = Number(params.id);
      const errors: Record<string, string> = {};

      const product = await ProductService.getProductById(productId);

      if (!product) {
        set.status = 404;
        return {
          error: "Product not found",
        };
      }

      if (product.version !== body.version) {
        set.status = 400;
        return {
          error: "This product has been modified by another user.",
        };
      }

      if (product.name !== body.name) {
        const existingProduct = await ProductService.doesProductExistByName(
          body.name,
        );

        if (existingProduct) errors.name = "Name is already taken.";
      }

      if (Object.keys(errors).length > 0) {
        set.status = 400;
        return {
          errors,
        };
      }

      const result = await ProductService.updateProductById(productId, body);

      if (!result) {
        set.status = 400;
        return {
          error: "This product has been modified by another user.",
        };
      }

      return result;
    },
    {
      body: "product.update",
    },
  )
  .delete("/:id", async ({ params, query, set }) => {
    const product_id = Number(params.id);
    const version = Number(query.version);

    if (!Number.isInteger(product_id) || product_id <= 0) {
      set.status = 400;
      return {
        error: "Invalid product ID.",
      };
    }

    if (!Number.isInteger(version) || version < 0) {
      set.status = 400;
      return {
        error: "Invalid product version.",
      };
    }

    const result = await ProductService.deleteProductById(product_id, version);

    if (!result) {
      set.status = 400;
      return {
        error: "Failed to delete product.",
      };
    }

    return result;
  });
