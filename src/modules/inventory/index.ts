import { Elysia, t } from "elysia";
import { InventoryService } from "./service";
import { inventory_stock_status, inventoryModel } from "./model";
import { AuthUser } from "../auth/schema";
import { previewReconciliation, reconcileReservations } from "./reconciliation";

export const inventoryRoutes = new Elysia({ prefix: "/inventory" })
  .decorate("user", AuthUser)
  .use(inventoryModel)
  .get("/reconciliation", () => previewReconciliation(), { detail: { summary: 'Get reconciliation', description: 'GET endpoint for reconciliation in the inventory module.', tags: ['Inventory'] } })
  .post("/reconciliation", ({ body, user }) => reconcileReservations(body.token, body.reason, Number(user.sub)), {
      detail: { summary: 'Create reconciliation', description: 'POST endpoint for reconciliation in the inventory module.', tags: ['Inventory'] },
    body: t.Object({ token: t.String({ minLength: 64, maxLength: 64 }), reason: t.String({ minLength: 1, maxLength: 500 }) }),
  })
  .get("/:id/movements", ({ params }) => InventoryService.getMovements(params.id), {
      detail: { summary: 'Get by id movements', description: 'GET endpoint for by id movements in the inventory module.', tags: ['Inventory'] }, params: t.Object({ id: t.Numeric({ minimum: 1 }) }) })
  .get("/reorder", ({ query }) => InventoryService.getReorderSuggestions(query.warehouse_id ?? null), {
      detail: { summary: 'Get reorder', description: 'GET endpoint for reorder in the inventory module.', tags: ['Inventory'] }, query: t.Object({ warehouse_id: t.Optional(t.Numeric({ minimum: 1 })) }) })
  .get("/summary", ({ query }) => InventoryService.getSummary(query.warehouse_id ? Number(query.warehouse_id) : null), {
      detail: { summary: 'Get summary', description: 'GET endpoint for summary in the inventory module.', tags: ['Inventory'] },
    query: t.Object({ warehouse_id: t.Optional(t.Numeric({ minimum: 1 })) }),
  })
  .get("/", async ({ query, set }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";
    const from = query.from ? parseInt(query.from) : null;
    const to = query.to ? parseInt(query.to) : null;

    const stock_status = (
      query.stock_status ? query.stock_status.trim().toLowerCase() : "all"
    ) as inventory_stock_status;

    const warehouse_id = query.warehouse_id
      ? parseInt(query.warehouse_id)
      : null;

    if (limit >= 50) limit = 50;

    const inventory = await InventoryService.getProductByOffset(
      page,
      limit,
      search,
      stock_status,
      warehouse_id,
      from,
      to,
    );

    set.headers["X-Total-Count"] = inventory.total;

    return inventory.rows;
  }, { detail: { summary: 'List root', description: 'GET endpoint for root in the inventory module.', tags: ['Inventory'] } })
  .get("/:id", async ({ params }) => {
    const id = parseInt(params.id);
    return await InventoryService.getInventoryById(id);
  }, { detail: { summary: 'Get by id', description: 'GET endpoint for by id in the inventory module.', tags: ['Inventory'] } })
  .post(
    "/",
    async ({ body }) => {
      const result = await InventoryService.createInventory({
        ...body,
      });

      const inventory = await InventoryService.getInventoryTableRowById(
        result[0].id,
      );

      if (!inventory) throw new Error("Failed to load created inventory.");

      return inventory;
    },
    {
      detail: { summary: 'Create root', description: 'POST endpoint for root in the inventory module.', tags: ['Inventory'] },
      body: "inventory.create",
    },
  )
  .put(
    "/:id",
    async ({ params, body, user }) => {
      const id = parseInt(params.id);

      await InventoryService.updateInventory(id, {
        ...body,
      }, Number(user.sub));

      const inventory = await InventoryService.getInventoryTableRowById(id);

      if (!inventory) throw new Error("Failed to load updated inventory.");

      return inventory;
    },
    {
      detail: { summary: 'Update by id', description: 'PUT endpoint for by id in the inventory module.', tags: ['Inventory'] },
      body: "inventory.update",
    },
  )
  .delete("/:id", async ({ params, query, set }) => {
    const id = parseInt(params.id);
    const version = parseInt(query.version) || -1;

    return await InventoryService.deleteInventory(id, version);
  }, { detail: { summary: 'Delete by id', description: 'DELETE endpoint for by id in the inventory module.', tags: ['Inventory'] } })
  .get("/names", async ({ query }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const warehouse_id = query.warehouse_id ? parseInt(query.warehouse_id) : -1;
    return await InventoryService.getInventoryNames(page, limit, warehouse_id);
  }, { detail: { summary: 'Get names', description: 'GET endpoint for names in the inventory module.', tags: ['Inventory'] } })
  .get("/details", async ({ query }) => {
    const order_ids = query.ids ? query.ids.split(",").map(Number) : [];
    return await InventoryService.getInventoryDetailById(order_ids);
  }, { detail: { summary: 'Get details', description: 'GET endpoint for details in the inventory module.', tags: ['Inventory'] } });
