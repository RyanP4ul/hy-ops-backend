import { Elysia, t } from "elysia";
import { getDrivingRoute } from "./osrm";
import { estimateDeliveryExpenses } from "./delivery-expense";

export const deliveryEstimateRoutes = new Elysia({
  prefix: "/delivery-estimates",
}).post(
  "/",
  async ({ body, set }) => {
    try {
      // In production, load these policies from PostgreSQL.
      const route = await getDrivingRoute(body.points);

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

        // Replace with the assigned vehicle's configuration.
        fuelConsumptionKmPerLiter: 6,
        fuelPricePerLiter: 65,

        // Replace these with your toll detection and estimate.
        hasToll: body.hasToll,
        estimatedTollFee: body.estimatedTollFee,
      });

      return {
        route: {
          distanceKm: route.distanceKm,
          durationMinutes: Math.round(route.durationSeconds / 60),
          geometry: route.geometry,
        },
        expenses: estimate,
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
          latitude: t.Number({
            minimum: -90,
            maximum: 90,
          }),
          longitude: t.Number({
            minimum: -180,
            maximum: 180,
          }),
        }),
        { minItems: 2, maxItems: 30 },
      ),
      isRoundTrip: t.Boolean(),
      hasToll: t.Boolean(),
      estimatedTollFee: t.Number({ minimum: 0 }),
    }),
  },
);
