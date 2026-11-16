import { Elysia, t } from "elysia";
import { buildRoutePoints, getGoogleDrivingRoute } from "./google-routes";
import { estimateDeliveryExpenses } from "./delivery-expense";

function configuredNumber(name: string, fallback: number, allowZero = false) {
  const raw = process.env[name];
  const value = raw?.trim() ? Number(raw) : fallback;
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) throw new Error(`Invalid backend configuration: ${name}.`);
  return value;
}

export function expenseDefaults() {
  return {
    fuelConsumptionKmPerLiter: configuredNumber("DELIVERY_FUEL_KM_PER_LITER", 6),
    fuelPricePerLiter: configuredNumber("DELIVERY_FUEL_PRICE_PHP", 65, true),
  };
}

export const deliveryEstimateRoutes = new Elysia({
  prefix: "/delivery-estimates", detail: { tags: ["Delivery Expenses"] },
})
  .get("/config", () => expenseDefaults())
  .post("/", async ({ body, set }) => {
    try {
      const points = buildRoutePoints(body.points, body.isRoundTrip);
      const defaults = expenseDefaults();
      const fuelConsumptionKmPerLiter = body.fuelConsumptionKmPerLiter ?? defaults.fuelConsumptionKmPerLiter;
      const fuelPricePerLiter = body.fuelPricePerLiter ?? defaults.fuelPricePerLiter;
      const route = await getGoogleDrivingRoute(points);
      const estimatedTollFee = body.tollFeeOverride ?? route.estimatedTollFee;
      const hasToll = route.hasToll || (body.tollFeeOverride ?? 0) > 0;
      const estimate = estimateDeliveryExpenses({
        distanceKm: route.distanceKm, isRoundTrip: false,
        allowanceTiers: [{ maxKm: 10, amount: 150 }, { maxKm: 25, amount: 250 }, { maxKm: 50, amount: 400 }, { maxKm: 100, amount: 600 }],
        allowanceOverMax: 800, fuelConsumptionKmPerLiter, fuelPricePerLiter,
        hasToll, estimatedTollFee: estimatedTollFee ?? 0,
      });
      const subtotal = estimate.driverAllowance + estimate.estimatedFuelCost;
      return {
        route: { source: "Google Routes", distanceKm: route.distanceKm,
          durationMinutes: Math.round(route.durationSeconds / 60), geometry: route.geometry,
          inputPointCount: body.points.length, routeWaypointCount: points.length,
          legCount: route.legCount, isRoundTrip: body.isRoundTrip },
        tollDetection: {
          status: hasToll ? "DETECTED" : "NO_TOLL_EXPECTED", hasToll, source: "Google Routes",
          note: "Google toll coverage varies by location. Prices apply to non-commercial vehicles; verify the toll class for delivery trucks. An unavailable price requires manual entry.",
        },
        expenses: { ...estimate, hasToll, estimatedTollFee,
          estimatedTotal: estimatedTollFee === null ? null : subtotal + estimatedTollFee,
          estimatedTotalExcludingUnknownToll: subtotal,
          tollFeeStatus: body.tollFeeOverride !== undefined ? "MANUAL_OVERRIDE" : route.tollFeeStatus,
          fuelConsumptionKmPerLiter, fuelPricePerLiter, fuelSource: "DISTANCE_AND_VEHICLE_EFFICIENCY" },
      };
    } catch (error) {
      set.status = 422;
      return { message: error instanceof Error ? error.message : "Unable to estimate delivery expenses." };
    }
  }, {
    body: t.Object({
      points: t.Array(t.Object({ latitude: t.Number({ minimum: -90, maximum: 90 }), longitude: t.Number({ minimum: -180, maximum: 180 }) }), { minItems: 2, maxItems: 26 }),
      isRoundTrip: t.Boolean(),
      fuelConsumptionKmPerLiter: t.Optional(t.Number({ exclusiveMinimum: 0 })),
      fuelPricePerLiter: t.Optional(t.Number({ minimum: 0 })),
      tollFeeOverride: t.Optional(t.Number({ minimum: 0 })),
    }),
    detail: { summary: "Estimate delivery expenses using Google Routes", tags: ["Delivery Expenses"] },
  });
