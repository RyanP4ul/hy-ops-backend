import Elysia, { Static, t } from "elysia";

export const warehouse_schema = t.Object({
  name: t.String({ minLength: 1, maxLength: 100 }),
  phone_number: t.Optional(t.Union([t.Null(), t.String({ maxLength: 20, pattern: "^$|^\\+?[0-9 ()-]{7,20}$" })])),
  street_address: t.String({ minLength: 1, maxLength: 255 }),
  city: t.String({ minLength: 1, maxLength: 100 }),
  state: t.String({ minLength: 1, maxLength: 100 }),
  zip_code: t.String({ minLength: 1, maxLength: 30 }),
  clear_coordinates: t.Optional(t.Boolean()),
  latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
  longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
});

export type WarehouseType = Static<typeof warehouse_schema>;

export const warehouseModel = new Elysia().model({
  "warehouse.create": t.Object({
    ...warehouse_schema.properties,
  }),
  "warehouse.update": t.Object({
    ...warehouse_schema.properties,
    version: t.Numeric({ minimum: 1 }),
  }),
});

export const WarehouseDto = t.Object({
  id: t.String(),
  name: t.String(),
  streetAddress: t.String(),
  city: t.String(),
  state: t.String(),
  zipCode: t.String(),
  /** Display string: "street, city, state zip". */
  address: t.String(),
  /** [longitude, latitude] — the order MapLibre expects. */
  coordinates: t.Tuple([t.Number(), t.Number()]),
});
export type WarehouseDto = typeof WarehouseDto.static;

export const WarehouseBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 255 }),
  streetAddress: t.String({ minLength: 1 }),
  city: t.String({ minLength: 1 }),
  state: t.String({ minLength: 1 }),
  zipCode: t.String({ minLength: 1 }),
  longitude: t.Number({ minimum: -180, maximum: 180 }),
  latitude: t.Number({ minimum: -90, maximum: 90 }),
});
export type WarehouseBody = typeof WarehouseBody.static;

export const IdParams = t.Object({ id: t.Numeric() });
