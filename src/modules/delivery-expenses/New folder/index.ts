import { Elysia, t } from "elysia";
import { getDrivingRoute } from "./osrm";
import { estimateDeliveryExpenses } from "./delivery-expense";
import {
  detectTollRoads,
  unavailableTollDetection,
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
      const tollDetection = await detectTollRoads(route.osmNodeIds).catch(() =>
        unavailableTollDetection(),
      );

      // A manual tariff estimate can be supplied by HYOps staff or by a future
      // local toll-rate lookup. It must cover the complete trip (both legs when
      // isRoundTrip=true). The old `hasToll` and `estimatedTollFee` fields are
      // accepted below for request compatibility but are intentionally ignored.
      const tollFeeOverride = body.tollFeeOverride;
      const tollFeeIsKnown =
        tollFeeOverride !== undefined || tollDetection.hasToll === false;
      const estimatedTollFee =
        tollFeeOverride !== undefined
          ? tollFeeOverride
          : tollDetection.hasToll === false
            ? 0
            : null;

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
              : tollDetection.hasToll === false
                ? "NO_TOLL_TAG_FOUND"
                : tollDetection.hasToll === true
                  ? "MANUAL_ENTRY_REQUIRED"
                  : "DETECTION_UNAVAILABLE",
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
