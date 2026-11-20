import Elysia, { Static, t } from "elysia";

const vehicleSchema = t.Object({
  warehouse_id: t.Numeric({ minimum: 1 }),
  plate_number: t.String({ minLength: 1, maxLength: 255 }),
  status: t.Union([
    t.Literal("available"),
    t.Literal("unavailable"),
    t.Literal("maintenance"),
    t.Literal("on_delivery"),
  ]),
  type: t.Union([t.Literal("truck"), t.Literal("van"), t.Literal("other")]),
  max_weight_kg: t.Optional(t.Union([t.Numeric({ minimum: 0 }), t.Null()])),
  max_volume_cbm: t.Optional(t.Union([t.Numeric({ minimum: 0 }), t.Null()])),
  current_odometer_km: t.Optional(t.Numeric({ minimum: 0 })),
  next_service_odometer_km: t.Optional(t.Union([t.Numeric({ minimum: 0 }), t.Null()])),
});

export type VehicleType = Static<typeof vehicleSchema>;
export type VehicleCreateType = Omit<VehicleType, "status"> & { status?: VehicleType["status"] };

export const vehicleModel = new Elysia().model({
  "vehicle.create": t.Object({
    warehouse_id: vehicleSchema.properties.warehouse_id,
    plate_number: vehicleSchema.properties.plate_number,
    type: vehicleSchema.properties.type,
    status: t.Optional(vehicleSchema.properties.status),
    max_weight_kg: vehicleSchema.properties.max_weight_kg,
    max_volume_cbm: vehicleSchema.properties.max_volume_cbm,
    current_odometer_km: vehicleSchema.properties.current_odometer_km,
    next_service_odometer_km: vehicleSchema.properties.next_service_odometer_km,
  }),
  "vehicle.update": t.Object({
    ...vehicleSchema.properties,
    version: t.Numeric({ minimum: 1 }),
  }),
});
