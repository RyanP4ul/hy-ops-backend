import { t } from "elysia";

type Coordinate = {
  id: string;
  name: string;
  lat: number;
  lng: number;
};

type Point = Pick<Coordinate, "lat" | "lng">;

/**
 * Returns the great-circle distance between two coordinates in kilometers.
 * This is a straight-line distance, not a road/OSRM route distance.
 */
export function haversineDistanceKm(from: Point, to: Point): number {
  const earthRadiusKm = 6371.0088;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const deltaLat = toRadians(to.lat - from.lat);
  const deltaLng = toRadians(to.lng - from.lng);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;

  // Clamp to [0, 1] to avoid floating-point edge cases in atan2/sqrt.
  const safeA = Math.min(1, Math.max(0, a));
  const centralAngle = 2 * Math.atan2(Math.sqrt(safeA), Math.sqrt(1 - safeA));

  return earthRadiusKm * centralAngle;
}

/** Sorts every location by distance from the supplied origin, nearest first. */
export function sortCoordinatesByDistance(
  origin: Point,
  locations: Coordinate[],
) {
  return locations
    .map((location, originalIndex) => ({
      location,
      originalIndex,
      exactDistanceKm: haversineDistanceKm(origin, location),
    }))
    .sort(
      (a, b) =>
        a.exactDistanceKm - b.exactDistanceKm ||
        a.originalIndex - b.originalIndex,
    )
    .map(({ location, exactDistanceKm }, index) => ({
      ...location,
      sortOrder: index + 1,
      distanceKm: Number(exactDistanceKm.toFixed(2)),
      distanceMeters: Math.round(exactDistanceKm * 1000),
    }));
}
