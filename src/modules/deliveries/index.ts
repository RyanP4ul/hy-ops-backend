import Elysia from "elysia";
import { DeliveryService } from "./service";
import { deliveryModel } from "./modal";

export const deliveriesRoutes = new Elysia({
  prefix: "/deliveries",
})
  .use(deliveryModel)
  .get("/", async ({ query, set }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";

    const result = await DeliveryService.getDelivery(page, limit, search);

    set.headers["X-Total-Count"] = result.total;

    return result.rows;
  })
  .post(
    "/",
    async ({ body, set }) => {
      return await DeliveryService.createDelivery(body);
    },
    {
      body: "deliveries.create",
    },
  )
  .post(
    "/event",
    async ({ body, set }) => {
      return await DeliveryService.eventDelivery(body);
    },
    {
      body: "deliveries.event",
    },
  );
