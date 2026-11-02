export function coordinates(latitude: unknown, longitude: unknown): { latitude: string; longitude: string } | null {
  if (latitude === null || latitude === undefined || longitude === null || longitude === undefined || latitude === "" || longitude === "") return null;
  const lat = Number(latitude), lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { latitude: lat.toFixed(6), longitude: lon.toFixed(6) };
}
