import { logger } from "../../utils/logger";
import { ArchiveService } from "../archives/service";
import { AuthUser } from "../auth/schema";
import { warehouseModel } from "./model";
import { WarehouseService, warehouseService } from "./service";
import Elysia, { t } from "elysia";

export const warehouseRoutes = new Elysia({ prefix: "/warehouses" })
  .use(warehouseModel)
  .decorate("user", AuthUser)
  .get("/", async ({ query, set }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";
    const sort_by = query.sort_by ? String(query.sort_by) : "id:desc";

    const result = await warehouseService.getWarehouses(
      page,
      limit,
      search,
      sort_by,
    );
    set.headers["X-Total-Count"] = result.total;
    return result.rows;
  })
  .get("/names", async ({ query, set }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";

    const result = await warehouseService.getWarehouseNames(
      page,
      limit,
      search,
    );
    return result;
  })
  .get("/:id", async ({ params, set }) => {
    const warehouse = await warehouseService.getWarehouseById(
      Number(params.id),
    );
    if (!warehouse) {
      set.status = 404;
      return { message: "Warehouse not found" };
    }
    return warehouse;
  })
  .post(
    "/",
    async ({ body, set }) => {
      const result = await warehouseService.createWarehouse(body);

      if ("errors" in result) {
        set.status = 400;
        return { errors: result.errors };
      }

      return result;
    },
    {
      body: "warehouse.create",
    },
  )
  .put(
    "/:id",
    async ({ params, body, set }) => {
      const result = await warehouseService.updateWarehouse(
        Number(params.id),
        body,
      );

      if ("errors" in result) {
        set.status = 400;
        return { errors: result.errors };
      }

      return result;
    },
    {
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      body: "warehouse.update",
    },
  )
  .delete(
    "/:id",
    async ({ query, params }) => {
      return await warehouseService.deleteWarehouse(
        Number(params.id),
        Number(query.version || 0),
      );
    },
    { params: t.Object({ id: t.Numeric({ minimum: 1 }) }) },
  )
  .post(
    "/:id/archive",
    async ({ query, params, user }) => {
      // CHECK IF WAREHOUSE EXISTS
      // OPTIMISIC LOCKING

      return await WarehouseService.archiveWarehouse(
        user.sub,
        Number(params.id),
        Number(query.version || 0),
      );
    },
    { params: t.Object({ id: t.Numeric({ minimum: 1 }) }) },
  );
