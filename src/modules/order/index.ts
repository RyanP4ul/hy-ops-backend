import Elysia, { t } from "elysia";
import { orderModel, savedShippingAddressSchema } from "./model";
import { OrderService } from "./service";
import { AuthUser } from "../auth/schema";
import { staffWarehouse, assertOrderScope } from "../deliveries/scope";
import { WorkflowError } from "../../utils/workflow-error";

export const orderRoutes = new Elysia({ prefix: "/orders" })
  .decorate("user", {} as AuthUser)
  .use(orderModel)
  .post("/customers/:customerId/addresses", ({ params, body }) =>
    OrderService.saveShippingAddress(params.customerId, body), {
    params: t.Object({ customerId: t.Numeric({ minimum: 1 }) }),
    body: savedShippingAddressSchema,
  })
  .get("/", async ({ query, set }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";
    const delivery_type = query.delivery_type ? query.delivery_type.trim() : "";
    const sort_by = query.sort_by ? String(query.sort_by) : "id:desc";

    const result = await OrderService.getOrders(
      page,
      limit,
      search,
      delivery_type,
      sort_by,
      query.status ?? "",
    );

    set.headers["X-Total-Count"] = result.total;

    return result.rows;
  })
  .get(
    "/:id",
    async ({ params }) => {
      const orderDetail = await OrderService.getOrderById(params.id);

      if (!orderDetail) {
        throw new WorkflowError("Order not found.", 404);
      }

      return orderDetail;
    },
    {
      params: t.Object({
        id: t.Numeric({ minimum: 1 }),
      }),
    },
  )
  .get("/groups/:groupId/ready", async ({ params, query, user }) => {
    const assigned = await staffWarehouse(user);
    if (assigned !== undefined && assigned !== query.warehouse_id) throw new WorkflowError("Choose your assigned warehouse.", 403);
    return OrderService.getReadyOrderGroup(params.groupId, assigned ?? query.warehouse_id);
  }, { params: t.Object({ groupId: t.String({ format: "uuid" }) }), query: t.Object({ warehouse_id: t.Numeric({ minimum: 1 }) }) })
  .get("/details", async ({ query }) => {
    const order_ids = query.ids ? query.ids.split(",").map(Number) : [];
    return await OrderService.getOrderDetailsByIds(order_ids);
  })
  .get(
    "/eligibility/:customerId",
    ({ params }) =>
      OrderService.getCustomerOrderEligibility(params.customerId),
    {
      params: t.Object({ customerId: t.Numeric({ minimum: 1 }) }),
    },
  )
  .put("/:id", ({ params, body }) => OrderService.updateNotes(params.id, body.version, body.notes), {
    params: t.Object({ id: t.Numeric({ minimum: 1 }) }), body: t.Object({ version: t.Integer({ minimum: 1 }), notes: t.String({ maxLength: 2000 }) }),
  })
  .put("/:id/destination", async ({ params, body, user }) => { await assertOrderScope(params.id, await staffWarehouse(user)); return OrderService.setDestination(params.id, body.version, body.latitude, body.longitude); }, {
    params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
    body: t.Object({ version: t.Integer({ minimum: 1 }), latitude: t.Number({ minimum: -90, maximum: 90 }), longitude: t.Number({ minimum: -180, maximum: 180 }) }),
  })
  .post("/batch", async ({ body, user }) => {
    const warehouseId = await staffWarehouse(user);
    if (warehouseId !== undefined && body.orders.some(order => order.warehouse_id !== warehouseId)) {
      throw new WorkflowError("All orders must use your assigned warehouse.", 403);
    }
    const created = await OrderService.createOrders(body);
    const rows = await Promise.all(created.map(order => OrderService.getOrderTableRowById(order.id)));
    if (rows.some(row => !row)) throw new Error("Failed to load created orders.");
    return { orders: rows, message: `${rows.length} orders created successfully.` };
  }, { body: "order.batch" })
  .post(
    "/",
    async ({ body, set }) => {
      const result = await OrderService.createOrder(body);
      const order = await OrderService.getOrderTableRowById(result.id);
      if (!order) throw new Error("Failed to load created order.");
      return order;
    },
    {
      body: "order.create",
    },
  )
  .post(
    "/process/:id",
    async ({ query, params }) => {
      const result = await OrderService.processOrder(params.id, query.version);
      const order = await OrderService.getOrderTableRowById(result.id);

      if (!order) throw new Error("Failed to load processed order.");

      return order;
    },
    {
      query: t.Object({
        version: t.Numeric({ minimum: 1 }),
      }),
      params: t.Object({
        id: t.Numeric({ minimum: 1 }),
      }),
    },
  )
  .post(
    "/delivery/:id",
    async ({ query, params }) => {
      const result = await OrderService.deliveryOrder(params.id, query.version);
      const order = await OrderService.getOrderTableRowById(result.id);

      if (!order) throw new Error("Failed to load delivery-ready order.");

      return order;
    },
    {
      query: t.Object({
        version: t.Numeric({ minimum: 1 }),
      }),
      params: t.Object({
        id: t.Numeric({ minimum: 1 }),
      }),
    },
  )
  .post(
    "/cancel/:id",
    async ({ query, params }) => {
      const result = await OrderService.cancelOrder(params.id, query.version);
      const order = await OrderService.getOrderTableRowById(result.id);

      if (!order) throw new Error("Failed to load cancelled order.");

      return order;
    },
    {
      query: t.Object({
        version: t.Numeric({ minimum: 1 }),
      }),
      params: t.Object({
        id: t.Numeric({ minimum: 1 }),
      }),
    },
  )
  // getAllOrderForCombobox
  .get("/cb", async ({ query, user }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";
    const warehouse_id = await staffWarehouse(user) ?? (query.warehouse_id ? parseInt(query.warehouse_id) : -1);

    const result = await OrderService.getAllOrderForCombobox(
      page,
      limit,
      search,
      warehouse_id,
    );

    return result;
  });
