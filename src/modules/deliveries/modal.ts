import Elysia, { Static, t } from "elysia";

export const DeliveryIdParams = t.Object({ id: t.Numeric() });
export const StopIdParams = t.Object({ stopId: t.Numeric() });
export const OkResponse = t.Object({ ok: t.Literal(true) });

export const deliveryCreate = t.Object({
  order_ids: t.Array(t.Numeric({ minimum: 1 })),
  scheduled_date: t.String(),
  scheduled_time: t.String(),
  delivery_type: t.Union([
    t.Literal("LALAMOVE"),
    t.Literal("PICKUP"),
    t.Literal("INTERNAL"),
  ]),
  driver_id: t.Numeric({ minimum: 1 }),
  vehicle_id: t.Numeric({ minimum: 1 }),
  delivery_allowance: t.Numeric({ minimum: 0 }),
  fuel: t.Numeric({ minimum: 0 }),
  toll: t.Numeric({ minimum: 0 }),
});

export const deliveryEvent = t.Object({
  delivery_id: t.Numeric({ minimum: 1 }),
  event_type: t.Union([t.Literal("CANCELLED"), t.Literal("RESCHEDULED")]),
  reason: t.String({ maxLength: 255 }),
  scheduled_date: t.Optional(t.String()),
  departure_time: t.Optional(t.String()),
  delivery_version: t.Numeric({ minimum: 1 }),
});

export const deliveryAssignment = t.Object({
  driver_id: t.Numeric({ minimum: 1 }),
  vehicle_id: t.Numeric({ minimum: 1 }),
  delivery_version: t.Numeric({ minimum: 1 }),
});

export const deliveryModel = new Elysia().model({
  "deliveries.create": deliveryCreate,
  "deliveries.event": deliveryEvent,
  "deliveries.assignment": deliveryAssignment,
});

export type DeliveryCreateType = Static<typeof deliveryCreate>;
export type DeliveryEventType = Static<typeof deliveryEvent>;
export type DeliveryAssignmentType = Static<typeof deliveryAssignment>;
