import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { vehicle_positions } from "../../db/schema/vehicle-position";

export interface PositionFix {
  vehicleId: number; longitude: number; latitude: number;
  speedKph: number | null; heading: number | null; accuracyM?: number | null;
  recordedAt: Date; receivedAt?: Date; sampleIntervalSeconds?: number | null;
}
export interface PositionSource {
  latest(): Promise<PositionFix[]>;
  record?(fix: PositionFix): Promise<boolean>;
}

/** Latest fixes are shared by API instances and survive process restarts. */
export class DatabasePositionSource implements PositionSource {
  async latest(): Promise<PositionFix[]> {
    return (await db.select().from(vehicle_positions)).map((row) => ({ vehicleId: row.vehicle_id, longitude: row.longitude, latitude: row.latitude,
      speedKph: row.speed_kph, heading: row.heading, accuracyM: row.accuracy_m, recordedAt: row.recorded_at, receivedAt: row.received_at, sampleIntervalSeconds: row.sample_interval_seconds }));
  }
  async record(fix: PositionFix) {
    const changed = await db.insert(vehicle_positions).values({ vehicle_id: fix.vehicleId, longitude: fix.longitude, latitude: fix.latitude,
      speed_kph: fix.speedKph, heading: fix.heading, accuracy_m: fix.accuracyM ?? null, recorded_at: fix.recordedAt, received_at: new Date() })
      .onConflictDoUpdate({ target: vehicle_positions.vehicle_id, set: {
        longitude: fix.longitude, latitude: fix.latitude, speed_kph: fix.speedKph, heading: fix.heading, accuracy_m: fix.accuracyM ?? null,
        sample_interval_seconds: sql`extract(epoch from (${fix.recordedAt.toISOString()}::timestamptz - ${vehicle_positions.recorded_at}))`,
        recorded_at: fix.recordedAt, received_at: new Date(),
      }, setWhere: sql`${vehicle_positions.recorded_at} < ${fix.recordedAt.toISOString()}` }).returning({ id: vehicle_positions.vehicle_id });
    return changed.length > 0;
  }
}
export const positionSource: PositionSource = new DatabasePositionSource();
