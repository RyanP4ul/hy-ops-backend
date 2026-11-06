import postgres from "postgres";
import { socketManager } from "../../ws/socket-manager";
import { UserService } from "../user/service";
import { currentSession } from "../auth/policy";

export type DriverEvent = { eventId: string; driverId: number; deliveryId: number; kind: string };
export async function startDriverEvents(databaseUrl: string) {
  const connection = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  await connection.listen("hyops_driver_changed", async raw => {
    try {
      const event = JSON.parse(raw) as DriverEvent;
      if (!Number.isSafeInteger(event.driverId) || event.driverId <= 0 || !Number.isSafeInteger(event.deliveryId) || event.deliveryId <= 0 || typeof event.eventId !== "string" || !event.eventId || !["assigned", "updated", "removed", "cancelled"].includes(event.kind)) return;
      const actor = await UserService.getMutationActor(event.driverId);
      for (const session of socketManager.getSockets().values()) {
        if (session.user.role === "driver" && Number(session.user.sub) === event.driverId && currentSession(session.user, actor)) {
          // One closed device must not prevent delivery to the driver's other devices.
          try { session.ws.send(JSON.stringify({ type: "DRIVER_ASSIGNMENT_CHANGED", payload: event })); } catch { /* Disconnected device. */ }
        }
      }
    } catch { /* Malformed payloads and unavailable sessions never leak records. */ }
  });
  return { stop: () => connection.end({ timeout: 2 }) };
}
