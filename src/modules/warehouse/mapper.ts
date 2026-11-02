import type { warehouses } from "../../db/schema";
import type { WarehouseDto } from "./model";

type WarehouseRow = typeof warehouses.$inferSelect;

/** Returns null when the row has no usable coordinates (the map cannot place it). */
export function toWarehouseDto(row: WarehouseRow): WarehouseDto | null {
  if (row.latitude === null || row.longitude === null) return null;

  const longitude = Number(row.longitude);
  const latitude = Number(row.latitude);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;

  return {
    id: String(row.id),
    name: row.name,
    streetAddress: row.street_address,
    city: row.city,
    state: row.state,
    zipCode: row.zip_code,
    address: `${row.street_address}, ${row.city}, ${row.state} ${row.zip_code}`,
    coordinates: [longitude, latitude],
  };
}
