import { Elysia, t } from "elysia";
import { getDrivingRoute } from "./osrm";
import { estimateDeliveryExpenses } from "./delivery-expense";
import {
  detectTollRoads,
  detectTollRoadsFromOsrmRoadNames,
  unavailableTollDetection,
  type TollDetectionResult,
} from "./toll-detection";

type Coordinate = { latitude: number; longitude: number };

function sameCoordinate(a: Coordinate, b: Coordinate): boolean {
  return (
    Math.abs(a.latitude - b.latitude) < 1e-7 &&
    Math.abs(a.longitude - b.longitude) < 1e-7
  );
}

export const deliveryEstimateRoutes = new Elysia({
  prefix: "/delivery-estimates",
  detail: { tags: ["Delivery Expenses"] },
}).post(
  "/",
  async ({ body, set }) => {
    try {
      // `points` are visited in the supplied order: warehouse, delivery stops,
      // and optionally the warehouse again when isRoundTrip is true.
      const routePoints = [...body.points];
      if (body.isRoundTrip) {
        const firstPoint = routePoints[0]!;
        const lastPoint = routePoints[routePoints.length - 1]!;
        if (!sameCoordinate(firstPoint, lastPoint)) {
          routePoints.push(firstPoint);
        }
      }

      const route = await getDrivingRoute(routePoints);

      let osmDetection: TollDetectionResult;
      try {
        osmDetection = await detectTollRoads(route.osmNodeIds);
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        console.warn("[HYOps] OpenStreetMap toll-tag lookup failed:", details);
        osmDetection = unavailableTollDetection(details);
      }

      // Fall back to OSRM road names if OSM toll tags are unavailable or no tags matched.
      const osrmNameDetection =
        osmDetection.status === "DETECTED"
          ? null
          : detectTollRoadsFromOsrmRoadNames(route.roadSegments);
      const tollDetection = osrmNameDetection ?? osmDetection;

      if (osmDetection.status === "UNAVAILABLE" && !osrmNameDetection) {
        const uniqueRoadNames = [
          ...new Map(
            route.roadSegments
              .filter((segment) => segment.name || segment.ref)
              .map((segment) => [
                `${segment.ref ?? ""}|${segment.name ?? ""}`,
                { name: segment.name, ref: segment.ref },
              ]),
          ).values(),
        ];
        console.warn("[HYOps] OSRM name fallback found no known expressway name. Route names/refs:", uniqueRoadNames);
      }

      const tollFeeOverride = body.tollFeeOverride;
      const tollFeeIsKnown = tollFeeOverride !== undefined;
      const estimatedTollFee = tollFeeOverride ?? null;
      const calculationHasToll =
        tollDetection.hasToll === true ||
        (tollFeeOverride !== undefined && tollFeeOverride > 0);

      // The distance already includes the return leg when a round trip was requested.
      // Therefore don't double it again inside the expense calculator.
      const estimate = estimateDeliveryExpenses({
        distanceKm: route.distanceKm,
        isRoundTrip: false,
        allowanceTiers: [
          { maxKm: 10, amount: 150 },
          { maxKm: 25, amount: 250 },
          { maxKm: 50, amount: 400 },
          { maxKm: 100, amount: 600 },
        ],
        allowanceOverMax: 800,
        fuelConsumptionKmPerLiter: 6,
        fuelPricePerLiter: 65,
        hasToll: calculationHasToll,
        estimatedTollFee: tollFeeOverride ?? 0,
      });

      const estimatedTotalExcludingUnknownToll =
        estimate.driverAllowance + estimate.estimatedFuelCost;
      const estimatedTotal = tollFeeIsKnown
        ? estimatedTotalExcludingUnknownToll + (estimatedTollFee ?? 0)
        : null;

      return {
        route: {
          distanceKm: route.distanceKm,
          durationMinutes: Math.round(route.durationSeconds / 60),
          geometry: route.geometry,
          inputPointCount: body.points.length,
          routeWaypointCount: route.waypoints.length,
          legCount: route.legCount,
          isRoundTrip: body.isRoundTrip,
          waypoints: route.waypoints,
        },
        tollDetection,
        expenses: {
          ...estimate,
          hasToll: tollDetection.hasToll,
          estimatedTollFee,
          estimatedTotal,
          estimatedTotalExcludingUnknownToll,
          tollFeeStatus:
            tollFeeOverride !== undefined
              ? "MANUAL_OVERRIDE"
              : tollDetection.status === "UNAVAILABLE"
                ? "DETECTION_UNAVAILABLE"
                : tollDetection.hasToll === true
                  ? "MANUAL_ENTRY_REQUIRED"
                  : "NO_TOLL_TAG_FOUND",
        },
      };
    } catch (error) {
      console.error("[HYOps] Failed to calculate delivery estimate:", error);
      set.status = 422;
      return {
        message:
          error instanceof Error
            ? error.message
            : "Unable to estimate delivery expenses.",
      };
    }
  },
  {
    body: t.Object({
      points: t.Array(
        t.Object({
          latitude: t.Number({ minimum: -90, maximum: 90 }),
          longitude: t.Number({ minimum: -180, maximum: 180 }),
        }),
        { minItems: 2, maxItems: 30 },
      ),
      isRoundTrip: t.Boolean(),
      /** Optional fee for the complete trip, including return leg when applicable. */
      tollFeeOverride: t.Optional(t.Number({ minimum: 0 })),
      // Deprecated compatibility fields; toll detection is automatic.
      hasToll: t.Optional(t.Boolean()),
      estimatedTollFee: t.Optional(t.Number({ minimum: 0 })),
    }),
    detail: {
      summary: "Estimate delivery expenses",
      description: "Calculate route distance, toll detection, and estimated delivery expenses.",
      tags: ["Delivery Expenses"],
    },
  },
);
