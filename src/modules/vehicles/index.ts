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
    );

    return result;
  }, { detail: { summary: 'Get cb', description: 'GET endpoint for cb in the vehicles module.', tags: ['Vehicles'] } });
