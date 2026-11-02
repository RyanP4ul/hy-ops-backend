type Coordinate = {
  latitude: number;
  longitude: number;
};

export interface OsrmRoadSegment {
  /** OSRM's name for the road used by this route step, if mapped. */
  name: string | null;
  /** OSRM's OSM road reference, e.g. NLEX, if present. */
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
    /** OSM node IDs along this route leg, when annotations=nodes is requested. */
    nodes?: number[];
  };
  steps?: OsrmRouteStep[];
}

interface OsrmRouteResponse {
  code: string;
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

export async function getDrivingRoute(points: Coordinate[]) {
  if (points.length < 2) {
    throw new Error("At least two route points are required.");
  }

  for (const point of points) {
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      point.latitude < -90 ||
      point.latitude > 90 ||
      point.longitude < -180 ||
      point.longitude > 180
    ) {
      throw new Error("Invalid route coordinates.");
    }
  }

  // OSRM expects longitude,latitude.
  const coordinates = points
    .map((point) => `${point.longitude},${point.latitude}`)
    .join(";");

  const url = new URL(
    `https://router.project-osrm.org/route/v1/driving/${coordinates}`,
  );

  url.searchParams.set("overview", "full");
  url.searchParams.set("geometries", "geojson");
  // Route steps expose road names/references for the fallback heuristic.
  url.searchParams.set("steps", "true");
  // Route node IDs can still be checked against OSM toll tags when Overpass works.
  url.searchParams.set("annotations", "nodes");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `Unable to calculate the driving route (OSRM HTTP ${response.status}).`,
    );
  }

  const data = (await response.json()) as OsrmRouteResponse;

  if (data.code !== "Ok" || !data.routes?.[0]) {
    throw new Error(`No driving route was found (OSRM code: ${data.code}).`);
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
  };
}
