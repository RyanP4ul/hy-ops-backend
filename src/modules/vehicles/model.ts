import Elysia, { Static, t } from "elysia";

const vehicleSchema = t.Object({
  plate_number: t.String({ minLength: 1, maxLength: 255 }),
  status: t.Union([
    t.Literal("available"),
    t.Literal("unavailable"),
    t.Literal("maintenance"),
    t.Literal("on_delivery"),
  ]),
  type: t.Union([t.Literal("truck"), t.Literal("van"), t.Literal("other")]),
  image: t.String({ minLength: 1, maxLength: 255 }),
});

export type VehicleType = Static<typeof vehicleSchema>;

export const vehicleModel = new Elysia().model({
  "vehicle.create": vehicleSchema,
  "vehicle.update": t.Object({
    ...vehicleSchema.properties,
    version: t.Numeric({ minimum: 1 }),
  }),
});
