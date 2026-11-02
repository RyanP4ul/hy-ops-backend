import Elysia, { t } from "elysia";

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
