import Elysia, { t } from "elysia";
import { AuthUser } from "../auth/schema";
import { staffWarehouse } from "../deliveries/scope";
import { OrderService } from "../order/service";
import { DeliveryScheduleService } from "./services";

export const deliveryScheduleRoutes = new Elysia({
  prefix: "/delivery-schedules",
})
  .decorate("user", {} as AuthUser)
  .get(
    "/",
    async ({ query, set, user }) => {
      const page = query.page ? parseInt(query.page) : 0;
      const limit = query.limit ? parseInt(query.limit) : 10;
      const search = query.search ? query.search.trim() : "";

      const result = await OrderService.getSchedulingEntries(
        page,
        limit,
        search,
        (await staffWarehouse(user)) ??
          (query.warehouse_id ? Number(query.warehouse_id) : undefined),
      );

      set.headers["X-Total-Count"] = result.total;

      return result.rows;
    },
    {
      detail: {
        summary: "List root",
        description: "GET endpoint for root in the delivery schedules module.",
        tags: ["Delivery Schedules"],
      },
    },
  )
  .get(
    "/available-dates",
    async ({ query, user }) => {
      const days = 30;
      const warehouse_id =
        (await staffWarehouse(user)) ??
        (query.warehouse_id ? parseInt(query.warehouse_id) : -1);
      const vehicle_id = query.vehicle_id ? Number(query.vehicle_id) : undefined;

      return DeliveryScheduleService.getAvailableOrderDates({
        daysAhead: days,
        warehouse_id,
        vehicle_id:
          vehicle_id && Number.isInteger(vehicle_id) && vehicle_id > 0
            ? vehicle_id
            : undefined,
      });
    },
    {
      detail: {
        summary: "Get available dates",
        description:
          "GET endpoint for available dates and slot utilization in the delivery schedules module.",
        tags: ["Delivery Schedules"],
      },
    },
  )
  .post(
    "/check-availability",
    async ({ body, user }) => {
      const scopedWarehouse = await staffWarehouse(user);
      const warehouse_id = scopedWarehouse ?? body.warehouse_id;
      return DeliveryScheduleService.checkAvailability({
        ...body,
        warehouse_id,
      });
    },
    {
      body: t.Object({
        warehouse_id: t.Integer({ minimum: 1 }),
        scheduled_date: t.String({ format: "date" }),
        scheduled_time: t.String({ pattern: "^\\d{2}:\\d{2}(:\\d{2})?$" }),
        driver_id: t.Optional(t.Integer({ minimum: 1 })),
        vehicle_id: t.Optional(t.Integer({ minimum: 1 })),
        estimated_duration_minutes: t.Optional(
          t.Nullable(t.Number({ minimum: 1, maximum: 1440 })),
        ),
        requested_stops: t.Optional(t.Integer({ minimum: 1 })),
        exclude_delivery_id: t.Optional(t.Integer({ minimum: 1 })),
      }),
      detail: {
        summary: "Verify driver, vehicle, and daily slot availability",
        description:
          "Checks vehicle/driver conflicts (with 1-hour return grace buffer), daily capacity, and estimated trip return window before confirming a schedule.",
        tags: ["Delivery Schedules"],
      },
    },
  );
