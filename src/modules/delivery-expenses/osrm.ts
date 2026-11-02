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
