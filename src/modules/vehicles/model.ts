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
});

export type VehicleType = Static<typeof vehicleSchema>;
export type VehicleCreateType = Omit<VehicleType, "status"> & { status?: VehicleType["status"] };

export const vehicleModel = new Elysia().model({
  "vehicle.create": t.Object({
    warehouse_id: vehicleSchema.properties.warehouse_id,
    plate_number: vehicleSchema.properties.plate_number,
    type: vehicleSchema.properties.type,
    status: t.Optional(vehicleSchema.properties.status),
  }),
  "vehicle.update": t.Object({
    ...vehicleSchema.properties,
    version: t.Numeric({ minimum: 1 }),
  }),
});
