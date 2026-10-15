import Elysia from "elysia";
import { OrderService } from "../order/service";

export const deliveryScheduleRoutes = new Elysia({
  prefix: "/delivery-schedules",
}).get("/", async ({ query, set }) => {
  const page = query.page ? parseInt(query.page) : 0;
  let limit = query.limit ? parseInt(query.limit) : 10;
  const search = query.search ? query.search.trim() : "";

  const result = await OrderService.getAllReadyForDeliveryOrders(
    page,
    limit,
    search,
  );

  set.headers["X-Total-Count"] = result.total;

  return result.rows;
});
