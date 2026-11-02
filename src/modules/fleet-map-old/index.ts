import Elysia, { t } from "elysia";
import { FleetMapService } from "./service";
import { fleetMapModel } from "./model";
import { sortCoordinatesByDistance } from "../../utils/coordination";

export const fleetMapRoutes = new Elysia({
  prefix: "/fleet-map",
})
  .use(fleetMapModel)
  .get("/", async () => {
    return await FleetMapService.getFleetMap();
  })
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
