type Coordinate = {
  latitude: number;
  longitude: number;
};

interface OsrmRouteResponse {
  code: string;
  routes?: {
    distance: number;
    duration: number;
    geometry: {
      type: "LineString";
      coordinates: [number, number][];
    };
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
  url.searchParams.set("steps", "false");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error("Unable to calculate the driving route.");
  }

  const data = (await response.json()) as OsrmRouteResponse;

  if (data.code !== "Ok" || !data.routes?.[0]) {
    throw new Error("No driving route was found.");
  }

  const route = data.routes[0];

  return {
    distanceMeters: route.distance,
    distanceKm: route.distance / 1000,
    durationSeconds: route.duration,
    geometry: route.geometry,
  };
}
