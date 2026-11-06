import Elysia from "elysia";
import { AuthUser } from "../auth/schema";
import { staffWarehouse } from "../deliveries/scope";
import { OrderService } from "../order/service";
import { DeliveryScheduleService } from "./services";

export const deliveryScheduleRoutes = new Elysia({
  prefix: "/delivery-schedules",
})
  .decorate("user", {} as AuthUser)
  .get("/", async ({ query, set, user }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";
    const date = query.date ? new Date(query.date) : null;

    const result = await OrderService.getSchedulingEntries(
      page,
      limit,
      search,
      await staffWarehouse(user) ?? (query.warehouse_id ? Number(query.warehouse_id) : undefined),
    );

    set.headers["X-Total-Count"] = result.total;

    return result.rows;
  })
  .decorate("user", {} as AuthUser)
  .get("/available-dates", async ({ query, user }) => {
    const maxOrdersPerDay = 5;
    const days = 30;
    const warehouse_id = await staffWarehouse(user) ?? (query.warehouse_id ? parseInt(query.warehouse_id) : -1);

    return DeliveryScheduleService.getAvailableOrderDates({
      maxOrdersPerDay,
      daysAhead: days,
      warehouse_id,
    });
  });
