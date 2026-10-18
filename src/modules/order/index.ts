import Elysia, { t } from "elysia";
import { orderModel } from "./model";
import { OrderService } from "./service";
import { AuthUser } from "../auth/schema";

export const orderRoutes = new Elysia({ prefix: "/orders" })
  .decorate("user", AuthUser)
  .use(orderModel)
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
    );

    set.headers["X-Total-Count"] = result.total;

    return result.rows;
  })
  .get(
    "/:id",
    async ({ params }) => {
      const orderDetail = await OrderService.getOrderById(params.id);

      if (!orderDetail) {
        return { error: "Order not found" };
      }

      return orderDetail;
    },
    {
      params: t.Object({
        id: t.Number(),
      }),
    },
  )
  .get("/details", async ({ query }) => {
    const order_ids = query.ids ? query.ids.split(",").map(Number) : [];
    return await OrderService.getOrderDetailsByIds(order_ids);
  })
  .post(
    "/",
    async ({ body }) => {
      return await OrderService.createOrder(body);
    },
    {
      body: "order.create",
    },
  )
  .post(
    "/process/:id",
    async ({ query, params }) =>
      await OrderService.processOrder(params.id, query.version),
    {
      query: t.Object({
        version: t.Number(),
      }),
      params: t.Object({
        id: t.Number(),
      }),
    },
  )
  .post(
    "/delivery/:id",
    async ({ query, params }) =>
      await OrderService.deliveryOrder(params.id, query.version),
    {
      query: t.Object({
        version: t.Number(),
      }),
      params: t.Object({
        id: t.Number(),
      }),
    },
  )
  .post(
    "/cancel/:id",
    async ({ query, params }) =>
      await OrderService.cancelOrder(params.id, query.version),
    {
      query: t.Object({
        version: t.Number(),
      }),
      params: t.Object({
        id: t.Number(),
      }),
    },
  )
  // getAllOrderForCombobox
  .get("/cb", async ({ query }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";

    const result = await OrderService.getAllOrderForCombobox(
      page,
      limit,
      search,
    );

    return result;
  });
