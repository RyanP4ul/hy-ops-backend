import { Elysia, t } from "elysia";
import { getDrivingRoute } from "./osrm";
import { estimateDeliveryExpenses } from "./delivery-expense";
import {
  detectTollRoads,
  detectTollRoadsFromOsrmRoadNames,
  unavailableTollDetection,
  type TollDetectionResult,
} from "./toll-detection";

export const deliveryEstimateRoutes = new Elysia({
  prefix: "/delivery-estimates",
}).post(
  "/",
  async ({ body, set }) => {
    try {
      // OSRM calculates the route and returns the OSM node IDs along it.
      const route = await getDrivingRoute(body.points);

      // Toll lookup is best-effort. If Overpass is unavailable, preserve the
      // route/distance/fuel estimate and mark the toll result as unknown.
      let osmDetection: TollDetectionResult;
      try {
        osmDetection = await detectTollRoads(route.osmNodeIds);
      } catch (error) {
        console.warn(
          "[HYOps] OpenStreetMap toll-tag lookup failed:",
          error instanceof Error ? error.message : error,
        );
        osmDetection = unavailableTollDetection(
          error instanceof Error ? error.message : String(error),
        );
      }

      // Prefer actual OSM toll tags. If they're unavailable OR no toll tags
      // matched, use OSRM step road names as a limited expressway fallback.
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
        console.warn(
          "[HYOps] OSRM road-name toll fallback found no known expressway name. Route step names/refs:",
          uniqueRoadNames,
        );
      }

      // A manual tariff estimate can be supplied by HYOps staff or by a future
      // local toll-rate lookup. It must cover the complete trip (both legs when
      // isRoundTrip=true). The old `hasToll` and `estimatedTollFee` fields are
      // accepted below for request compatibility but are intentionally ignored.
      const tollFeeOverride = body.tollFeeOverride;
      // Neither OSRM route names nor OSM tags provide a tariff. Only a manual
      // override makes the toll amount (and final total) known. This avoids
      // silently treating missing OSM tags as a guaranteed zero toll.
      const tollFeeIsKnown = tollFeeOverride !== undefined;
      const estimatedTollFee = tollFeeOverride ?? null;

      const calculationHasToll =
        tollDetection.hasToll === true ||
        (tollFeeOverride !== undefined && tollFeeOverride > 0);

      // The expense helper always receives a number. When a detected toll has
      // no tariff, pass zero only for the intermediate calculation, then expose
      // the payable total as null so HYOps does not present a false total.
      const estimate = estimateDeliveryExpenses({
        distanceKm: route.distanceKm,
        isRoundTrip: body.isRoundTrip,

        allowanceTiers: [
          { maxKm: 10, amount: 150 },
          { maxKm: 25, amount: 250 },
          { maxKm: 50, amount: 400 },
          { maxKm: 100, amount: 600 },
        ],
        allowanceOverMax: 800,

        // Replace these with the assigned vehicle's configuration.
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
      /** Optional manual toll estimate for the whole trip, including return. */
      tollFeeOverride: t.Optional(t.Number({ minimum: 0 })),
      // Deprecated compatibility fields. Toll detection is automatic; these
      // fields are not used to decide whether the route has a toll.
      hasToll: t.Optional(t.Boolean()),
      estimatedTollFee: t.Optional(t.Number({ minimum: 0 })),
    }),
  },
);
