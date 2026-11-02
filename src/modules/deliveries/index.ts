import { CustomerReturnService } from "./customer-returns";
import { getDeliveryCalendar } from "./calendar";
import { proofService } from "../driver/proofs";
import Elysia, { t } from "elysia";
import { AuthUser } from "../auth/schema";
import { staffWarehouse } from "./scope";
import { DeliveryService } from "./service";
import {
  DeliveryIdParams,
  deliveryModel,
  OkResponse,
  StopIdParams,
} from "./modal";

const deliveryStatuses = [
  "scheduled",
  "in_transit",
  "returning",
  "completed",
  "cancelled",
] as const;

type DeliveryStatus = (typeof deliveryStatuses)[number];

function isDeliveryStatus(value: string | undefined): value is DeliveryStatus {
  return (
    value !== undefined && deliveryStatuses.includes(value as DeliveryStatus)
  );
}

export const deliveriesRoutes = new Elysia({
  prefix: "/deliveries",
})
  .decorate("user", {} as AuthUser)
  .use(deliveryModel)
  .get("/calendar", async ({ user }) => getDeliveryCalendar(await staffWarehouse(user)))
  .get("/", async ({ query, set, user }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";
    const status = isDeliveryStatus(query.status) ? query.status : undefined;

    const result = await DeliveryService.getDelivery(
      page,
      limit,
      search,
      status,
      undefined,
      query.overdue === "true",
      query.active === "true",
      await staffWarehouse(user),
    );

    set.headers["X-Total-Count"] = result.total;

    return result.rows;
  })
  .get("/returns", ({ user }) => CustomerReturnService.list(user))
  .get("/returns/:id/candidates", ({ user, params }) => CustomerReturnService.candidates(user, params.id), { params: t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) }) })
  .post("/stops/:stopId/refunded", ({ user, params, body }) => CustomerReturnService.request(user, params.stopId, body), {
    params: t.Object({ stopId: t.Numeric({ minimum: 1, multipleOf: 1 }) }),
    body: t.Object({ reason: t.String({ minLength: 1, maxLength: 500 }), operationKey: t.String({ format: "uuid" }), confirmed: t.Literal(true) }),
  })
  .post("/returns/:id/assign", ({ user, params, body }) => CustomerReturnService.assign(user, params.id, body), {
    params: t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) }),
    body: t.Object({ version: t.Integer({ minimum: 1 }), vehicleId: t.Integer({ minimum: 1 }), driverId: t.Integer({ minimum: 1 }), operationKey: t.String({ format: "uuid" }), confirmed: t.Literal(true) }),
  })
  .get("/stops/:id/proofs", ({ user, params }) => proofService.list(user, params.id), { params: t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) }) })
  .get("/stops/:id/proofs/:proofId", ({ user, params }) => proofService.download(user, params.id, params.proofId), { params: t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }), proofId: t.String({ format: "uuid" }) }) })
  .post(
    "/",
    async ({ body, user }) => {
      const result = await DeliveryService.createDelivery(body, await staffWarehouse(user));
      const delivery = await DeliveryService.getDeliveryTableRowById(result.id);

      if (!delivery) throw new Error("Failed to load created delivery.");

      return { ...result, delivery };
    },
    {
      body: "deliveries.create",
    },
  )
  .post(
    "/event",
    async ({ body, user }) => {
      const result = await DeliveryService.eventDelivery(body, await staffWarehouse(user));
      const delivery = await DeliveryService.getDeliveryTableRowById(
        result?.delivery_id || -1,
      );

      if (!delivery) throw new Error("Failed to load updated delivery.");

      return { ...result, delivery };
    },
    {
      body: "deliveries.event",
    },
  )
  .patch(
    "/:id/assignment",
    async ({ params, body, user }) => {
      const result = await DeliveryService.updateAssignment(
        Number(params.id),
        body,
        await staffWarehouse(user),
      );
      const delivery = await DeliveryService.getDeliveryTableRowById(
        result.delivery_id,
      );

      if (!delivery) throw new Error("Failed to load updated delivery.");

      return { ...result, delivery };
    },
    {
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      body: "deliveries.assignment",
    },
  )
  .post(
    "/:id/dispatch",
    async ({ params, user }) => DeliveryService.dispatchDelivery(params.id, await staffWarehouse(user)),
    {
      params: DeliveryIdParams,
      response: OkResponse,
    },
  )
  .post(
    "/:id/complete",
    async ({ params, user }) => DeliveryService.completeDelivery(params.id, await staffWarehouse(user), Number(user.sub)),
    {
      params: DeliveryIdParams,
      response: OkResponse,
    },
  )
  .post(
    "/stops/:stopId/delivered",
    async ({ params, user }) => DeliveryService.markStopDelivered(params.stopId, await staffWarehouse(user)),
    {
      params: StopIdParams,
      response: OkResponse,
    },
  );
