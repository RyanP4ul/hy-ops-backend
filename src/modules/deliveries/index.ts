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
  detail: { tags: ["Deliveries"] },
})
  .decorate("user", {} as AuthUser)
  .use(deliveryModel)
  .get("/:id/expenses", async ({ params, user }) =>
    DeliveryService.getExpenses(params.id, await staffWarehouse(user)), {
    params: t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) }),
    detail: {
      summary: "View delivery expenses",
      description: "Retrieve saved delivery expenses within the current warehouse scope.",
      tags: ["Deliveries"],
    },
  })
  .get("/calendar", async ({ user }) => getDeliveryCalendar(await staffWarehouse(user)), {
    detail: {
      summary: "Get delivery calendar",
      description: "Retrieve deliveries scheduled for the current warehouse scope.",
      tags: ["Deliveries"],
    },
  })
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
  }, {
    detail: {
      summary: "List deliveries",
      description: "Retrieve deliveries with pagination, search, status, and warehouse filters.",
      tags: ["Deliveries"],
    },
  })
  .get("/returns", ({ user }) => CustomerReturnService.list(user), {
    detail: {
      summary: "List customer returns",
      description: "Retrieve customer return requests.",
      tags: ["Deliveries"],
    },
  })
  .get("/returns/:id/candidates", ({ user, params }) => CustomerReturnService.candidates(user, params.id), {
    params: t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) }),
    detail: {
      summary: "Get return assignment candidates",
      description: "Retrieve eligible drivers and vehicles for a customer return.",
      tags: ["Deliveries"],
    },
  })
  .post("/stops/:stopId/refunded", ({ user, params, body }) => CustomerReturnService.request(user, params.stopId, body), {
    params: t.Object({ stopId: t.Numeric({ minimum: 1, multipleOf: 1 }) }),
    body: t.Object({ reason: t.String({ minLength: 1, maxLength: 500 }), operationKey: t.String({ format: "uuid" }), confirmed: t.Literal(true) }),
    detail: {
      summary: "Request a stop refund",
      description: "Request a refund for a delivered stop.",
      tags: ["Deliveries"],
    },
  })
  .post("/returns/:id/assign", ({ user, params, body }) => CustomerReturnService.assign(user, params.id, body), {
    params: t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) }),
    body: t.Object({ version: t.Integer({ minimum: 1 }), vehicleId: t.Integer({ minimum: 1 }), driverId: t.Integer({ minimum: 1 }), operationKey: t.String({ format: "uuid" }), confirmed: t.Literal(true) }),
    detail: {
      summary: "Assign a customer return",
      description: "Assign a customer return to a driver and vehicle.",
      tags: ["Deliveries"],
    },
  })
  .get("/stops/:id/proofs", ({ user, params }) => proofService.list(user, params.id), {
    params: t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }) }),
    detail: {
      summary: "List delivery proofs",
      description: "Retrieve proof-of-delivery files for a stop.",
      tags: ["Deliveries"],
    },
  })
  .get("/stops/:id/proofs/:proofId", ({ user, params }) => proofService.download(user, params.id, params.proofId), {
    params: t.Object({ id: t.Numeric({ minimum: 1, multipleOf: 1 }), proofId: t.String({ format: "uuid" }) }),
    detail: {
      summary: "Download a delivery proof",
      description: "Download a proof-of-delivery file for a stop.",
      tags: ["Deliveries"],
    },
  })
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
      detail: {
        summary: "Create a delivery",
        description: "Create a new delivery in the current warehouse scope.",
        tags: ["Deliveries"],
      },
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
      detail: {
        summary: "Record a delivery event",
        description: "Record an event for an existing delivery.",
        tags: ["Deliveries"],
      },
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
      detail: {
        summary: "Update delivery assignment",
        description: "Update the driver or vehicle assignment for a delivery.",
        tags: ["Deliveries"],
      },
    },
  )
  .post(
    "/:id/dispatch",
    async ({ params, user }) => DeliveryService.dispatchDelivery(params.id, await staffWarehouse(user)),
    {
      params: DeliveryIdParams,
      response: OkResponse,
      detail: {
        summary: "Dispatch a delivery",
        description: "Dispatch a scheduled delivery.",
        tags: ["Deliveries"],
      },
    },
  )
  .post(
    "/:id/complete",
    async ({ params, user }) => DeliveryService.completeDelivery(params.id, await staffWarehouse(user), Number(user.sub)),
    {
      params: DeliveryIdParams,
      response: OkResponse,
      detail: {
        summary: "Complete a delivery",
        description: "Mark a delivery as completed.",
        tags: ["Deliveries"],
      },
    },
  )
  .post(
    "/stops/:stopId/delivered", // 
    async ({ params, user }) => DeliveryService.markStopDelivered(params.stopId, await staffWarehouse(user)),
    {
      params: StopIdParams,
      response: OkResponse,
      detail: {
        summary: "Mark a stop as delivered",
        description: "Mark a delivery stop as delivered.",
        tags: ["Deliveries"],
      },
    },
  );
