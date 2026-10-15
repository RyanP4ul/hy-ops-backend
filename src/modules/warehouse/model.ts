import Elysia, { Static, t } from "elysia";

export const warehouse_schema = t.Object({
  name: t.String({ minLength: 1, maxLength: 100 }),
  street_address: t.String({ minLength: 1, maxLength: 255 }),
  city: t.String({ minLength: 1, maxLength: 100 }),
  state: t.String({ minLength: 1, maxLength: 100 }),
  zip_code: t.String({ minLength: 1, maxLength: 30 }),
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
