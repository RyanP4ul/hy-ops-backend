import { Elysia, t } from "elysia";
import { InventoryService } from "./service";
import { inventory_stock_status, inventoryModel } from "./model";
import { AuthUser } from "../auth/schema";
import { previewReconciliation, reconcileReservations } from "./reconciliation";

export const inventoryRoutes = new Elysia({ prefix: "/inventory" })
  .decorate("user", AuthUser)
  .use(inventoryModel)
  .get("/reconciliation", () => previewReconciliation())
  .post("/reconciliation", ({ body, user }) => reconcileReservations(body.token, body.reason, Number(user.sub)), {
    body: t.Object({ token: t.String({ minLength: 64, maxLength: 64 }), reason: t.String({ minLength: 1, maxLength: 500 }) }),
  })
  .get("/:id/movements", ({ params }) => InventoryService.getMovements(params.id), { params: t.Object({ id: t.Numeric({ minimum: 1 }) }) })
  .get("/reorder", ({ query }) => InventoryService.getReorderSuggestions(query.warehouse_id ?? null), { query: t.Object({ warehouse_id: t.Optional(t.Numeric({ minimum: 1 })) }) })
  .get("/summary", ({ query }) => InventoryService.getSummary(query.warehouse_id ? Number(query.warehouse_id) : null), {
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
  })
  .get("/:id", async ({ params }) => {
    const id = parseInt(params.id);
    return await InventoryService.getInventoryById(id);
  })
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
      body: "inventory.update",
    },
  )
  .delete("/:id", async ({ params, query, set }) => {
    const id = parseInt(params.id);
    const version = parseInt(query.version) || -1;

    return await InventoryService.deleteInventory(id, version);
  })
  .get("/names", async ({ query }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const warehouse_id = query.warehouse_id ? parseInt(query.warehouse_id) : -1;
    return await InventoryService.getInventoryNames(page, limit, warehouse_id);
  })
  .get("/details", async ({ query }) => {
    const order_ids = query.ids ? query.ids.split(",").map(Number) : [];
    return await InventoryService.getInventoryDetailById(order_ids);
  });
