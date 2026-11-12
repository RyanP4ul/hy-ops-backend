import { activeWarehouse } from "../lifecycle/availability";
import { staffWarehouse } from "../deliveries/scope";
import { db } from "../../db";
import { warehouses } from "../../db/schema/warehouses";
import { and, eq } from "drizzle-orm";
import { logger } from "../../utils/logger";
import { ArchiveService } from "../archives/service";
import { AuthUser } from "../auth/schema";
import { warehouseModel } from "./model";
import { WarehouseService, warehouseService } from "./service";
import Elysia, { t } from "elysia";

export const warehouseRoutes = new Elysia({ prefix: "/warehouses" })
  .use(warehouseModel)
  .decorate("user", {} as AuthUser)
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
  }, { detail: { summary: 'List root', description: 'GET endpoint for root in the warehouses module.', tags: ['Warehouses'] } })
  .get("/names", async ({ query, set, user }) => {
    const scope = await staffWarehouse(user);
    if (scope !== undefined) {
      const rows = await db.select().from(warehouses).where(and(eq(warehouses.id, scope), activeWarehouse()));
      return { rows, total: rows.length };
    }
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";

    const result = await warehouseService.getWarehouseNames(
      page,
      limit,
      search,
    );
    return result;
  }, { detail: { summary: 'Get names', description: 'GET endpoint for names in the warehouses module.', tags: ['Warehouses'] } })
  .get("/:id", async ({ params, set }) => {
    const warehouse = await warehouseService.getWarehouseById(
      Number(params.id),
    );
    if (!warehouse) {
      set.status = 404;
      return { message: "Warehouse not found" };
    }
    return warehouse;
  }, { detail: { summary: 'Get by id', description: 'GET endpoint for by id in the warehouses module.', tags: ['Warehouses'] } })
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
      detail: { summary: 'Create root', description: 'POST endpoint for root in the warehouses module.', tags: ['Warehouses'] },
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
      detail: { summary: 'Update by id', description: 'PUT endpoint for by id in the warehouses module.', tags: ['Warehouses'] },
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
    {
      detail: { summary: 'Delete by id', description: 'DELETE endpoint for by id in the warehouses module.', tags: ['Warehouses'] }, params: t.Object({ id: t.Numeric({ minimum: 1 }) }) },
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
        Number(user.token_version),
      );
    },
    {
      detail: { summary: 'Create by id archive', description: 'POST endpoint for by id archive in the warehouses module.', tags: ['Warehouses'] }, params: t.Object({ id: t.Numeric({ minimum: 1 }) }) },
  );
