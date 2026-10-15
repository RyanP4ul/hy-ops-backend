import Elysia, { t } from "elysia";
import { AuthUser } from "../auth/schema";
import { vehicleModel } from "./model";
import { vehicleService } from "./service";

export const vehicleRoutes = new Elysia({ prefix: "/vehicles" })
  .use(vehicleModel)
  .decorate("user", AuthUser)
  .get("/", async ({ query, set }) => {
    const result = await vehicleService.getVehicles(
      query.page ? Number(query.page) : 0,
      query.limit ? Number(query.limit) : 10,
      query.search?.trim() ?? "",
      query.sort_by ? String(query.sort_by) : "id:desc",
    );
    set.headers["X-Total-Count"] = String(result.total);
    return result.rows;
  })
  .get("/:id", async ({ params, set }) => {
    const vehicle = await vehicleService.getVehicleById(Number(params.id));
    if (!vehicle) {
      set.status = 404;
      return { message: "Vehicle not found" };
    }
    return vehicle;
  })
  .post(
    "/",
    async ({ body, set }) => {
      const result = await vehicleService.createVehicle(body);
      if ("errors" in result) {
        set.status = 400;
        return result;
      }
      return result;
    },
    { body: "vehicle.create" },
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
      return result;
    },
    {
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
    { params: t.Object({ id: t.Numeric({ minimum: 1 }) }) },
  );
