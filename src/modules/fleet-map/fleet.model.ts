import Elysia, { t } from "elysia";
import { WarehouseDto } from "../warehouse/model";

export const PaymentArrangementSchema = t.Union([
  t.Literal("FULLY_PAID"),
  t.Literal("PARTIALLY_PAID"),
  t.Literal("PAY_ON_DELIVERY"),
  t.Literal("NET_30"),
]);

export const PaymentMethodSchema = t.Union([
  t.Literal("CASH"),
  t.Literal("BANK_TRANSFER"),
  t.Literal("CARD"),
]);

export const OrderItemDto = t.Object({
  id: t.String(),
  name: t.String(),
  quantity: t.Number(),
  unitPrice: t.Union([t.Number(), t.Null()]),
});

export const OrderDto = t.Object({
  /** The human-readable order_number (e.g. "ORD-1049"); also the key for order routes. */
  id: t.String(),
  customer: t.Object({
    name: t.String(),
    code: t.String(),
    phone: t.String(),
  }),
  paymentArrangement: PaymentArrangementSchema,
  /** Method of the most recent payment, or null if nothing has been paid yet. */
  paymentMethod: t.Union([PaymentMethodSchema, t.Null()]),
  paymentType: t.Optional(t.Union([t.String(), t.Null()])),
  totalAmount: t.Union([t.Number(), t.Null()]),
  amountPaid: t.Number(),
  /** ISO date (YYYY-MM-DD); only set for NET_30 orders. */
  dueDate: t.Optional(t.String()),
  items: t.Array(OrderItemDto),
});

export const StopDto = t.Object({
  id: t.String(),
  name: t.String(),
  address: t.String(),
  coordinates: t.Tuple([t.Number(), t.Number()]),
  status: t.Union([t.Literal("pending"), t.Literal("completed")]),
  order: OrderDto,
});

export const TripMetaDto = t.Object({
  /** deliveries.id */
  id: t.String(),
  label: t.String(),
  scheduledAt: t.String(),
});

export const TripDto = t.Object({
  id: t.String(),
  label: t.String(),
  scheduledAt: t.String(),
  phase: t.Union([t.Literal("upcoming"), t.Literal("overdue")]),
  stops: t.Array(StopDto),
});

export const ReturnPickupDto = t.Object({ id: t.Number(), orderNumber: t.String(), customer: t.String(), address: t.String(), status: t.String(),
  coordinates: t.Union([t.Tuple([t.Number(), t.Number()]), t.Null()]), version: t.Number(),
});

export const VehicleDto = t.Object({
  id: t.String(),
  driver: t.String(),
  plate: t.String(),
  color: t.String(),
  warehouseId: t.String(),
  pickups: t.Optional(t.Array(ReturnPickupDto)),
  trip: t.Union([TripMetaDto, t.Null()]),
  stops: t.Array(StopDto),
  scheduledTrips: t.Array(TripDto),
  legIndex: t.Number(),
  progress: t.Number(),
  completedStops: t.Number(),
  status: t.Union([
    t.Literal("delivering"),
    t.Literal("returning"),
    t.Literal("available"),
  ]),
  /** Set when the vehicle is idle but cannot take a trip (maintenance / unavailable). */
  blockedReason: t.Optional(
    t.Union([
      t.Literal("maintenance"),
      t.Literal("unavailable"),
      t.Literal("on_delivery"),
    ]),
  ),
  speed: t.Number(),
});

export const FleetOverviewDto = t.Object({
  vehicles: t.Array(VehicleDto),
  warehouses: t.Array(WarehouseDto),
});

export const AssignWarehouseBody = t.Object({
  warehouseId: t.Numeric(),
});

const pointSchema = t.Object({
  lat: t.Number({ minimum: -90, maximum: 90 }),
  lng: t.Number({ minimum: -180, maximum: 180 }),
});

const coordinateSchema = t.Object({
  id: t.String({ minLength: 1, maxLength: 100 }),
  name: t.String({ minLength: 1, maxLength: 120 }),
  lat: t.Number({ minimum: -90, maximum: 90 }),
  lng: t.Number({ minimum: -180, maximum: 180 }),
});

export const fleetMapModel = new Elysia().model({
  "fleetmap.point_and_coordinate": t.Object({
    origin: pointSchema,
    locations: t.Array(coordinateSchema, { maxItems: 500 }),
  }),
});

export const LivePositionDto = t.Object({
  vehicleId: t.String(),
  /** [longitude, latitude] */
  coordinates: t.Tuple([t.Number(), t.Number()]),
  speedKph: t.Union([t.Number(), t.Null()]),
  heading: t.Union([t.Number(), t.Null()]),
  /** When the device recorded the fix (ISO 8601). The UI uses it to flag stale signals. */
  recordedAt: t.String(),
  receivedAt: t.Optional(t.Union([t.String(), t.Null()])),
  sampleIntervalSeconds: t.Optional(t.Union([t.Number(), t.Null()])),
  accuracyM: t.Optional(t.Union([t.Number(), t.Null()])),
});
export type LivePositionDto = typeof LivePositionDto.static;

export const PositionsResponse = t.Object({
  positions: t.Array(LivePositionDto),
});

export const PositionIngestBody = t.Object({
  longitude: t.Number({ minimum: -180, maximum: 180 }),
  latitude: t.Number({ minimum: -90, maximum: 90 }),
  accuracyM: t.Optional(t.Number({ minimum: 0 })),
  speedKph: t.Optional(t.Number({ minimum: 0, maximum: 400 })),
  heading: t.Optional(t.Number({ minimum: 0, maximum: 360 })),
  /** ISO 8601; defaults to "now" when the device doesn't send a timestamp. */
  recordedAt: t.Optional(t.String({ format: "date-time" })),
});
export type PositionIngestBody = typeof PositionIngestBody.static;

export type VehicleDto = typeof VehicleDto.static;
export type StopDto = typeof StopDto.static;
export type TripDto = typeof TripDto.static;
export type OrderDto = typeof OrderDto.static;
export type FleetOverviewDto = typeof FleetOverviewDto.static;
