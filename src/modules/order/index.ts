import Elysia, { t } from "elysia";
import { orderModel, savedShippingAddressSchema } from "./model";
import { OrderService } from "./service";
import { AuthUser } from "../auth/schema";
import { staffWarehouse, assertOrderScope } from "../deliveries/scope";
import { WorkflowError } from "../../utils/workflow-error";
import { LalamoveService } from "../lalamove/service";

export const orderRoutes = new Elysia({ prefix: "/orders" })
  .decorate("user", {} as AuthUser)
  .use(orderModel)
  .get("/:id/lalamove", ({ params, user }) => LalamoveService.context(params.id, user), { params: t.Object({ id: t.Numeric({ minimum: 1 }) }) })
  .post("/customers/:customerId/addresses", ({ params, body }) =>
    OrderService.saveShippingAddress(params.customerId, body), {
      detail: { summary: 'Create customers by customerId addresses', description: 'POST endpoint for customers by customerId addresses in the orders module.', tags: ['Orders'] },
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
  }, { detail: { summary: 'List root', description: 'GET endpoint for root in the orders module.', tags: ['Orders'] } })
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
      detail: { summary: 'Get by id', description: 'GET endpoint for by id in the orders module.', tags: ['Orders'] },
      params: t.Object({
        id: t.Numeric({ minimum: 1 }),
      }),
    },
  )
  .get("/groups/:groupId/ready", async ({ params, query, user }) => {
    const assigned = await staffWarehouse(user);
    if (assigned !== undefined && assigned !== query.warehouse_id) throw new WorkflowError("Choose your assigned warehouse.", 403);
    return OrderService.getReadyOrderGroup(params.groupId, assigned ?? query.warehouse_id);
  }, {
      detail: { summary: 'Get groups by groupId ready', description: 'GET endpoint for groups by groupId ready in the orders module.', tags: ['Orders'] }, params: t.Object({ groupId: t.String({ format: "uuid" }) }), query: t.Object({ warehouse_id: t.Numeric({ minimum: 1 }) }) })
  .get("/details", async ({ query }) => {
    const order_ids = query.ids ? query.ids.split(",").map(Number) : [];
    return await OrderService.getOrderDetailsByIds(order_ids);
  }, { detail: { summary: 'Get details', description: 'GET endpoint for details in the orders module.', tags: ['Orders'] } })
  .get(
    "/eligibility/:customerId",
    ({ params }) =>
      OrderService.getCustomerOrderEligibility(params.customerId),
    {
      detail: { summary: 'Get eligibility by customerId', description: 'GET endpoint for eligibility by customerId in the orders module.', tags: ['Orders'] },
      params: t.Object({ customerId: t.Numeric({ minimum: 1 }) }),
    },
  )
  .put("/:id", ({ params, body }) => OrderService.updateNotes(params.id, body.version, body.notes), {
      detail: { summary: 'Update by id', description: 'PUT endpoint for by id in the orders module.', tags: ['Orders'] },
    params: t.Object({ id: t.Numeric({ minimum: 1 }) }), body: t.Object({ version: t.Integer({ minimum: 1 }), notes: t.String({ maxLength: 2000 }) }),
  })
  .put("/:id/destination", async ({ params, body, user }) => { await assertOrderScope(params.id, await staffWarehouse(user)); return OrderService.setDestination(params.id, body.version, body.latitude, body.longitude); }, {
      detail: { summary: 'Update by id destination', description: 'PUT endpoint for by id destination in the orders module.', tags: ['Orders'] },
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
  }, {
      detail: { summary: 'Create batch', description: 'POST endpoint for batch in the orders module.', tags: ['Orders'] }, body: "order.batch" })
  .post(
    "/walk-in",
    async ({ body, user }) => {
      const warehouseId = await staffWarehouse(user);
      const result = await OrderService.createWalkInOrder(body, warehouseId);
      const order = await OrderService.getOrderTableRowById(result.id);
      if (!order) throw new Error("Failed to load created walk-in order.");
      return {
        ...order,
        order_number: result.order_number,
        amount_tendered: result.amount_tendered,
        change_due: result.change_due,
        message: result.message,
      };
    },
    {
      detail: { summary: 'Create walk-in counter sale', description: 'Take full walk-in payment with immediate takeaway or company vehicle delivery.', tags: ['Orders'] },
      body: "order.walk_in",
    },
  )
  .post(
    "/",
    async ({ body, set }) => {
      const result = await OrderService.createOrder(body);
      const order = await OrderService.getOrderTableRowById(result.id);
      if (!order) throw new Error("Failed to load created order.");
      return order;
    },
    {
      detail: { summary: 'Create root', description: 'POST endpoint for root in the orders module.', tags: ['Orders'] },
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
      detail: { summary: 'Create process by id', description: 'POST endpoint for process by id in the orders module.', tags: ['Orders'] },
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
      detail: { summary: 'Create delivery by id', description: 'POST endpoint for delivery by id in the orders module.', tags: ['Orders'] },
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
      detail: { summary: 'Create cancel by id', description: 'POST endpoint for cancel by id in the orders module.', tags: ['Orders'] },
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
  }, { detail: { summary: 'Get cb', description: 'GET endpoint for cb in the orders module.', tags: ['Orders'] } });
