import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildRoutePoints, readTollEstimate } from "../src/modules/delivery-expenses/google-routes";
import { deliveryEstimateRoutes } from "../src/modules/delivery-expenses";

const points = [{ latitude: 14.815, longitude: 120.906 }, { latitude: 14.85, longitude: 120.98 }];
const originalFetch = globalThis.fetch;
const names = ["GOOGLE_ROUTES_API_KEY", "DELIVERY_FUEL_KM_PER_LITER", "DELIVERY_FUEL_PRICE_PHP"] as const;
const originalEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
const route = {
  distanceMeters: 100000, duration: "7200s",
  legs: [{ startLocation: { latLng: points[0] }, endLocation: { latLng: points[1] } }],
  polyline: { geoJsonLinestring: { type: "LineString", coordinates: [[120.906, 14.815], [120.98, 14.85]] } },
};
function googleResponse(tollInfo?: object) {
  return { routes: [{ ...route, travelAdvisory: tollInfo === undefined ? {} : { tollInfo } }] };
}
function respond(data = googleResponse(), status = 200) {
  const fn = mock(async () => Response.json(data, { status }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
async function estimate(extra: object = {}) {
  const response = await deliveryEstimateRoutes.handle(new Request("http://localhost/delivery-estimates/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ points, isRoundTrip: false, ...extra }),
  }));
  return { response, data: await response.json() };
}
beforeEach(() => {
  process.env.GOOGLE_ROUTES_API_KEY = "test-server-key";
  process.env.DELIVERY_FUEL_KM_PER_LITER = "6";
  process.env.DELIVERY_FUEL_PRICE_PHP = "65";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of names) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

describe("Google delivery estimates", () => {
  test("requests Google with warehouse, ordered stops, return leg, and toll field mask", async () => {
    const fn = respond();
    const { response, data } = await estimate({ isRoundTrip: true, fuelConsumptionKmPerLiter: 10, fuelPricePerLiter: 60 });
    expect(response.status).toBe(200);
    const options = (fn.mock.calls[0] as unknown as [string, RequestInit])[1];
    const request = JSON.parse(options.body as string);
    expect(request.origin.location.latLng).toEqual(points[0]);
    expect(request.destination.location.latLng).toEqual(points[0]);
    expect(request.intermediates.map((p: { location: { latLng: object } }) => p.location.latLng)).toEqual([points[1]]);
    expect(request.optimizeWaypointOrder).toBe(false);
    expect(request.extraComputations).toEqual(["TOLLS"]);
    expect((options.headers as Record<string, string>)["X-Goog-FieldMask"]).toContain("routes.travelAdvisory.tollInfo");
    expect(data.route.geometry.coordinates[0]).toEqual([120.906, 14.815]);
    expect(data.route.routeWaypointCount).toBe(3);
    // Google's 100 km already includes the return; never double it again.
    expect(data.expenses.estimatedFuelLiters).toBe(10);
    expect(data.expenses.estimatedFuelCost).toBe(600);
    expect(data.expenses.driverAllowance).toBe(600);
    expect(data.expenses.estimatedTotal).toBe(1200);
  });
  test("keeps the complete ordered stop sequence and does not duplicate an explicit return", () => {
    const more = [...points, { latitude: 15, longitude: 121 }, points[0]];
    expect(buildRoutePoints(more, true)).toEqual(more);
    expect(buildRoutePoints(points, false)).toEqual(points);
    expect(points).toHaveLength(2);
    expect(buildRoutePoints(Array.from({ length: 26 }, (_, n) => ({ latitude: 14 + n / 100, longitude: 121 })), true)).toHaveLength(27);
  });
  test("converts Google Money units and nanos into PHP", async () => {
    respond(googleResponse({ estimatedPrice: [{ currencyCode: "PHP", units: "150", nanos: 500000000 }] }));
    const { data } = await estimate({ fuelConsumptionKmPerLiter: 10, fuelPricePerLiter: 60 });
    expect(data.expenses.estimatedTollFee).toBe(150.5);
    expect(data.expenses.tollFeeStatus).toBe("GOOGLE_ESTIMATE");
    expect(data.expenses.estimatedTotal).toBe(1350.5);
    expect(data.tollDetection.hasToll).toBe(true);
  });
  test("keeps unavailable toll and total unknown", async () => {
    respond(googleResponse({}));
    const { data } = await estimate();
    expect(data.expenses.estimatedTollFee).toBeNull();
    expect(data.expenses.estimatedTotal).toBeNull();
    expect(data.expenses.estimatedTotalExcludingUnknownToll).toBeGreaterThan(0);
    expect(data.tollDetection.hasToll).toBe(true);
  });
  test("no toll information means no toll expected according to Google's contract", async () => {
    respond();
    const { data } = await estimate();
    expect(data.expenses.estimatedTollFee).toBe(0);
    expect(data.expenses.tollFeeStatus).toBe("NO_TOLL_EXPECTED");
    expect(data.tollDetection.hasToll).toBe(false);
  });
  test("does not mix foreign or malformed prices into PHP totals", () => {
    for (const price of [{ currencyCode: "USD", units: "5" }, { currencyCode: "PHP", units: "invalid" }]) {
      expect(readTollEstimate({ estimatedPrice: [price] }).estimatedTollFee).toBeNull();
    }
    expect(readTollEstimate({ estimatedPrice: [{ currencyCode: "PHP" }] }).estimatedTollFee).toBe(0);
  });
  test("accepts a manual full trip toll, including explicit zero", async () => {
    for (const fee of [0, 350.25]) {
      respond(googleResponse({}));
      const { data } = await estimate({ tollFeeOverride: fee });
      expect(data.expenses.estimatedTollFee).toBe(fee);
      expect(data.expenses.tollFeeStatus).toBe("MANUAL_OVERRIDE");
      expect(data.expenses.estimatedTotal).toBe(data.expenses.estimatedTotalExcludingUnknownToll + fee);
    }
  });
  test("uses configurable defaults and allows zero fuel price", async () => {
    process.env.DELIVERY_FUEL_KM_PER_LITER = "10";
    process.env.DELIVERY_FUEL_PRICE_PHP = "70";
    respond();
    const { data } = await estimate();
    expect(data.expenses.estimatedFuelCost).toBe(700);
    const config = await deliveryEstimateRoutes.handle(new Request("http://localhost/delivery-estimates/config"));
    expect(await config.json()).toEqual({ fuelConsumptionKmPerLiter: 10, fuelPricePerLiter: 70 });
    const zero = await estimate({ fuelPricePerLiter: 0 });
    expect(zero.data.expenses.estimatedFuelCost).toBe(0);
  });
  test("rejects invalid coordinates, fuel inputs, and oversized trips before calling Google", async () => {
    const fn = respond();
    for (const extra of [
      { fuelConsumptionKmPerLiter: 0 }, { fuelPricePerLiter: -1 }, { tollFeeOverride: -1 },
      { points: [{ latitude: 91, longitude: 0 }, points[1]] }, { points: [points[0]] },
      { points: Array(27).fill(points[0]) },
    ]) {
      expect((await estimate(extra)).response.status).toBe(422);
    }
    expect(fn).not.toHaveBeenCalled();
  });
  test("missing backend key returns an actionable error without a network call", async () => {
    delete process.env.GOOGLE_ROUTES_API_KEY;
    const fn = respond();
    const { response, data } = await estimate();
    expect(response.status).toBe(422);
    expect(data.message).toContain("GOOGLE_ROUTES_API_KEY");
    expect(fn).not.toHaveBeenCalled();
  });
  test("handles authorization, quota, and other HTTP failures without leaking payloads", async () => {
    for (const status of [403, 429, 500]) {
      respond({ secret: "private payload" } as never, status);
      const { response, data } = await estimate();
      expect(response.status).toBe(422);
      expect(data.message).not.toContain("private payload");
      expect(data.expenses).toBeUndefined();
    }
  });
  test("handles unreachable Google and empty routes", async () => {
    globalThis.fetch = mock(async () => { throw new Error("network"); }) as unknown as typeof fetch;
    expect((await estimate()).data.message).toContain("timed out");
    respond({ routes: [] } as never);
    expect((await estimate()).data.message).toContain("no driving route");
  });
  test("rejects an incomplete Google geometry", async () => {
    respond({ routes: [{ distanceMeters: 500, duration: "10s" }] } as never);
    expect((await estimate()).response.status).toBe(422);
  });
  test("invalid configured efficiency fails rather than producing infinity", async () => {
    process.env.DELIVERY_FUEL_KM_PER_LITER = "0";
    respond();
    expect((await estimate()).data.message).toContain("DELIVERY_FUEL_KM_PER_LITER");
  });
});

