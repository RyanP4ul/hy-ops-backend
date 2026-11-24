import { staffWarehouse } from "../deliveries/scope";
import Elysia, { t } from "elysia";
import { AuthUser } from "../auth/schema";
import { vehicleModel } from "./model";
import { vehicleService } from "./service";

export const vehicleRoutes = new Elysia({ prefix: "/vehicles" })
  .use(vehicleModel)
  .decorate("user", {} as AuthUser)
  .get("/", async ({ query, set }) => {
    const result = await vehicleService.getVehicles(
      query.page ? Number(query.page) : 0,
      query.limit ? Number(query.limit) : 10,
      query.search?.trim() ?? "",
      query.sort_by ? String(query.sort_by) : "id:desc",
    );

    const is_cb = query.is_cb === "true" ? true : false;

    if (is_cb) {
      return result;
    } else {
      set.headers["X-Total-Count"] = String(result.total);
      return result.rows;
    }
  }, { detail: { summary: 'List root', description: 'GET endpoint for root in the vehicles module.', tags: ['Vehicles'] } })
  .get("/:id", async ({ params, set }) => {
    const vehicle = await vehicleService.getVehicleById(Number(params.id));
    if (!vehicle) {
      set.status = 404;
      return { message: "Vehicle not found" };
    }
    return vehicle;
  }, { detail: { summary: 'Get by id', description: 'GET endpoint for by id in the vehicles module.', tags: ['Vehicles'] } })
  .post(
    "/",
    async ({ body, set }) => {
      const result = await vehicleService.createVehicle(body);
      if ("errors" in result) {
        set.status = 400;
        return result;
      }
      if ("vehicle" in result && !result.vehicle) {
        set.status = 500;
        return { message: "Failed to load created vehicle." };
      }
      return result;
    },
    {
      detail: { summary: 'Create root', description: 'POST endpoint for root in the vehicles module.', tags: ['Vehicles'] }, body: "vehicle.create" },
  )
  .put(
    "/:id",
    async ({ params, body, set }) => {
      const result = await vehicleService.updateVehicle(
        Number(params.id),
        body,
      );
      if ("errors" in result) {
        set.status = 400;
        return result;
      }
      if ("vehicle" in result && !result.vehicle) {
        set.status = 500;
        return { message: "Failed to load updated vehicle." };
      }
      return result;
    },
    {
      detail: { summary: 'Update by id', description: 'PUT endpoint for by id in the vehicles module.', tags: ['Vehicles'] },
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      body: "vehicle.update",
    },
  )
  .delete(
    "/:id",
    async ({ query, params }) =>
      vehicleService.deleteVehicle(
        Number(params.id),
        Number(query.version || 0),
      ),
    {
      detail: { summary: 'Delete by id', description: 'DELETE endpoint for by id in the vehicles module.', tags: ['Vehicles'] }, params: t.Object({ id: t.Numeric({ minimum: 1 }) }) },
  )
  .get("/cb", async ({ query, user }) => {
    const result = await vehicleService.getVehicleForCombobox(
      query.page ? Number(query.page) : 0,
      query.limit ? Number(query.limit) : 10,
      query.search?.trim() ?? "",
      await staffWarehouse(user) ?? (query.warehouse_id ? Number(query.warehouse_id) : -1),
      {
        scheduledDate: query.scheduled_date?.trim() || undefined,
        scheduledTime: query.scheduled_time?.trim() || undefined,
        estimatedDurationMinutes: query.estimated_duration_minutes
          ? Number(query.estimated_duration_minutes)
          : undefined,
        excludeDeliveryId: query.exclude_delivery_id
          ? Number(query.exclude_delivery_id)
          : undefined,
      },
    );

    return result;
  }, { detail: { summary: 'Get cb', description: 'GET endpoint for cb in the vehicles module.', tags: ['Vehicles'] } })
  .get(
    "/:id/maintenance",
    async ({ params, user }) =>
      vehicleService.getMaintenanceLogs(params.id, await staffWarehouse(user)),
    {
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      detail: {
        summary: "List maintenance & service history logs for a vehicle",
        tags: ["Vehicles"],
      },
    },
  )
  .post(
    "/:id/maintenance",
    async ({ params, body, user }) =>
      vehicleService.createMaintenanceLog(
        params.id,
        Number(user.sub),
        body,
        await staffWarehouse(user),
      ),
    {
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      body: t.Object({
        maintenance_type: t.Union([
          t.Literal("preventive"),
          t.Literal("repair"),
          t.Literal("tire_battery"),
          t.Literal("inspection"),
          t.Literal("breakdown"),
        ]),
        title: t.String({ minLength: 1, maxLength: 160 }),
        description: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
        workshop_name: t.Optional(t.Nullable(t.String({ maxLength: 160 }))),
        odometer_km: t.Optional(t.Nullable(t.Numeric({ minimum: 0 }))),
        estimated_cost: t.Optional(t.Nullable(t.Numeric({ minimum: 0 }))),
        put_in_maintenance: t.Optional(t.Boolean()),
        expected_return_at: t.Optional(t.Nullable(t.String())),
      }),
      detail: {
        summary: "Create a vehicle maintenance or service log",
        tags: ["Vehicles"],
      },
    },
  )
  .patch(
    "/:id/maintenance/:logId",
    async ({ params, body, user }) =>
      vehicleService.updateMaintenanceLog(
        params.id,
        params.logId,
        Number(user.sub),
        body,
        await staffWarehouse(user),
      ),
    {
      params: t.Object({
        id: t.Numeric({ minimum: 1 }),
        logId: t.Numeric({ minimum: 1 }),
      }),
      body: t.Object({
        version: t.Integer({ minimum: 1 }),
        status: t.Union([
          t.Literal("open"),
          t.Literal("in_progress"),
          t.Literal("completed"),
          t.Literal("cancelled"),
        ]),
        actual_cost: t.Optional(t.Nullable(t.Numeric({ minimum: 0 }))),
        odometer_km: t.Optional(t.Nullable(t.Numeric({ minimum: 0 }))),
        next_service_odometer_km: t.Optional(t.Nullable(t.Numeric({ minimum: 0 }))),
        workshop_name: t.Optional(t.Nullable(t.String({ maxLength: 160 }))),
        description: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
        restore_to_available: t.Optional(t.Boolean()),
      }),
      detail: {
        summary: "Update or complete a vehicle maintenance log",
        tags: ["Vehicles"],
      },
    },
  );
