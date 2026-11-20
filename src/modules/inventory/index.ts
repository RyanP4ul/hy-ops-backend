import { Elysia, t } from "elysia";
import { InventoryService } from "./service";
import { inventory_stock_status, inventoryModel } from "./model";
import { AuthUser } from "../auth/schema";
import { previewReconciliation, reconcileReservations } from "./reconciliation";
import { StockTransferService } from "./transfers";
import { staffWarehouse } from "../deliveries/scope";

function parseInventoryIds(value: string | undefined) {
  return value?.split(",").map(Number).filter(id => Number.isInteger(id) && id > 0 && id <= 2_147_483_647);
}

export const inventoryRoutes = new Elysia({ prefix: "/inventory" })
  .decorate("user", {} as AuthUser)
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
  .get("/transfers", async ({ user }) => StockTransferService.list(await staffWarehouse(user)), {
    detail: { summary: "List inter-warehouse stock transfers", tags: ["Inventory"] },
  })
  .post(
    "/transfers",
    async ({ body, user }) =>
      StockTransferService.create(body, Number(user.sub), await staffWarehouse(user)),
    {
      body: t.Object({
        from_warehouse_id: t.Integer({ minimum: 1 }),
        to_warehouse_id: t.Integer({ minimum: 1 }),
        notes: t.Optional(t.String({ maxLength: 500 })),
        items: t.Array(
          t.Object({
            product_variant_id: t.Integer({ minimum: 1 }),
            quantity: t.Integer({ minimum: 1 }),
          }),
          { minItems: 1 },
        ),
      }),
      detail: { summary: "Create an inter-warehouse stock transfer", tags: ["Inventory"] },
    },
  )
  .post(
    "/transfers/:id/dispatch",
    async ({ params, body, user }) =>
      StockTransferService.dispatch(
        params.id,
        body.version,
        Number(user.sub),
        await staffWarehouse(user),
      ),
    {
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      body: t.Object({ version: t.Integer({ minimum: 1 }) }),
      detail: { summary: "Dispatch a stock transfer from source warehouse", tags: ["Inventory"] },
    },
  )
  .post(
    "/transfers/:id/receive",
    async ({ params, body, user }) =>
      StockTransferService.receive(
        params.id,
        body.version,
        Number(user.sub),
        await staffWarehouse(user),
      ),
    {
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      body: t.Object({ version: t.Integer({ minimum: 1 }) }),
      detail: { summary: "Receive an in-transit stock transfer at destination warehouse", tags: ["Inventory"] },
    },
  )
  .post(
    "/transfers/:id/cancel",
    async ({ params, body, user }) =>
      StockTransferService.cancel(params.id, body.version, await staffWarehouse(user)),
    {
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      body: t.Object({ version: t.Integer({ minimum: 1 }) }),
      detail: { summary: "Cancel a draft stock transfer", tags: ["Inventory"] },
    },
  )
  .get("/", async ({ query, set, user }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";
    const from = query.from ? parseInt(query.from) : null;
    const to = query.to ? parseInt(query.to) : null;

    const stock_status = (
      query.stock_status ? query.stock_status.trim().toLowerCase() : "all"
    ) as inventory_stock_status;

    const warehouse_id = await staffWarehouse(user) ?? (query.warehouse_id
      ? parseInt(query.warehouse_id)
      : null);

    if (limit >= 50) limit = 50;

    const inventory = await InventoryService.getProductByOffset(
      page,
      limit,
      search,
      stock_status,
      warehouse_id,
      from,
      to,
      query.active_only === "true",
      { include: parseInventoryIds(query.ids), exclude: parseInventoryIds(query.exclude_ids) },
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
  .get("/names", async ({ query, user }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const warehouse_id = await staffWarehouse(user) ?? (query.warehouse_id ? parseInt(query.warehouse_id) : -1);
    return await InventoryService.getInventoryNames(page, limit, warehouse_id);
  }, { detail: { summary: 'Get names', description: 'GET endpoint for names in the inventory module.', tags: ['Inventory'] } })
  .get("/details", async ({ query, user }) => {
    const order_ids = query.ids ? query.ids.split(",").map(Number) : [];
    return await InventoryService.getInventoryDetailById(order_ids, await staffWarehouse(user));
  }, { detail: { summary: 'Get details', description: 'GET endpoint for details in the inventory module.', tags: ['Inventory'] } });
