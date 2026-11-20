import Elysia, { t } from "elysia";
import { orderEditSchema, orderModel, savedShippingAddressSchema } from "./model";
import { OrderService } from "./service";
import { AuthUser } from "../auth/schema";
import { staffWarehouse, assertOrderScope, assignOrderWarehouse } from "../deliveries/scope";
import { WorkflowError } from "../../utils/workflow-error";
import { LalamoveService } from "../lalamove/service";

export const orderRoutes = new Elysia({ prefix: "/orders" })
  .decorate("user", {} as AuthUser)
  .use(orderModel)
  .get("/:id/lalamove", ({ params, user }) => LalamoveService.context(params.id, user), { params: t.Object({ id: t.Numeric({ minimum: 1 }) }) })
  .get("/customers/:customerId/addresses", ({ params }) =>
    OrderService.getCustomerAddresses(params.customerId), {
      detail: { summary: 'List customer saved shipping addresses', description: 'GET endpoint for customer saved shipping addresses in the orders module.', tags: ['Orders'] },
    params: t.Object({ customerId: t.Numeric({ minimum: 1 }) }),
  })
  .post("/customers/:customerId/addresses", ({ params, body }) =>
    OrderService.saveShippingAddress(params.customerId, body), {
      detail: { summary: 'Create customers by customerId addresses', description: 'POST endpoint for customers by customerId addresses in the orders module.', tags: ['Orders'] },
    params: t.Object({ customerId: t.Numeric({ minimum: 1 }) }),
    body: savedShippingAddressSchema,
  })
  .get("/", async ({ query, set, user }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";
    const delivery_type = query.delivery_type ? query.delivery_type.trim() : "";
    const sort_by = query.sort_by ? String(query.sort_by) : "id:desc";
    const grouped = query.grouped === "true";
    const warehouseId = await staffWarehouse(user);

    const result = grouped
      ? await OrderService.getGroupedOrders(
          page,
          limit,
          search,
          delivery_type,
          sort_by,
          query.status ?? "",
          warehouseId,
        )
      : await OrderService.getOrders(
          page,
          limit,
          search,
          delivery_type,
          sort_by,
          query.status ?? "",
          warehouseId,
        );

    set.headers["X-Total-Count"] = result.total;

    return result.rows;
  }, { detail: { summary: 'List root', description: 'GET endpoint for root in the orders module.', tags: ['Orders'] } })
  .get(
    "/:id",
    async ({ params, user }) => {
      const warehouseId = await staffWarehouse(user);
      await assertOrderScope(params.id, warehouseId);
      const orderDetail = await OrderService.getOrderById(params.id, warehouseId);

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
    const assigned = await assignOrderWarehouse(user, query);
    return OrderService.getReadyOrderGroup(params.groupId, assigned.warehouse_id);
  }, {
      detail: { summary: 'Get groups by groupId ready', description: 'GET endpoint for groups by groupId ready in the orders module.', tags: ['Orders'] }, params: t.Object({ groupId: t.String({ format: "uuid" }) }), query: t.Object({ warehouse_id: t.Optional(t.Numeric({ minimum: 1 })) }) })
  .post("/groups/:groupId/process", async ({ params, user }) => {
    return OrderService.processOrderGroup(params.groupId, await staffWarehouse(user));
  }, {
    detail: { summary: 'Process all pending orders in a group', description: 'Transitions all pending non-walk-in orders in the order group to PROCESSING.', tags: ['Orders'] },
    params: t.Object({ groupId: t.String({ format: "uuid" }) }),
  })
  .post("/groups/:groupId/delivery", async ({ params, user }) => {
    return OrderService.deliveryOrderGroup(params.groupId, await staffWarehouse(user));
  }, {
    detail: { summary: 'Mark all processing orders in a group ready for delivery', description: 'Transitions all processing non-walk-in orders in the order group to SCHEDULING and issues invoices.', tags: ['Orders'] },
    params: t.Object({ groupId: t.String({ format: "uuid" }) }),
  })
  .get("/details", async ({ query, user }) => {
    const order_ids = query.ids ? query.ids.split(",").map(Number) : [];
    return await OrderService.getOrderDetailsByIds(order_ids, await staffWarehouse(user));
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
  .put("/:id", async ({ params, body, user }) => {
    await assertOrderScope(params.id, await staffWarehouse(user));
    return OrderService.updateOrder(params.id, body);
  }, {
      detail: { summary: 'Update by id', description: 'PUT endpoint for updating a pending or processing order in the orders module.', tags: ['Orders'] },
    params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
    body: orderEditSchema,
  })
  .put("/:id/destination", async ({ params, body, user }) => { await assertOrderScope(params.id, await staffWarehouse(user)); return OrderService.setDestination(params.id, body.version, body.latitude, body.longitude); }, {
      detail: { summary: 'Update by id destination', description: 'PUT endpoint for by id destination in the orders module.', tags: ['Orders'] },
    params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
    body: t.Object({ version: t.Integer({ minimum: 1 }), latitude: t.Number({ minimum: -90, maximum: 90 }), longitude: t.Number({ minimum: -180, maximum: 180 }) }),
  })
  .post("/batch", async ({ body, user }) => {
    const created = body.payment_mode === "COMBINED"
      ? await OrderService.createOrders({ ...body, orders: await Promise.all(body.orders.map(order => assignOrderWarehouse(user, order))) })
      : await OrderService.createOrders({ ...body, orders: await Promise.all(body.orders.map(order => assignOrderWarehouse(user, order))) });
    const rows = await Promise.all(created.map(order => OrderService.getOrderTableRowById(order.id)));
    if (rows.some(row => !row)) throw new Error("Failed to load created orders.");
    return { orders: rows, message: `${rows.length} orders created successfully.` };
  }, {
      detail: { summary: 'Create batch', description: 'POST endpoint for batch in the orders module.', tags: ['Orders'] }, body: "order.batch" })
  .post(
    "/walk-in",
    async ({ body, user }) => {
      const warehouseId = await staffWarehouse(user);
      const result = await OrderService.createWalkInOrder(await assignOrderWarehouse(user, body), warehouseId);
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
    async ({ body, user }) => {
      const result = await OrderService.createOrder(await assignOrderWarehouse(user, body));
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
    async ({ query, params, user }) => {
      await assertOrderScope(params.id, await staffWarehouse(user));
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
    "/:id/pick-pack",
    async ({ params, body, user }) => {
      await assertOrderScope(params.id, await staffWarehouse(user));
      const result = await OrderService.updatePickPackStage(params.id, Number(user.sub), body);
      const order = await OrderService.getOrderTableRowById(result.id);
      return { ...result, order };
    },
    {
      detail: {
        summary: "Verify Pick, Pack & Stage checklist for an order",
        description: "Updates line-item picked/packed quantities, staging bay, and optionally advances a fully staged order to SCHEDULING.",
        tags: ["Orders"],
      },
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      body: t.Object({
        version: t.Integer({ minimum: 1 }),
        staging_bay: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
        advance_to_scheduling: t.Optional(t.Boolean()),
        items: t.Array(
          t.Object({
            order_item_id: t.Integer({ minimum: 1 }),
            picked_qty: t.Integer({ minimum: 0 }),
            packed_qty: t.Integer({ minimum: 0 }),
          }),
          { minItems: 1 },
        ),
      }),
    },
  )
  .post(
    "/:id/split",
    async ({ params, body, user }) => {
      await assertOrderScope(params.id, await staffWarehouse(user));
      const result = await OrderService.splitOrder(params.id, Number(user.sub), body);
      const [parent, child] = await Promise.all([
        OrderService.getOrderTableRowById(result.parent_order_id),
        OrderService.getOrderTableRowById(result.child_order_id),
      ]);
      return { ...result, parent, child };
    },
    {
      detail: {
        summary: "Split an order into an independent child shipment",
        description: "Moves selected line-item quantities into a new independently schedulable shipment across multiple trucks while preserving stock reservations and proportional payments.",
        tags: ["Orders"],
      },
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      body: t.Object({
        version: t.Integer({ minimum: 1 }),
        reason: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
        items: t.Array(
          t.Object({
            order_item_id: t.Integer({ minimum: 1 }),
            split_quantity: t.Integer({ minimum: 0 }),
          }),
          { minItems: 1 },
        ),
      }),
    },
  )
  .post(
    "/delivery/:id",
    async ({ query, params, user }) => {
      await assertOrderScope(params.id, await staffWarehouse(user));
      const result = await OrderService.deliveryOrder(params.id, query.version, {
        requireStaged: query.auto_stage !== "true",
        actorId: Number(user.sub),
      });
      const order = await OrderService.getOrderTableRowById(result.id);

      if (!order) throw new Error("Failed to load delivery-ready order.");

      return order;
    },
    {
      detail: { summary: 'Create delivery by id', description: 'POST endpoint for delivery by id in the orders module.', tags: ['Orders'] },
      query: t.Object({
        version: t.Numeric({ minimum: 1 }),
        auto_stage: t.Optional(t.String()),
      }),
      params: t.Object({
        id: t.Numeric({ minimum: 1 }),
      }),
    },
  )
  .post(
    "/cancel/:id",
    async ({ query, params, user }) => {
      await assertOrderScope(params.id, await staffWarehouse(user));
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
