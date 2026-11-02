import z from "zod";
import { drivers } from "../../../db/schema/users";
import { socketManager } from "../../socket-manager";
import { staffWarehouse } from "../../../modules/deliveries/scope";
import { UserService } from "../../../modules/user/service";
import { currentSession } from "../../../modules/auth/policy";
import { RequestBase, Request } from "../request-base";
import { db } from "../../../db";
import { deliveries } from "../../../db/schema/deliveries";
import { and, eq, inArray } from "drizzle-orm";
import { recordPosition } from "../../../modules/fleet-map/fleet.service";
import { TOPIC } from "../../topic";

// {
//   "delivery_id": "your_delivery_id",
//   "latitude": 14.8451724,
//   "longitude": 120.8796541,
//   "accuracy": 18.19700050354004,
//   "speed": 1.0299409627914429,
//   "heading": 304.7207946777344,
//   "recorded_at": "2026-10-19T05:56:43.935991Z"
// }

@Request("DRIVER_LOCATION_UPDATE")
export class CreateNotificationHandler extends RequestBase<
  typeof CreateNotificationHandler.schema
> {
  static override schema = z.tuple([
    z.string().regex(/^[1-9]\d*$/).nullable(),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(0),
    z.number().min(0),
    z.number().min(0).max(360),
    z.string().datetime(),
  ]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const [
      delivery_id,
      latitude,
      longitude,
      accuracy,
      speed,
      heading,
      recorded_at,
    ] = this.data;

    const actorId = Number(this.session.user.sub);
    const [profile] = await db.select().from(drivers).where(eq(drivers.user_id, actorId));
    if (!profile) throw new Error("Driver profile is unavailable.");
    const timestamp = Date.parse(recorded_at);
    if (timestamp < Date.now() - 60000 || timestamp > Date.now() + 30000) throw new Error("Location timestamp is outside the live window.");
    const [delivery] = await db.select({ id: deliveries.id, vehicle_id: deliveries.vehicle_id }).from(deliveries)
      .where(and(delivery_id === null ? undefined : eq(deliveries.id, Number(delivery_id)), eq(deliveries.driver_id, actorId),
        inArray(deliveries.status, ["in_transit", "returning"]))).limit(1);
    if (delivery_id !== null && !delivery) throw new Error("Location updates require an active delivery assigned to this driver.");
    if (delivery) {
      const result = await recordPosition(delivery.vehicle_id, { latitude, longitude, heading, speedKph: speed * 3.6, accuracyM: accuracy, recordedAt: recorded_at });
      if (!result.accepted) return;
    }
    // Idle fixes are live driver events, never attributed to an unrelated vehicle.
    const event = {
      type: "DRIVER_LOCATION_UPDATE",
      payload: {
        vehicle_id: delivery?.vehicle_id ?? null,
        delivery_id: delivery ? String(delivery.id) : null,
        driver_id: actorId,
        latitude,
        longitude,
        accuracy,
        speed,
        heading,
        recorded_at,
      },
    };
    for (const observer of socketManager.getSockets().values()) {
      if (observer.page !== TOPIC.DASHBOARD && observer.page !== TOPIC.FLEET_MAP) continue;
      if (observer.user.role !== "admin" && observer.user.role !== "staff") continue;
      const actor = await UserService.getMutationActor(Number(observer.user.sub));
      if (!currentSession(observer.user, actor)) continue;
      if (observer.user.role === "staff" && await staffWarehouse(observer.user) !== profile.warehouse_id) continue;
      observer.ws.send(JSON.stringify(event));
    }
  }
}
