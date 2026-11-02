import { coordinates } from "../../utils/coordinates";

export const WAREHOUSE_ARRIVAL_RADIUS_M = 100;
export const WAREHOUSE_ARRIVAL_MAX_ACCURACY_M = 50;
// Legacy key requested by the application; its value is metres, not milliseconds.
export const WAREHOUSE_ARRIVAL_SETTING = "returning_automatic_confirm_ms_interval";

export function parseWarehouseArrivalRadius(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const radius = Number(value);
  return Number.isInteger(radius) && radius >= 50 && radius <= 1000 ? radius : null;
}

/** Require the entire GPS accuracy radius to fall inside the warehouse geofence. */
export function isWarehouseArrival(
  fix: { latitude: number; longitude: number; accuracy_m: number | null; recorded_at: Date },
  warehouse: { latitude: unknown; longitude: unknown },
  returningSince: Date,
  now = Date.now(),
  radiusM = WAREHOUSE_ARRIVAL_RADIUS_M,
) {
  if (!Number.isFinite(radiusM) || radiusM < 50 || radiusM > 1000) return false;
  const destination = coordinates(warehouse.latitude, warehouse.longitude);
  if (!destination || !coordinates(fix.latitude, fix.longitude)) return false;
  const age = now - fix.recorded_at.getTime();
  if (!Number.isFinite(age) || age < -30_000 || age > 60_000 || fix.recorded_at < returningSince) return false;
  if (fix.accuracy_m === null || !Number.isFinite(fix.accuracy_m) || fix.accuracy_m < 0 || fix.accuracy_m > WAREHOUSE_ARRIVAL_MAX_ACCURACY_M) return false;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const lat = radians(fix.latitude), destLat = radians(Number(destination.latitude));
  const a = Math.sin((destLat - lat) / 2) ** 2
    + Math.cos(lat) * Math.cos(destLat) * Math.sin(radians(Number(destination.longitude) - fix.longitude) / 2) ** 2;
  const distance = 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
  return distance + fix.accuracy_m <= radiusM;
}
