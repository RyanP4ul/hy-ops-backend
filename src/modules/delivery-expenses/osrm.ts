type Coordinate = {
  latitude: number;
  longitude: number;
};

export interface OsrmRoadSegment {
  /** OSRM's name for the road used by this route step, if mapped. */
  name: string | null;
  /** OSM road reference, e.g. NLEX, if present. */
  ref: string | null;
  distanceMeters: number;
}

interface OsrmRouteStep {
  name?: string;
  ref?: string;
  distance: number;
}

interface OsrmLeg {
  annotation?: {
    /** OSM node IDs along this route leg when annotations=nodes is requested. */
    nodes?: number[];
  };
  steps?: OsrmRouteStep[];
}

interface OsrmWaypoint {
  name?: string;
  location: [number, number];
  distance: number;
  waypoint_index?: number;
}

interface OsrmRouteResponse {
  code: string;
  message?: string;
  waypoints?: OsrmWaypoint[];
  routes?: {
    distance: number;
    duration: number;
    geometry: {
      type: "LineString";
      coordinates: [number, number][];
    };
    legs?: OsrmLeg[];
  }[];
}

/**
 * Calculates one driving route through every supplied point, in array order.
 * OSRM expects longitude,latitude coordinates separated by semicolons.
 */
export async function getDrivingRoute(points: Coordinate[]) {
  if (points.length < 2) {
    throw new Error("At least two route points are required: a start and a destination.");
  }

  if (points.length > 31) {
    throw new Error("A route can contain at most 31 points, including a return to the warehouse.");
  }

  for (const [index, point] of points.entries()) {
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      point.latitude < -90 ||
      point.latitude > 90 ||
      point.longitude < -180 ||
      point.longitude > 180
    ) {
      throw new Error(`Invalid coordinates for route point ${index + 1}.`);
    }
  }

  const coordinates = points
    .map((point) => `${point.longitude},${point.latitude}`)
    .join(";");

  const url = new URL(
    `https://router.project-osrm.org/route/v1/driving/${coordinates}`,
  );
  url.searchParams.set("overview", "full");
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("steps", "true");
  url.searchParams.set("annotations", "nodes");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Unable to calculate the driving route (OSRM HTTP ${response.status}).`);
  }

  const data = (await response.json()) as OsrmRouteResponse;
  if (data.code !== "Ok" || !data.routes?.[0]) {
    throw new Error(
      data.message ?? `No driving route was found (OSRM code: ${data.code}).`,
    );
  }

  const route = data.routes[0];
  const legs = route.legs ?? [];
  const osmNodeIds = legs.flatMap((leg) => leg.annotation?.nodes ?? []);
  const roadSegments: OsrmRoadSegment[] = legs.flatMap((leg) =>
    (leg.steps ?? []).map((step) => ({
      name: step.name?.trim() || null,
      ref: step.ref?.trim() || null,
      distanceMeters: Number.isFinite(step.distance) ? step.distance : 0,
    })),
  );

  return {
    distanceMeters: route.distance,
    distanceKm: route.distance / 1000,
    durationSeconds: route.duration,
    geometry: route.geometry,
    osmNodeIds,
    roadSegments,
    waypoints: (data.waypoints ?? []).map((waypoint) => ({
      name: waypoint.name?.trim() || null,
      location: waypoint.location,
      distanceFromRoadMeters: waypoint.distance,
    })),
    legCount: legs.length,
  };
}

export type OptimizableStop = {
  orderId: number;
  latitude: number;
  longitude: number;
};

function haversineKm(a: Coordinate, b: Coordinate): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * sinLng * sinLng;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function nearestNeighborOrder(
  origin: Coordinate,
  stops: OptimizableStop[],
): OptimizableStop[] {
  const remaining = [...stops];
  const ordered: OptimizableStop[] = [];
  let current: Coordinate = origin;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const dist = haversineKm(current, remaining[i]);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    const [next] = remaining.splice(bestIdx, 1);
    ordered.push(next);
    current = next;
  }
  return ordered;
}

function pathHaversineKm(origin: Coordinate, stops: OptimizableStop[]): number {
  let total = 0;
  let current = origin;
  for (const stop of stops) {
    total += haversineKm(current, stop);
    current = stop;
  }
  total += haversineKm(current, origin);
  return total;
}

/**
 * Optimizes multi-stop visiting order starting from the warehouse using OSRM's
 * Traveling Salesperson (/trip) endpoint, falling back to deterministic
 * nearest-neighbor Haversine sorting if OSRM is unavailable.
 */
export async function optimizeStopSequence(
  origin: Coordinate,
  stops: OptimizableStop[],
): Promise<{
  optimizedOrderIds: number[];
  originalDistanceKm: number;
  optimizedDistanceKm: number;
  savedDistanceKm: number;
  estimatedDurationMinutes: number | null;
  source: "OSRM Trip" | "Haversine Nearest-Neighbor";
}> {
  if (stops.length <= 1) {
    const dist = pathHaversineKm(origin, stops);
    return {
      optimizedOrderIds: stops.map((s) => s.orderId),
      originalDistanceKm: Number(dist.toFixed(2)),
      optimizedDistanceKm: Number(dist.toFixed(2)),
      savedDistanceKm: 0,
      estimatedDurationMinutes: null,
      source: "Haversine Nearest-Neighbor",
    };
  }

  const originalEstimateKm = pathHaversineKm(origin, stops);
  const allPoints = [origin, ...stops];
  const coords = allPoints.map((p) => `${p.longitude},${p.latitude}`).join(";");

  try {
    const url = new URL(
      `https://router.project-osrm.org/trip/v1/driving/${coords}`,
    );
    url.searchParams.set("source", "first");
    url.searchParams.set("roundtrip", "true");
    url.searchParams.set("overview", "false");

    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const data = (await response.json()) as {
        code?: string;
        trips?: { distance: number; duration: number }[];
        waypoints?: { waypoint_index: number }[];
      };
      if (
        data.code === "Ok" &&
        data.trips?.[0] &&
        data.waypoints?.length === allPoints.length
      ) {
        const waypoints = data.waypoints;
        // waypoints[i] corresponds to input point i; waypoint_index is its visit rank.
        const stopRanks = stops.map((stop, idx) => ({
          orderId: stop.orderId,
          rank: waypoints[idx + 1]?.waypoint_index ?? idx + 1,
        }));
        stopRanks.sort((a, b) => a.rank - b.rank);
        const optimizedKm = data.trips[0].distance / 1000;
        return {
          optimizedOrderIds: stopRanks.map((s) => s.orderId),
          originalDistanceKm: Number(originalEstimateKm.toFixed(2)),
          optimizedDistanceKm: Number(optimizedKm.toFixed(2)),
          savedDistanceKm: Number(
            Math.max(0, originalEstimateKm - optimizedKm).toFixed(2),
          ),
          estimatedDurationMinutes: Math.round(data.trips[0].duration / 60),
          source: "OSRM Trip",
        };
      }
    }
  } catch {
    // Fall back deterministically when OSRM is unreachable or rate-limited.
  }

  const fallbackOrder = nearestNeighborOrder(origin, stops);
  const fallbackKm = pathHaversineKm(origin, fallbackOrder);
  return {
    optimizedOrderIds: fallbackOrder.map((s) => s.orderId),
    originalDistanceKm: Number(originalEstimateKm.toFixed(2)),
    optimizedDistanceKm: Number(fallbackKm.toFixed(2)),
    savedDistanceKm: Number(
      Math.max(0, originalEstimateKm - fallbackKm).toFixed(2),
    ),
    estimatedDurationMinutes: null,
    source: "Haversine Nearest-Neighbor",
  };
}
