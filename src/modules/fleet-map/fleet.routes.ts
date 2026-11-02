import { AuthUser } from "../auth/schema";
import { Elysia, t } from "elysia";
import {
  AssignWarehouseBody,
  fleetMapModel,
  FleetOverviewDto,
} from "./fleet.model";
import {
  assignVehicleWarehouse,
  getFleetOverview,
  getLatestPositions,
  recordPosition,
} from "./fleet.service";
import { sortCoordinatesByDistance } from "../../utils/coordination";
import { PositionIngestBody, PositionsResponse } from "./fleet.model";

export const fleetRoutes = new Elysia({
  prefix: "/fleet",
  name: "fleet.routes",
  detail: { tags: ["Fleet"] },
})
  /** One call hydrates the whole map: vehicles (with trips/stops/orders) + warehouses. */
  .decorate("user", {} as AuthUser)
  .use(fleetMapModel)
  .get("/", ({ user }) => getFleetOverview(user), { response: FleetOverviewDto })
  .get(
    "/positions",
    () => {
      const positions = getLatestPositions();
      return positions;
    },
    {
      response: PositionsResponse,
    },
  )
  .patch(
    "/vehicles/:id/warehouse",
    ({ params, body }) => assignVehicleWarehouse(params.id, body.warehouseId),
    {
      params: t.Object({ id: t.Numeric() }),
      body: AssignWarehouseBody,
      response: t.Object({ ok: t.Literal(true) }),
    },
  )
  .post(
    "/coordinates/sort",
    ({ body }) => {
      const sortedLocations = sortCoordinatesByDistance(
        body.origin,
        body.locations,
      );

      return {
        origin: body.origin,
        count: sortedLocations.length,
        sortedBy: "distance_from_origin_ascending",
        distanceType: "straight_line",
        locations: sortedLocations,
      };
    },
    {
      body: "fleetmap.point_and_coordinate",
      detail: {
        summary: "Sort coordinates from nearest to farthest",
        description:
          "Calculates straight-line Haversine distance from an origin and sorts locations in ascending order.",
        tags: ["Coordinates"],
      },
    },
  );
