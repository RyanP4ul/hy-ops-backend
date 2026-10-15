import { Elysia, t } from "elysia";
import { InventoryService } from "./service";
import { inventory_stock_status, inventoryModel } from "./model";

export const inventoryRoutes = new Elysia({ prefix: "/inventory" })
  .use(inventoryModel)
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
      return await InventoryService.createInventory({
        ...body,
      });
    },
    {
      body: "inventory.create",
    },
  )
  .put(
    "/:id",
    async ({ params, body }) => {
      const id = parseInt(params.id);

      return await InventoryService.updateInventory(id, {
        ...body,
      });
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
  .get("/names", async () => {
    return await InventoryService.getInventoryNames();
  });
