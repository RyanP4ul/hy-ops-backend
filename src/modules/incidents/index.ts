import Elysia, { t } from "elysia";
import { AuthUser } from "../auth/schema";
import { staffWarehouse } from "../deliveries/scope";
import { IncidentService } from "./service";

const incidentCategory = t.Union([
  t.Literal("DELAY"),
  t.Literal("TRAFFIC"),
  t.Literal("BREAKDOWN"),
  t.Literal("ACCIDENT"),
  t.Literal("WEATHER"),
  t.Literal("OTHER"),
]);

const incidentSeverity = t.Union([
  t.Literal("low"),
  t.Literal("medium"),
  t.Literal("high"),
  t.Literal("critical"),
]);

const incidentStatus = t.Union([
  t.Literal("open"),
  t.Literal("acknowledged"),
  t.Literal("resolved"),
]);

export const incidentRoutes = new Elysia({ prefix: "/deliveries" })
  .decorate("user", {} as AuthUser)
  .get(
    "/incidents",
    async ({ query, user }) => {
      const warehouseId = await staffWarehouse(user);
      return IncidentService.listIncidents({
        deliveryId: query.delivery_id ? Number(query.delivery_id) : undefined,
        status: query.status as "open" | "acknowledged" | "resolved" | undefined,
        category: query.category as
          | "DELAY"
          | "TRAFFIC"
          | "BREAKDOWN"
          | "ACCIDENT"
          | "WEATHER"
          | "OTHER"
          | undefined,
        warehouseId,
        limit: query.limit ? Number(query.limit) : 50,
        offset: query.offset ? Number(query.offset) : 0,
      });
    },
    {
      query: t.Object({
        delivery_id: t.Optional(t.Numeric({ minimum: 1 })),
        status: t.Optional(incidentStatus),
        category: t.Optional(incidentCategory),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
        offset: t.Optional(t.Numeric({ minimum: 0 })),
      }),
      detail: {
        summary: "List delivery transit incident reports",
        tags: ["Deliveries", "Incidents"],
      },
    },
  )
  .get(
    "/:id/incidents",
    async ({ params, user }) => {
      const warehouseId = await staffWarehouse(user);
      return IncidentService.listIncidents({
        deliveryId: params.id,
        warehouseId,
      });
    },
    {
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      detail: {
        summary: "List incident reports for a delivery",
        tags: ["Deliveries", "Incidents"],
      },
    },
  )
  .post(
    "/:id/incidents",
    async ({ params, body, user }) => {
      const warehouseId = await staffWarehouse(user);
      return IncidentService.createIncident(
        {
          delivery_id: params.id,
          ...body,
        },
        {
          id: Number(user.sub),
          role: String(user.role ?? "staff"),
          warehouseId,
        },
      );
    },
    {
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      body: t.Object({
        stop_id: t.Optional(t.Nullable(t.Integer({ minimum: 1 }))),
        category: incidentCategory,
        severity: t.Optional(incidentSeverity),
        description: t.String({ minLength: 1, maxLength: 1000 }),
        status_notes: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
        estimated_delay_minutes: t.Optional(
          t.Nullable(t.Integer({ minimum: 0, maximum: 1440 })),
        ),
        latitude: t.Optional(t.Nullable(t.Number({ minimum: -90, maximum: 90 }))),
        longitude: t.Optional(
          t.Nullable(t.Number({ minimum: -180, maximum: 180 })),
        ),
        create_maintenance_ticket: t.Optional(t.Boolean()),
      }),
      detail: {
        summary: "Log a transit incident for a delivery",
        tags: ["Deliveries", "Incidents"],
      },
    },
  )
  .patch(
    "/incidents/:incidentId",
    async ({ params, body, user }) => {
      const warehouseId = await staffWarehouse(user);
      return IncidentService.updateIncident(params.incidentId, body, {
        id: Number(user.sub),
        warehouseId,
      });
    },
    {
      params: t.Object({ incidentId: t.Numeric({ minimum: 1 }) }),
      body: t.Object({
        status: t.Optional(incidentStatus),
        severity: t.Optional(incidentSeverity),
        status_notes: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
        estimated_delay_minutes: t.Optional(
          t.Nullable(t.Integer({ minimum: 0, maximum: 1440 })),
        ),
      }),
      detail: {
        summary: "Update incident status and status notes",
        tags: ["Deliveries", "Incidents"],
      },
    },
  );
