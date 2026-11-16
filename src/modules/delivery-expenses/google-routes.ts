export type Coordinate = { latitude: number; longitude: number };
type Money = { currencyCode?: string; units?: string; nanos?: number };
type TollInfo = { estimatedPrice?: Money[] };
type GoogleRoute = {
  distanceMeters?: number;
  duration?: string;
  polyline?: { geoJsonLinestring?: { type: "LineString"; coordinates: [number, number][] } };
  legs?: unknown[];
  travelAdvisory?: { tollInfo?: TollInfo };
};

export function readTollEstimate(tollInfo: TollInfo | undefined) {
  if (!tollInfo) return { hasToll: false, estimatedTollFee: 0, tollFeeStatus: "NO_TOLL_EXPECTED" } as const;
  const prices = tollInfo.estimatedPrice;
  // Never add foreign currencies to PHP expenses or interpret a missing price as zero.
  const known = prices?.length && prices.every(price => price.currencyCode === "PHP" &&
    Number.isFinite(Number(price.units ?? 0)) && Number.isFinite(price.nanos ?? 0) &&
    Number(price.units ?? 0) + (price.nanos ?? 0) / 1e9 >= 0);
  const estimatedTollFee = known
    ? Math.round(prices.reduce((sum, price) => sum + Number(price.units ?? 0) + (price.nanos ?? 0) / 1e9, 0) * 100) / 100
    : null;
  return { hasToll: true, estimatedTollFee, tollFeeStatus: estimatedTollFee === null ? "PRICE_UNAVAILABLE" : "GOOGLE_ESTIMATE" } as const;
}

/** Preserve stop order, reserving one point for a possible warehouse return. */
export function buildRoutePoints(points: Coordinate[], isRoundTrip: boolean) {
  if (points.length < 2 || points.length > 26) throw new Error("Use 2 to 26 route points, including the warehouse.");
  for (const point of points) {
    if (!Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
        !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180) {
      throw new Error("Invalid route coordinates.");
    }
  }
  const result = [...points];
  const first = result[0];
  const last = result[result.length - 1];
  if (isRoundTrip && (Math.abs(first.latitude - last.latitude) >= 1e-7 || Math.abs(first.longitude - last.longitude) >= 1e-7)) result.push(first);
  return result;
}

export async function getGoogleDrivingRoute(points: Coordinate[]) {
  const key = process.env.GOOGLE_ROUTES_API_KEY;
  if (!key) throw new Error("Google routing is not configured. Set GOOGLE_ROUTES_API_KEY on the backend and enable Routes API and billing.");
  const waypoint = (point: Coordinate) => ({ location: { latLng: point } });
  let response: Response;
  try {
    response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.geoJsonLinestring,routes.legs.startLocation,routes.legs.endLocation,routes.travelAdvisory.tollInfo",
      },
      body: JSON.stringify({
        origin: waypoint(points[0]), destination: waypoint(points[points.length - 1]),
        intermediates: points.slice(1, -1).map(waypoint),
        travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE",
        optimizeWaypointOrder: false, polylineEncoding: "GEO_JSON_LINESTRING",
        polylineQuality: "HIGH_QUALITY", extraComputations: ["TOLLS"],
        units: "METRIC", regionCode: "PH",
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Google routing could not be reached or timed out. Please retry.");
  }
  // Do not forward raw Google errors containing configuration details.
  if (!response.ok) {
	console.log(response);
    throw new Error(response.status === 403 || response.status === 401
    ? "Google Routes authorization failed. Check the backend API key, API restrictions, enabled Routes API, and billing."
    : response.status === 429 ? "Google Routes quota was exceeded. Please retry later."
    : `Google could not calculate this route (HTTP ${response.status}).`);
  }
  const data = await response.json() as { routes?: GoogleRoute[] };
  const route = data.routes?.[0];
  if (!route) throw new Error("Google found no driving route through these stops.");
  const distanceMeters = route.distanceMeters ?? 0; // Protobuf omits zero-valued scalars.
  const durationSeconds = Number((route.duration ?? "0s").replace(/s$/, ""));
  const geometry = route.polyline?.geoJsonLinestring;
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0 || !Number.isFinite(durationSeconds) || durationSeconds < 0 ||
      geometry?.type !== "LineString" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2 ||
      geometry.coordinates.some(point => !Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) {
    throw new Error("Google returned incomplete route information. Please retry.");
  }
  return {
    distanceKm: distanceMeters / 1000, durationSeconds, geometry,
    legCount: route.legs?.length ?? points.length - 1,
    ...readTollEstimate(route.travelAdvisory?.tollInfo),
  };
}

